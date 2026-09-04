const supabase = require('../config/supabase')
const ipBlacklist = require('../middlewares/ipBlacklist')
const { recordAlert, pushLine } = require('./alertNotifier')

const WINDOW_MS = 5 * 60 * 1000

let configCache = null
let configCachedAt = 0
const CONFIG_CACHE_TTL = 5 * 60 * 1000

// alert_ip_whitelist / alert_ua_whitelist 都是逗號分隔字串（跟其他
// platform_config 的值一樣一律存字串），UA 白名單用「包含」比對
// （子字串，例如 UptimeRobot 的 UA 是 "UptimeRobot/2.0"，不要求整串相等）
const splitList = (s) => (s || '').split(',').map(v => v.trim()).filter(Boolean)

async function getAlertConfig() {
  if (configCache && Date.now() - configCachedAt < CONFIG_CACHE_TTL) return configCache

  const { data } = await supabase.from('platform_config').select('key, value')
  const db = Object.fromEntries((data || []).map(r => [r.key, r.value]))

  configCache = {
    target: db.alert_line_target || process.env.ALERT_LINE_TARGET || '',
    thresholdErrorRate:      Number(db.alert_error_rate_threshold      ?? 20),
    thresholdRequestRate:    Number(db.alert_request_rate_threshold    ?? 0),   // 0 = 停用
    thresholdIpRate:         Number(db.alert_ip_rate_threshold         ?? 0),   // 0 = 停用
    thresholdLatencyMs:      Number(db.alert_latency_threshold         ?? 0),   // 0 = 停用
    thresholdIp4xx:          Number(db.alert_ip_4xx_threshold          ?? 15),  // 0 = 停用
    thresholdPathDivergence: Number(db.alert_path_divergence_threshold ?? 20),  // 0 = 停用
    cooldownMs: Number(db.alert_cooldown_minutes ?? 30) * 60 * 1000,
    // 已知正常自動化來源（uptime monitor、健康檢查、CI…），從所有聚合統計
    // 排除，避免這批規律流量拉高錯誤率／請求量誤觸告警——見資安筆記附錄，
    // 曾經有一次告警就是被混進窗口的 uptime monitor 正常流量誤導
    ipAllowlist: splitList(db.alert_ip_whitelist),
    uaAllowlist: splitList(db.alert_ua_whitelist).map(s => s.toLowerCase()),
  }
  configCachedAt = Date.now()
  return configCache
}

// 各類型獨立冷卻，避免一種告警壓制其他類型；IP 專屬的類型（ip_rate/ip_4xx/
// path_divergence）再用 `${type}:${ip}` 細分 key——舊版只用 type 當 key，
// A IP 剛觸發完告警，B IP 五分鐘內也超標會被同一把冷卻卡住、完全不通知
const lastAlertAt = {}
const canAlert = (key, cooldownMs) => Date.now() - (lastAlertAt[key] || 0) >= cooldownMs
const markAlerted = (key) => { lastAlertAt[key] = Date.now() }

function isAllowlisted(row, config) {
  if (row.ip && config.ipAllowlist.includes(row.ip)) return true
  if (row.user_agent) {
    const ua = row.user_agent.toLowerCase()
    if (config.uaAllowlist.some(needle => ua.includes(needle))) return true
  }
  return false
}

async function autoBlockIp(ip, reasonLabel) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  await supabase.from('ip_blacklist').upsert(
    { ip, reason: `自動封鎖（${reasonLabel}）`, active: true, expires_at: expiresAt, updated_at: new Date().toISOString() },
    { onConflict: 'ip' }
  )
  ipBlacklist.reload()
}

async function runChecks() {
  const config = await getAlertConfig()
  if (!config.target) return

  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!channelAccessToken) return

  const since = new Date(Date.now() - WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('api_log')
    .select('status, latency_ms, ip, method, path, user_agent')
    .gte('created_at', since)

  if (error || !data || data.length === 0) return

  // 白名單來源在這裡整批排除，後面所有統計（錯誤率、請求量、單一 IP
  // 異常……）都只看剩下的流量
  const rows = data.filter(r => !isAllowlisted(r, config))
  if (rows.length === 0) return

  const total = rows.length
  const errorRows = rows.filter(r => r.status >= 400)
  const errors = errorRows.length
  const errorRate = (errors / total) * 100
  const avgLatency = Math.round(rows.reduce((s, r) => s + (r.latency_ms || 0), 0) / total)

  const ipCounts = {}
  const ip4xxCounts = {}
  const ipPaths = {}
  for (const r of rows) {
    if (!r.ip) continue
    ipCounts[r.ip] = (ipCounts[r.ip] || 0) + 1
    if (r.status >= 400) ip4xxCounts[r.ip] = (ip4xxCounts[r.ip] || 0) + 1
    if (!ipPaths[r.ip]) ipPaths[r.ip] = new Set()
    ipPaths[r.ip].add(r.path)
  }
  const topIp = Object.entries(ipCounts).sort((a, b) => b[1] - a[1])[0]

  // 錯誤前三名（依 method + path + status 分組）+ 錯誤最多的 IP
  const errGroups = {}
  const errorIpCounts = {}
  for (const r of errorRows) {
    const key = `${r.method} ${r.path} ${r.status}`
    errGroups[key] = (errGroups[key] || 0) + 1
    if (r.ip) errorIpCounts[r.ip] = (errorIpCounts[r.ip] || 0) + 1
  }
  const top3Errors = Object.entries(errGroups)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => `  ${key}（${count}次）`)
    .join('\n')
  const topErrorIp = Object.entries(errorIpCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null

  const alerts = []

  if (config.thresholdErrorRate > 0 && errorRate >= config.thresholdErrorRate && canAlert('error_rate', config.cooldownMs)) {
    const lines = [`⚠️ [MEDIUM] 錯誤率告警`, `錯誤率：${errorRate.toFixed(1)}%（門檻 ${config.thresholdErrorRate}%）`, `${errors} 錯誤 / ${total} 請求`]
    if (top3Errors) lines.push(`\n前三名：\n${top3Errors}`)
    alerts.push({ type: 'error_rate', severity: 'medium', key: 'error_rate', msg: lines.join('\n'), topErrorIp })
  }

  if (config.thresholdRequestRate > 0 && total >= config.thresholdRequestRate && canAlert('request_rate', config.cooldownMs))
    alerts.push({ type: 'request_rate', severity: 'medium', key: 'request_rate', msg: `🔥 [MEDIUM] 請求量異常\n過去 5 分鐘 ${total} 次請求（門檻 ${config.thresholdRequestRate}）` })

  if (config.thresholdIpRate > 0 && topIp && topIp[1] >= config.thresholdIpRate && canAlert(`ip_rate:${topIp[0]}`, config.cooldownMs)) {
    await autoBlockIp(topIp[0], '單一 IP 請求量異常')
    alerts.push({ type: 'ip_rate', severity: 'high', key: `ip_rate:${topIp[0]}`, ip: topIp[0], msg: `🚨 [HIGH] 單一 IP 異常\n${topIp[0]} 過去 5 分鐘 ${topIp[1]} 次請求（門檻 ${config.thresholdIpRate}）\n已自動封鎖 30 分鐘` })
  }

  // 單一 IP 短時間大量 4xx：典型目錄爆破／掃描特徵。跟上面「單一 IP 請求量
  // 異常」不同——正常流量會把全站錯誤率稀釋掉，單一 IP 自己打出的一堆 4xx
  // 不會被稀釋，門檻要分開才抓得到（筆記第 4 節「聚合訊號」的第一條）
  const topIp4xx = Object.entries(ip4xxCounts).sort((a, b) => b[1] - a[1])[0]
  if (config.thresholdIp4xx > 0 && topIp4xx && topIp4xx[1] >= config.thresholdIp4xx && canAlert(`ip_4xx:${topIp4xx[0]}`, config.cooldownMs)) {
    alerts.push({ type: 'ip_4xx', severity: 'high', key: `ip_4xx:${topIp4xx[0]}`, ip: topIp4xx[0], msg: `🚧 [HIGH] 單一 IP 大量 4xx\n${topIp4xx[0]} 過去 5 分鐘 ${topIp4xx[1]} 次 4xx（門檻 ${config.thresholdIp4xx}）\n疑似目錄爆破／掃描` })
  }

  // 單一 IP 路徑高度發散：掃描器逐一嘗試不同路徑的特徵（筆記第 4 節第二條）
  const pathDivergence = Object.entries(ipPaths).map(([ip, set]) => [ip, set.size]).sort((a, b) => b[1] - a[1])[0]
  if (config.thresholdPathDivergence > 0 && pathDivergence && pathDivergence[1] >= config.thresholdPathDivergence && canAlert(`path_divergence:${pathDivergence[0]}`, config.cooldownMs)) {
    alerts.push({ type: 'path_divergence', severity: 'high', key: `path_divergence:${pathDivergence[0]}`, ip: pathDivergence[0], msg: `🕸️ [HIGH] 單一 IP 路徑高度發散\n${pathDivergence[0]} 過去 5 分鐘嘗試 ${pathDivergence[1]} 個不同路徑（門檻 ${config.thresholdPathDivergence}）\n疑似掃描器逐一探測` })
  }

  if (config.thresholdLatencyMs > 0 && avgLatency >= config.thresholdLatencyMs && canAlert('latency', config.cooldownMs))
    alerts.push({ type: 'latency', severity: 'medium', key: 'latency', msg: `🐢 [MEDIUM] 高延遲告警\n平均延遲 ${avgLatency}ms（門檻 ${config.thresholdLatencyMs}ms）` })

  if (alerts.length === 0) return

  for (const a of alerts) markAlerted(a.key)
  configCache = null

  // 每則告警先落地寫進 security_alert，LINE 推播失敗或被滑掉都還查得到
  await Promise.all(alerts.map(a => recordAlert({ type: a.type, severity: a.severity, message: a.msg, ip: a.ip || null })))

  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })

  // 組合 messages：error_rate 有可疑 IP 時送 Confirm Template，其餘送純文字
  const messages = []
  for (const a of alerts) {
    if (a.type === 'error_rate' && a.topErrorIp) {
      const confirmText = [a.msg, `\n可疑 IP：${a.topErrorIp}`, `是否封鎖？`].join('\n').slice(0, 240)
      messages.push({
        type: 'template',
        altText: `⚠️ 錯誤率告警 — 是否封鎖 ${a.topErrorIp}？`,
        template: {
          type: 'confirm',
          text: confirmText,
          actions: [
            { type: 'postback', label: '否', data: 'action=ignore_alert' },
            { type: 'postback', label: '是', data: `action=block_ip&ip=${a.topErrorIp}` },
          ],
        },
      })
    } else {
      messages.push({ type: 'text', text: a.msg })
    }
  }
  messages.push({ type: 'text', text: `時間：${now}` })

  try {
    await pushLine(messages)
    console.log(`[Alert] 已發送告警: ${alerts.map(a => a.type).join(', ')}`)
  } catch (err) {
    console.error('[Alert] LINE 推播失敗:', err?.response?.data || err.message)
  }
}

async function sendHealthStatus() {
  const config = await getAlertConfig()
  if (!config.target) throw new Error('未設定通知目標')

  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!channelAccessToken) throw new Error('未設定 LINE_CHANNEL_ACCESS_TOKEN')

  const since = new Date(Date.now() - WINDOW_MS).toISOString()
  const { data } = await supabase.from('api_log').select('status, latency_ms, ip, method, path, user_agent').gte('created_at', since)

  // 跟 runChecks() 用同一份白名單排除邏輯，健康度報告才會跟實際告警判斷
  // 看到的數字一致（不然「測試告警」按鈕看到的統計會跟真正觸發時對不上）
  const rows = (data || []).filter(r => !isAllowlisted(r, config))
  const total = rows.length
  const errorRows = rows.filter(r => r.status >= 400)
  const errors = errorRows.length
  const rate = total > 0 ? (errors / total) * 100 : 0
  const avgLatency = total > 0
    ? Math.round(rows.reduce((s, r) => s + (r.latency_ms || 0), 0) / total)
    : 0

  const ipCounts = {}
  for (const r of rows) if (r.ip) ipCounts[r.ip] = (ipCounts[r.ip] || 0) + 1
  const uniqueIPs = Object.keys(ipCounts).length
  const topIp = Object.entries(ipCounts).sort((a, b) => b[1] - a[1])[0]

  const errGroups = {}
  for (const r of errorRows) {
    const key = `${r.method} ${r.path} ${r.status}`
    errGroups[key] = (errGroups[key] || 0) + 1
  }
  const top3 = Object.entries(errGroups)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => `  ${key}（${count}次）`)
    .join('\n')

  const statusLabel = rate === 0 ? '✅ 正常' : rate < config.thresholdErrorRate ? '⚠️ 有少量錯誤' : '🔴 錯誤率過高'

  const lines = [
    `${statusLabel} API 健康度報告`,
    `錯誤率：${rate.toFixed(1)}%（門檻 ${config.thresholdErrorRate}%）`,
    `平均延遲：${avgLatency}ms`,
    `過去 5 分鐘：${errors} 錯誤 / ${total} 請求`,
    uniqueIPs > 0 ? `不重複 IP：${uniqueIPs}，最多 ${topIp?.[0]}（${topIp?.[1]} 次）` : null,
    top3 ? `\n錯誤前三名：\n${top3}` : null,
    `時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`,
  ].filter(Boolean)

  await pushLine([{ type: 'text', text: lines.join('\n') }])
}

function invalidateAlertConfig() {
  configCache = null
  configCachedAt = 0
}

function startAlertMonitor() {
  // 啟動後立刻跑一次，不等 60 秒
  runChecks().catch(err => console.error('[Alert] runChecks error:', err.message))
  setInterval(() => {
    runChecks().catch(err => console.error('[Alert] runChecks error:', err.message))
  }, 60 * 1000)
  console.log('[Alert] Monitor started (60s interval)')
}

module.exports = { startAlertMonitor, sendHealthStatus, invalidateAlertConfig }

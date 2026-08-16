const { messagingApi } = require('@line/bot-sdk')
const supabase = require('../config/supabase')
const ipBlacklist = require('../middlewares/ipBlacklist')

const WINDOW_MS = 5 * 60 * 1000

let configCache = null
let configCachedAt = 0
const CONFIG_CACHE_TTL = 5 * 60 * 1000

async function getAlertConfig() {
  if (configCache && Date.now() - configCachedAt < CONFIG_CACHE_TTL) return configCache

  const { data } = await supabase.from('platform_config').select('key, value')
  const db = Object.fromEntries((data || []).map(r => [r.key, r.value]))

  configCache = {
    target: db.alert_line_target || process.env.ALERT_LINE_TARGET || '',
    thresholdErrorRate:   Number(db.alert_error_rate_threshold   ?? 20),
    thresholdRequestRate: Number(db.alert_request_rate_threshold ?? 0),  // 0 = 停用
    thresholdIpRate:      Number(db.alert_ip_rate_threshold      ?? 0),  // 0 = 停用
    thresholdLatencyMs:   Number(db.alert_latency_threshold      ?? 0),  // 0 = 停用
    cooldownMs: Number(db.alert_cooldown_minutes ?? 30) * 60 * 1000,
  }
  configCachedAt = Date.now()
  return configCache
}

// 各類型獨立冷卻，避免一種告警壓制其他類型
const lastAlertAt = { error_rate: 0, request_rate: 0, ip_rate: 0, latency: 0 }
const canAlert = (type, cooldownMs) => Date.now() - lastAlertAt[type] >= cooldownMs

async function runChecks() {
  const config = await getAlertConfig()
  if (!config.target) return

  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!channelAccessToken) return

  const since = new Date(Date.now() - WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('api_log')
    .select('status, latency_ms, ip, method, path')
    .gte('created_at', since)

  if (error || !data || data.length === 0) return

  const total = data.length
  const errorRows = data.filter(r => r.status >= 400)
  const errors = errorRows.length
  const errorRate = (errors / total) * 100
  const avgLatency = Math.round(data.reduce((s, r) => s + (r.latency_ms || 0), 0) / total)

  const ipCounts = {}
  for (const r of data) if (r.ip) ipCounts[r.ip] = (ipCounts[r.ip] || 0) + 1
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
    const lines = [`⚠️ 錯誤率告警`, `錯誤率：${errorRate.toFixed(1)}%（門檻 ${config.thresholdErrorRate}%）`, `${errors} 錯誤 / ${total} 請求`]
    if (top3Errors) lines.push(`\n前三名：\n${top3Errors}`)
    alerts.push({ type: 'error_rate', msg: lines.join('\n'), topErrorIp })
  }

  if (config.thresholdRequestRate > 0 && total >= config.thresholdRequestRate && canAlert('request_rate', config.cooldownMs))
    alerts.push({ type: 'request_rate', msg: `🔥 請求量異常\n過去 5 分鐘 ${total} 次請求（門檻 ${config.thresholdRequestRate}）` })

  if (config.thresholdIpRate > 0 && topIp && topIp[1] >= config.thresholdIpRate && canAlert('ip_rate', config.cooldownMs)) {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    await supabase.from('ip_blacklist').upsert(
      { ip: topIp[0], reason: '自動封鎖（單一 IP 請求量異常）', active: true, expires_at: expiresAt, updated_at: new Date().toISOString() },
      { onConflict: 'ip' }
    )
    ipBlacklist.reload()
    alerts.push({ type: 'ip_rate', msg: `🚨 單一 IP 異常\n${topIp[0]} 過去 5 分鐘 ${topIp[1]} 次請求（門檻 ${config.thresholdIpRate}）\n已自動封鎖 30 分鐘` })
  }

  if (config.thresholdLatencyMs > 0 && avgLatency >= config.thresholdLatencyMs && canAlert('latency', config.cooldownMs))
    alerts.push({ type: 'latency', msg: `🐢 高延遲告警\n平均延遲 ${avgLatency}ms（門檻 ${config.thresholdLatencyMs}ms）` })

  if (alerts.length === 0) return

  for (const a of alerts) lastAlertAt[a.type] = Date.now()
  configCache = null

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
    const client = new messagingApi.MessagingApiClient({ channelAccessToken })
    await client.pushMessage({ to: config.target, messages })
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
  const { data } = await supabase.from('api_log').select('status, latency_ms, ip, method, path').gte('created_at', since)

  const rows = data || []
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

  const client = new messagingApi.MessagingApiClient({ channelAccessToken })
  await client.pushMessage({ to: config.target, messages: [{ type: 'text', text: lines.join('\n') }] })
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

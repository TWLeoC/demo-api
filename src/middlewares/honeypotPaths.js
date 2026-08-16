const supabase = require('../config/supabase')
const ipBlacklist = require('./ipBlacklist')

// 這個 app 是 Node/Express + React SPA，絕對不會有這些路徑對應到真正的路由——
// 一次命中就已經是掃描器/攻擊工具在探測，不用等累積到門檻，也不用等
// alertService.js 每 60 秒的批次掃描，第一次打中就立刻封鎖，零誤判風險
// （2026-07-30 兩次掃描事件：現有機制要等到掃描快結束才觸發，反應太慢）
const HONEYPOT_RE = /(^|\/)\.(aws|awsvault|git|ssh|env|docker|kube|npmrc|netrc|saml2aws|htpasswd)($|\/|\.)|wp-admin|wp-login|phpmyadmin|id_rsa|credentials\.(json|ya?ml|txt|bak)/i

const honeypotPaths = async (req, res, next) => {
  if (!HONEYPOT_RE.test(req.path)) return next()

  const start = Date.now()
  const ip = req.ip
  res.status(403).json({ error: 'Forbidden' })

  // 這個 middleware 掛在 apiLogger 前面、攔到就直接回應不會呼叫 next()，
  // 所以 apiLogger 永遠不會跑到——這裡要自己補寫一筆，不然 平台監控
  // 頁面完全看不到這些其實已經被擋下的請求，商家會誤以為系統沒發現任何動靜
  // （apiLogger.js 自己那份 SCAN_PREFIXES 清單是刻意不記錄「純噪音、沒被擋下」
  // 的掃描，跟這裡「已經主動攔截處理」的情境目的不同，不能沿用同一份判斷）
  supabase.from('api_log').insert({
    store_id: req.storeId || null,
    method: req.method,
    path: req.path,
    status: 403,
    latency_ms: Date.now() - start,
    ip: ip || null,
  }).then(() => {}).catch(() => {})

  if (!ip) return

  console.warn(`[Honeypot] 命中警戒路徑，立即封鎖：${ip} ${req.method} ${req.path}`)

  try {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    await supabase.from('ip_blacklist').upsert(
      { ip, reason: `自動封鎖（命中警戒路徑 ${req.path}）`, active: true, expires_at: expiresAt, updated_at: new Date().toISOString() },
      { onConflict: 'ip' }
    )
    ipBlacklist.reload()
  } catch (err) {
    console.error('[Honeypot] 寫入黑名單失敗:', err.message)
  }

  try {
    const { data } = await supabase.from('platform_config').select('value').eq('key', 'alert_line_target').maybeSingle()
    const target = data?.value
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
    if (!target || !channelAccessToken) return

    const { messagingApi } = require('@line/bot-sdk')
    const client = new messagingApi.MessagingApiClient({ channelAccessToken })
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
    await client.pushMessage({
      to: target,
      messages: [{ type: 'text', text: `🍯 命中警戒路徑，已即時封鎖\nIP：${ip}\n路徑：${req.method} ${req.path}\n時間：${now}` }],
    })
  } catch (err) {
    console.error('[Honeypot] LINE 推播失敗:', err.message)
  }
}

module.exports = honeypotPaths

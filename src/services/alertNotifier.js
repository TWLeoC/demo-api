const supabase = require('../config/supabase')

// honeypotPaths.js（單筆高訊號事件）跟 alertService.js（窗口聚合告警）都要
// 「送 LINE + 落地紀錄」，統一放這裡——舊版兩邊各自兜一份 LINE client 邏輯，
// alertService 那份甚至完全沒有落地紀錄，只靠 LINE 推播，一旦推播失敗或
// 訊息被滑掉就完全查不到，無法事後稽核。

async function getLineTarget() {
  const { data } = await supabase
    .from('platform_config')
    .select('value')
    .eq('key', 'alert_line_target')
    .maybeSingle()
  return data?.value || process.env.ALERT_LINE_TARGET || ''
}

async function recordAlert({ type, severity = 'medium', message, ip = null }) {
  await supabase.from('security_alert').insert({ type, severity, message, ip }).then(() => {}).catch(() => {})
}

async function pushLine(messages) {
  const target = await getLineTarget()
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!target || !channelAccessToken) return false

  const { messagingApi } = require('@line/bot-sdk')
  const client = new messagingApi.MessagingApiClient({ channelAccessToken })
  await client.pushMessage({ to: target, messages })
  return true
}

// 單一事件型告警（honeypot 命中）：落地 + 推播一次做完，推播失敗不影響落地
async function fireAlert({ type, severity = 'high', message, ip = null }) {
  await recordAlert({ type, severity, message, ip })
  try {
    await pushLine([{ type: 'text', text: message }])
  } catch (err) {
    console.error(`[Alert] LINE 推播失敗 (${type}):`, err?.response?.data || err.message)
  }
}

module.exports = { getLineTarget, recordAlert, pushLine, fireAlert }

const { messagingApi } = require('@line/bot-sdk')
const supabase = require('../config/supabase')
const { restoreOrderStock } = require('../controllers/orderController')

// payment_deadline_at 只有檔期預購商品（有設定 payment_deadline_days）才會有值，
// 一般商品訂單這欄位永遠是 null，不會被這裡影響到。過去這欄位「純提醒不自動
// 取消」，商家反映希望真的逾期自動取消，改成排程掃描處理
async function cancelExpiredOrders() {
  const now = new Date().toISOString()
  const { data: orders, error } = await supabase
    .from('order')
    .select('id, display_id, store_id, total_price')
    .lt('payment_deadline_at', now)
    .eq('is_paid', false)
    .eq('is_cancelled', false)

  if (error || !orders?.length) return

  for (const order of orders) {
    const { error: updErr } = await supabase
      .from('order')
      .update({ is_cancelled: true, cancelled_at: new Date().toISOString() })
      .eq('id', order.id)
    if (updErr) {
      console.error(`[OrderExpiry] 取消訂單失敗 ${order.display_id}:`, updErr.message)
      continue
    }
    await restoreOrderStock(order.id).catch(err => console.error(`[OrderExpiry] 回補庫存失敗 ${order.display_id}:`, err.message))
    console.log(`[OrderExpiry] 逾期未付款，自動取消訂單：${order.display_id}`)
    await notifyStore(order).catch(err => console.error('[OrderExpiry] LINE 推播失敗:', err.message))
  }
}

async function notifyStore(order) {
  const { data: store } = await supabase
    .from('store')
    .select('line_notify_target, line_channel_access_token')
    .eq('id', order.store_id)
    .single()

  const target = store?.line_notify_target
  const channelAccessToken = store?.line_channel_access_token || process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!target || !channelAccessToken) return

  const client = new messagingApi.MessagingApiClient({ channelAccessToken })
  await client.pushMessage({
    to: target,
    messages: [{ type: 'text', text: `⏰ 訂單 ${order.display_id} 逾期未付款（NT$${order.total_price}），已自動取消` }],
  })
}

function startOrderExpiryMonitor() {
  cancelExpiredOrders().catch(err => console.error('[OrderExpiry] cancelExpiredOrders error:', err.message))
  setInterval(() => {
    cancelExpiredOrders().catch(err => console.error('[OrderExpiry] cancelExpiredOrders error:', err.message))
  }, 5 * 60 * 1000)
  console.log('[OrderExpiry] Monitor started (5min interval)')
}

module.exports = { startOrderExpiryMonitor, cancelExpiredOrders }

const router = require('express').Router()
const crypto = require('crypto')
const express = require('express')
const { messagingApi } = require('@line/bot-sdk')
const supabase = require('../config/supabase')
const ipBlacklist = require('../middlewares/ipBlacklist')
const { pushCustomerNotification } = require('../services/lineService')

// ─── Webhook routes ───────────────────────────────────────────────────────────

// 平台統一 LINE Bot（全域 secret）
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    res.sendStatus(200)
    const rawBody = req.body
    const signature = req.headers['x-line-signature']
    if (!signature || !rawBody?.length) return

    const channelSecret = process.env.LINE_CHANNEL_SECRET
    if (!channelSecret) { console.error('[LINE] LINE_CHANNEL_SECRET not set'); return }

    const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64')
    if (expected !== signature) { console.warn('[LINE] signature mismatch'); return }

    console.log('[LINE] webhook received, bodyLen:', rawBody.length)
    await handleEvents(JSON.parse(rawBody.toString()), process.env.LINE_CHANNEL_ACCESS_TOKEN)
  }
)

// 商家自訂 LINE Bot（per-store secret，fallback 到全域）
router.post('/webhook/:storeId',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    res.sendStatus(200)
    const rawBody = req.body
    const signature = req.headers['x-line-signature']
    if (!signature || !rawBody?.length) return

    const { data: store } = await supabase
      .from('store')
      .select('line_channel_secret, line_channel_access_token')
      .eq('id', req.params.storeId)
      .single()

    const channelSecret = store?.line_channel_secret || process.env.LINE_CHANNEL_SECRET
    if (!channelSecret) { console.error('[LINE] no secret for store', req.params.storeId); return }

    const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64')
    if (expected !== signature) { console.warn('[LINE] signature mismatch store:', req.params.storeId); return }

    console.log('[LINE] webhook received store:', req.params.storeId, 'bodyLen:', rawBody.length)
    const channelToken = store?.line_channel_access_token || process.env.LINE_CHANNEL_ACCESS_TOKEN
    await handleEvents(JSON.parse(rawBody.toString()), channelToken)
  }
)

// ─── Event loop ───────────────────────────────────────────────────────────────

async function handleEvents(body, channelToken) {
  for (const event of body.events || []) {
    // postback 必須在 message 過濾前處理
    if (event.type === 'postback') {
      await handlePostback(event, channelToken).catch(err =>
        console.error('[LINE] postback error:', err.message)
      )
      continue
    }

    if (event.type !== 'message' || event.message?.type !== 'text') continue

    const text = event.message.text?.trim()
    const sourceId = event.source?.groupId || event.source?.roomId || event.source?.userId

    console.log('[LINE] event source:', event.source?.type, sourceId, '| text:', text?.slice(0, 30))

    if (!text || !sourceId) continue

    if (text.startsWith('/')) {
      await handleCommand({ text, sourceId, replyToken: event.replyToken, channelToken }).catch(err =>
        console.error('[LINE] handleCommand error:', err.message)
      )
      continue
    }

    // Rush 等待輸入分鐘數
    const { data: rushPendingStore } = await supabase
      .from('store')
      .select('id')
      .eq('line_notify_target', sourceId)
      .eq('rush_pending', true)
      .single()

    if (rushPendingStore) {
      const minutes = parseInt(text, 10)
      if (!isNaN(minutes) && minutes > 0 && minutes <= 1440) {
        const rushUntil = new Date(Date.now() + minutes * 60 * 1000)
        await supabase.from('store').update({
          rush_until: rushUntil.toISOString(),
          rush_pending: false,
        }).eq('id', rushPendingStore.id)
        const hhmm = rushUntil.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' })
        await reply(event.replyToken, `🔴 已暫停線上點餐 ${minutes} 分鐘\n預計 ${hhmm} 自動恢復\n輸入 /恢復 可提早結束`, channelToken)
        console.log(`[LINE] RUSH activated store=${rushPendingStore.id} until=${rushUntil.toISOString()}`)
      } else {
        await reply(event.replyToken, '請輸入 1~1440 之間的整數分鐘數，例如：60', channelToken)
      }
      continue
    }

    // 設定碼配對：若訊息內容等於某店的 webhook_token，自動連結
    const { data: storeByToken } = await supabase
      .from('store')
      .select('id, line_notify_target')
      .eq('webhook_token', text)
      .single()

    if (storeByToken && !storeByToken.line_notify_target) {
      await supabase.from('store').update({ line_notify_target: sourceId }).eq('id', storeByToken.id)
      console.log('[LINE] Store linked:', storeByToken.id, '→', sourceId)
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function reply(replyToken, text, channelToken) {
  const token = channelToken || process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return
  const client = new messagingApi.MessagingApiClient({ channelAccessToken: token })
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] })
}

async function handleCommand({ text, sourceId, replyToken, channelToken }) {
  const { data: store } = await supabase
    .from('store')
    .select('id, name')
    .eq('line_notify_target', sourceId)
    .single()

  if (!store) return

  const [cmd, ...args] = text.split(/\s+/)
  const arg = args.join(' ').trim()

  switch (cmd) {
    case '/商品':     return replyProductList(store, true,  replyToken, channelToken)
    case '/下架商品': return replyProductList(store, false, replyToken, channelToken)
    case '/上架':     return toggleProduct(store, arg, true,  replyToken, channelToken)
    case '/下架':     return toggleProduct(store, arg, false, replyToken, channelToken)
    case '/rush':     return startRush(store, replyToken, channelToken)
    case '/恢復':     return endRush(store, replyToken, channelToken)
    case '/出攤':       return openStore(store, replyToken, channelToken)
    case '/收攤':       return closeStore(store, replyToken, channelToken)
    case '/今日報表':   return replyDailyReport(store, replyToken, channelToken)
    // 未知指令靜默忽略
  }
}

async function replyProductList(store, isEnable, replyToken, channelToken) {
  const { data } = await supabase
    .from('product')
    .select('id, name, price')
    .eq('store_id', store.id)
    .eq('is_enable', isEnable)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })

  const label = isEnable ? '上架中' : '下架中'
  const hint  = isEnable ? '/下架 [編號或名稱]' : '/上架 [編號或名稱]'

  if (!data || data.length === 0) {
    return reply(replyToken, `目前沒有${label}的商品`, channelToken)
  }

  const lines = [`📋 ${label}（${data.length}）`]
  data.forEach((p, i) => lines.push(`${i + 1}. ${p.name} $${p.price}`))
  lines.push(`\n輸入 ${hint}`)

  return reply(replyToken, lines.join('\n'), channelToken)
}

async function toggleProduct(store, arg, enable, replyToken, channelToken) {
  if (!arg) {
    return reply(replyToken, `請輸入商品編號或名稱，例如：${enable ? '/上架 1' : '/下架 1'}`, channelToken)
  }

  const { data: products } = await supabase
    .from('product')
    .select('id, name')
    .eq('store_id', store.id)
    .eq('is_enable', !enable)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })

  if (!products || products.length === 0) {
    return reply(replyToken, `目前沒有可${enable ? '上架' : '下架'}的商品`, channelToken)
  }

  let target = null
  const num = parseInt(arg, 10)
  if (!isNaN(num) && num >= 1 && num <= products.length) {
    target = products[num - 1]
  } else {
    const lower = arg.toLowerCase()
    target = products.find(p => p.name.toLowerCase().includes(lower))
    if (!target) {
      return reply(replyToken, `找不到「${arg}」，輸入 ${enable ? '/下架商品' : '/商品'} 查看列表`, channelToken)
    }
  }

  const { error } = await supabase
    .from('product')
    .update({ is_enable: enable, updated_at: new Date().toISOString() })
    .eq('id', target.id)

  if (error) {
    console.error('[LINE] toggleProduct error:', error.message)
    return reply(replyToken, '操作失敗，請稍後再試', channelToken)
  }

  const action = enable ? '上架' : '下架'
  console.log(`[LINE] ${action}商品：${target.name}（store: ${store.id}）`)
  return reply(replyToken, `✅ 已${action}「${target.name}」`, channelToken)
}

async function handlePostback(event, channelToken) {
  const params = new URLSearchParams(event.postback?.data || '')
  const action = params.get('action')

  if (action === 'block_ip') {
    const ip = params.get('ip')
    if (!ip) return
    const { error } = await supabase
      .from('ip_blacklist')
      .upsert(
        { ip, reason: '管理員確認封鎖（LINE 告警）', active: true, updated_at: new Date().toISOString() },
        { onConflict: 'ip' }
      )
    if (error) { await reply(event.replyToken, `❌ 封鎖失敗：${error.message}`, channelToken); return }
    ipBlacklist.reload()
    console.log(`[LINE] IP 封鎖：${ip}（管理員確認）`)
    await reply(event.replyToken, `✅ 已封鎖 IP：${ip}`, channelToken)

  } else if (action === 'ignore_alert') {
    await reply(event.replyToken, '已略過此告警', channelToken)

  } else if (action === 'confirm_order') {
    const orderId   = params.get('order_id')
    const displayId = params.get('display_id') || orderId
    if (!orderId) return

    const sourceId = event.source?.groupId || event.source?.userId
    const { data: store } = await supabase
      .from('store')
      .select('id, name')
      .eq('line_notify_target', sourceId)
      .single()
    if (!store) return

    const { data: order } = await supabase
      .from('order')
      .select('id, display_id, total_price, is_confirmed, is_cancelled, user:user_id(line_id)')
      .eq('id', orderId)
      .eq('store_id', store.id)
      .single()
    if (!order) { await reply(event.replyToken, '❌ 找不到此訂單', channelToken); return }
    if (order.is_cancelled) { await reply(event.replyToken, `訂單 ${displayId} 已取消`, channelToken); return }
    if (order.is_confirmed) { await reply(event.replyToken, `訂單 ${displayId} 已確認接單`, channelToken); return }

    const { error } = await supabase.from('order')
      .update({ is_confirmed: true, confirmed_at: new Date().toISOString() })
      .eq('id', orderId)
    if (error) { await reply(event.replyToken, `❌ 操作失敗：${error.message}`, channelToken); return }

    const customerLineId = order.user?.line_id
    if (customerLineId) {
      pushCustomerNotification(store.id, customerLineId,
        `✅ ${store.name} 已確認您的訂單！\n訂單編號：${order.display_id}\n金額：NT$${order.total_price}`)
    }

    console.log(`[LINE] 確認接單：${displayId}`)
    await reply(event.replyToken, `📋 已確認接單：訂單 ${displayId}`, channelToken)

  } else if (action === 'confirm_payment' || action === 'confirm_ship') {
    const orderId   = params.get('order_id')
    const displayId = params.get('display_id') || orderId
    if (!orderId) return

    const sourceId = event.source?.groupId || event.source?.userId
    const { data: store } = await supabase
      .from('store')
      .select('id')
      .eq('line_notify_target', sourceId)
      .single()
    if (!store) return

    const isPayment = action === 'confirm_payment'
    const field = isPayment ? 'is_paid' : 'is_ship'
    const label = isPayment ? '付款' : '出貨'

    const { data: order } = await supabase
      .from('order')
      .select(`id, ${field}`)
      .eq('id', orderId)
      .eq('store_id', store.id)
      .single()
    if (!order) { await reply(event.replyToken, '❌ 找不到此訂單', channelToken); return }
    if (order[field]) { await reply(event.replyToken, `訂單 ${displayId} 已確認${label}`, channelToken); return }

    const update = isPayment
      ? { is_paid: true, paid_at: new Date().toISOString() }
      : { is_ship: true, updated_at: new Date().toISOString() }

    const { error } = await supabase.from('order').update(update).eq('id', orderId)
    if (error) { await reply(event.replyToken, `❌ 操作失敗：${error.message}`, channelToken); return }

    const emoji = isPayment ? '✅' : '📦'
    console.log(`[LINE] 訂單${label}：${displayId}`)
    await reply(event.replyToken, `${emoji} 已確認${label}：訂單 ${displayId}`, channelToken)
  }
}

async function replyDailyReport(store, replyToken, channelToken) {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const dateStr = now.toISOString().split('T')[0]
  const start = new Date(`${dateStr}T00:00:00+08:00`).toISOString()
  const end   = new Date(`${dateStr}T23:59:59+08:00`).toISOString()

  const { data: orders } = await supabase
    .from('order')
    .select('order_item(product_name, product_price, quantity, order_item_addon(addon_price))')
    .eq('store_id', store.id)
    .eq('is_cancelled', false)
    .eq('is_test', false)
    .gte('created_at', start)
    .lte('created_at', end)

  const [y, m, d] = dateStr.split('-')
  const label = `${y}/${m}/${d}`

  if (!orders || orders.length === 0) {
    return reply(replyToken, `📊 ${label} 日報表\n\n今日尚無訂單`, channelToken)
  }

  const productMap = {}
  let addonTotal = 0
  for (const order of orders) {
    for (const item of order.order_item || []) {
      if (!productMap[item.product_name]) productMap[item.product_name] = { quantity: 0, total: 0 }
      productMap[item.product_name].quantity += item.quantity
      productMap[item.product_name].total   += item.product_price * item.quantity
      for (const addon of item.order_item_addon || []) {
        addonTotal += addon.addon_price * item.quantity
      }
    }
  }

  const lines = [`📊 ${label} 日報表`, '']
  let grandTotal = 0
  for (const [name, v] of Object.entries(productMap)) {
    lines.push(`${name} x${v.quantity}　$${v.total}`)
    grandTotal += v.total
  }
  if (addonTotal > 0) {
    lines.push(`加購　$${addonTotal}`)
    grandTotal += addonTotal
  }
  lines.push('─────────────────')
  lines.push(`總計（${orders.length}筆）　$${grandTotal}`)

  return reply(replyToken, lines.join('\n'), channelToken)
}

async function openStore(store, replyToken, channelToken) {
  await supabase.from('store').update({ is_open: true }).eq('id', store.id)
  return reply(replyToken, '✅ 已出攤，開放線上點餐！', channelToken)
}

async function closeStore(store, replyToken, channelToken) {
  await supabase.from('store').update({ is_open: false }).eq('id', store.id)
  return reply(replyToken, '🔴 已收攤，停止線上點餐', channelToken)
}

async function startRush(store, replyToken, channelToken) {
  await supabase.from('store').update({ rush_pending: true, rush_until: null }).eq('id', store.id)
  return reply(replyToken, '⏸️ 要暫停多少分鐘？\n請直接回覆數字，例如：60', channelToken)
}

async function endRush(store, replyToken, channelToken) {
  await supabase.from('store').update({ rush_pending: false, rush_until: null }).eq('id', store.id)
  console.log(`[LINE] RUSH manually ended store=${store.id}`)
  return reply(replyToken, '✅ 已恢復線上點餐', channelToken)
}

// Called by store-info route when rush_until has expired
async function sendRushEndedNotification(storeId) {
  const { data: store } = await supabase
    .from('store')
    .select('line_notify_target, line_channel_access_token')
    .eq('id', storeId)
    .single()

  if (!store?.line_notify_target) return

  const channelToken = store.line_channel_access_token || process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!channelToken) return

  const client = new messagingApi.MessagingApiClient({ channelAccessToken: channelToken })
  await client.pushMessage({
    to: store.line_notify_target,
    messages: [{ type: 'text', text: '✅ RUSH 結束，已開放線上點餐' }],
  }).catch(err => console.error('[LINE] sendRushEndedNotification error:', err.message))
}

module.exports = router
module.exports.sendRushEndedNotification = sendRushEndedNotification

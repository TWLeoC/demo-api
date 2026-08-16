const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const server = require('./helpers/server')
const config = require('./helpers/config')
const { signMerchantToken } = require('./helpers/auth')
const supabase = require('./helpers/db')

let baseUrl, token, slotId, orderId

before(async () => {
  baseUrl = await server.start()
  token = signMerchantToken()

  // 測試帳號的購物車也會被拿去手動測試（同一組測試商家 + 測試 MERCHANT），
  // 不能假設一開始就是空的，不清空的話「混單」防呆會擋下這個測試
  const { data: existingCart } = await supabase
    .from('cart')
    .select('id')
    .eq('user_id', config.TEST_ADMIN_USER_ID)
    .eq('store_id', config.TEST_STORE_ID)
    .maybeSingle()
  if (existingCart) await supabase.from('cart_item').delete().eq('cart_id', existingCart.id)

  // 自己建一個未來日期的取餐時段，不依賴既有 fixture（日期會過期）
  const futureDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { data: slot, error: slotErr } = await supabase
    .from('pickup_slot')
    .insert({ store_id: config.TEST_STORE_ID, date: futureDate, start_time: '10:00:00', end_time: '12:00:00' })
    .select('id')
    .single()
  if (slotErr) throw slotErr
  slotId = slot.id
})

after(async () => {
  if (orderId) {
    await supabase.from('order_item').delete().eq('order_id', orderId)
    await supabase.from('order').delete().eq('id', orderId)
  }
  if (slotId) await supabase.from('pickup_slot').delete().eq('id', slotId)
  await server.stop()
})

test('加入購物車 → 建立訂單', async () => {
  const { data: product, error: productErr } = await supabase
    .from('product')
    .select('id')
    .eq('store_id', config.TEST_STORE_ID)
    .is('campaign_id', null)
    .eq('is_enable', true)
    .limit(1)
    .single()
  if (productErr) throw productErr

  const addRes = await fetch(`${baseUrl}/api/cart/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ product_id: product.id, quantity: 2 }),
  })
  const addBody = await addRes.json()
  assert.equal(addRes.status, 201, JSON.stringify(addBody))

  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ pickup_slot_id: slotId, pickup_time: '10:00:00', payment_method_id: 1 }),
  })
  const orderBody = await orderRes.json()
  // 先記下 order_id 再斷言，避免斷言失敗時這筆訂單沒被 after() 清理掉
  orderId = orderBody.data?.order_id
  assert.equal(orderRes.status, 201, JSON.stringify(orderBody))
  assert.ok(orderBody.data.order_id)

  const { data: order, error: orderErr } = await supabase
    .from('order')
    .select('id, pickup_date, pickup_time, is_paid')
    .eq('id', orderId)
    .single()
  if (orderErr) throw orderErr
  assert.equal(order.is_paid, false)
  assert.equal(order.pickup_time.slice(0, 5), '10:00')
})

// 迴歸測試：2026-08 發現有訂單下單時間晚於取餐時間——前端只在載入時段列表當下
// 把過去的時間濾掉，顧客選完到送出訂單之間停留幾分鐘，如果選到當天最後一個時段，
// 送出當下時段可能已經過了，後端過去沒有再驗證一次，照樣接受
test('今天的取餐時段如果已經過了，建立訂單要被擋下來', async () => {
  const { data: product, error: productErr } = await supabase
    .from('product')
    .select('id')
    .eq('store_id', config.TEST_STORE_ID)
    .is('campaign_id', null)
    .eq('is_enable', true)
    .limit(1)
    .single()
  if (productErr) throw productErr

  // 台灣時間「今天」，時段開始/結束都設在 5 分鐘前，確保已經過去
  const nowTaipei = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const todayTaipei = nowTaipei.toISOString().slice(0, 10)
  const pad = n => String(n).padStart(2, '0')
  const past = new Date(nowTaipei.getTime() - 5 * 60 * 1000)
  const startTime = `${pad(past.getUTCHours())}:${pad(past.getUTCMinutes())}:00`
  const future = new Date(nowTaipei.getTime() + 2 * 60 * 1000)
  const endTime = `${pad(future.getUTCHours())}:${pad(future.getUTCMinutes())}:00`

  const { data: pastSlot, error: pastSlotErr } = await supabase
    .from('pickup_slot')
    .insert({ store_id: config.TEST_STORE_ID, date: todayTaipei, start_time: startTime, end_time: endTime })
    .select('id')
    .single()
  if (pastSlotErr) throw pastSlotErr

  try {
    const addRes = await fetch(`${baseUrl}/api/cart/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ product_id: product.id, quantity: 1 }),
    })
    assert.equal(addRes.status, 201)

    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pickup_slot_id: pastSlot.id, pickup_time: startTime, payment_method_id: 1 }),
    })
    const orderBody = await orderRes.json()
    assert.equal(orderRes.status, 400, JSON.stringify(orderBody))
    assert.match(orderBody.message, /已過/)
  } finally {
    const { data: cart } = await supabase.from('cart').select('id').eq('user_id', config.TEST_ADMIN_USER_ID).eq('store_id', config.TEST_STORE_ID).maybeSingle()
    if (cart) await supabase.from('cart_item').delete().eq('cart_id', cart.id)
    await supabase.from('pickup_slot').delete().eq('id', pastSlot.id)
  }
})

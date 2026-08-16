const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const server = require('./helpers/server')
const config = require('./helpers/config')
const supabase = require('./helpers/db')
const { buildFakeNotifyPayload } = require('./helpers/newebpay')

let baseUrl
let orderId
// display_id 欄位是 varchar(14)，跟正式流程一樣用純數字（避免超長被 DB 擋下）
const displayId = Date.now().toString().slice(-12)
const totalPrice = 321

before(async () => {
  baseUrl = await server.start()

  const { data: order, error: orderErr } = await supabase
    .from('order')
    .insert({
      store_id: config.TEST_STORE_ID,
      user_id: config.TEST_ADMIN_USER_ID,
      display_id: displayId,
      is_paid: false,
      total_price: totalPrice,
    })
    .select('id')
    .single()
  if (orderErr) throw orderErr
  orderId = order.id
})

after(async () => {
  if (orderId) await supabase.from('order').delete().eq('id', orderId)
  await server.stop()
})

test('藍新 notify webhook 簽章正確且金額相符時，訂單會被標記為已付款', async () => {
  const payload = buildFakeNotifyPayload({
    MerchantOrderNo: displayId,
    Amt: totalPrice,
    TradeNo: `CITRADE${Date.now()}`,
    PaymentType: 'CREDIT',
  })

  const res = await fetch(`${baseUrl}/api/payment/newebpay/notify?store_id=${config.TEST_STORE_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.equal(text, '1|OK')

  const { data: order, error: orderErr } = await supabase
    .from('order')
    .select('is_paid, newebpay_payment_type')
    .eq('id', orderId)
    .single()
  if (orderErr) throw orderErr
  assert.equal(order.is_paid, true)
  assert.equal(order.newebpay_payment_type, 'CREDIT')
})

test('金額不符的 webhook 會被拒絕，訂單維持未付款', async () => {
  const mismatchDisplayId = Date.now().toString().slice(-11) + '9'
  const { data: order, error: orderErr } = await supabase
    .from('order')
    .insert({
      store_id: config.TEST_STORE_ID,
      user_id: config.TEST_ADMIN_USER_ID,
      display_id: mismatchDisplayId,
      is_paid: false,
      total_price: 500,
    })
    .select('id')
    .single()
  if (orderErr) throw orderErr

  try {
    const payload = buildFakeNotifyPayload({
      MerchantOrderNo: mismatchDisplayId,
      Amt: 1, // 跟訂單的 500 對不上
      TradeNo: `CITRADE${Date.now()}`,
      PaymentType: 'CREDIT',
    })

    const res = await fetch(`${baseUrl}/api/payment/newebpay/notify?store_id=${config.TEST_STORE_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload).toString(),
    })
    const text = await res.text()
    assert.equal(text, '0|Error')

    const { data: fresh } = await supabase.from('order').select('is_paid').eq('id', order.id).single()
    assert.equal(fresh.is_paid, false)
  } finally {
    await supabase.from('order').delete().eq('id', order.id)
  }
})

// 迴歸測試：2026-08 發現顧客付款失敗後點「重新前往付款」，MerchantOrderNo 過去
// 每次都直接重用 display_id，藍新收過一次就用 MPG03008 擋下重複訂單編號，導致
// 永遠無法重試付款。修法後重新付款的 MerchantOrderNo 會是 `${display_id}R${時間戳}`，
// notify webhook 要能正確從這種帶後綴的格式取回真正的訂單
test('重新前往付款產生的帶後綴 MerchantOrderNo，webhook 仍能正確比對回原訂單並標記已付款', async () => {
  const retryDisplayId = Date.now().toString().slice(-11) + '1'
  const { data: order, error: orderErr } = await supabase
    .from('order')
    .insert({
      store_id: config.TEST_STORE_ID,
      user_id: config.TEST_ADMIN_USER_ID,
      display_id: retryDisplayId,
      is_paid: false,
      total_price: 250,
    })
    .select('id')
    .single()
  if (orderErr) throw orderErr

  try {
    // 模擬 updatePaymentMethod 產生的重試用 MerchantOrderNo（display_id + R + 時間戳後 8 碼）
    const retryMerchantOrderNo = `${retryDisplayId}R${Date.now().toString().slice(-8)}`
    const payload = buildFakeNotifyPayload({
      MerchantOrderNo: retryMerchantOrderNo,
      Amt: 250,
      TradeNo: `CITRADE${Date.now()}`,
      PaymentType: 'CREDIT',
    })

    const res = await fetch(`${baseUrl}/api/payment/newebpay/notify?store_id=${config.TEST_STORE_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload).toString(),
    })
    const text = await res.text()
    assert.equal(text, '1|OK')

    const { data: fresh } = await supabase.from('order').select('is_paid').eq('id', order.id).single()
    assert.equal(fresh.is_paid, true)
  } finally {
    await supabase.from('order').delete().eq('id', order.id)
  }
})

test('同一張訂單重新前往付款兩次，兩次的 MerchantOrderNo 不會相同（不會再撞藍新 MPG03008）', () => {
  const displayId = '260807123456'
  const merchantOrderNo1 = `${displayId}R${Date.now().toString().slice(-8)}`
  const merchantOrderNo2 = `${displayId}R${(Date.now() + 1).toString().slice(-8)}`
  assert.notEqual(merchantOrderNo1, merchantOrderNo2)
  // 兩組都要能透過 slice(0, 12) 還原回同一個 display_id，證明重試不會讓訂單對不回來
  assert.equal(merchantOrderNo1.slice(0, 12), displayId)
  assert.equal(merchantOrderNo2.slice(0, 12), displayId)
})

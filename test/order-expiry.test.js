const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const config = require('./helpers/config')
const supabase = require('./helpers/db')
const { cancelExpiredOrders } = require('../src/services/orderExpiryService')
const { restoreOrderStock } = require('../src/controllers/orderController')

const cleanupIds = []
const productCleanupIds = []

let categoryId

before(async () => {
  const { data: category } = await supabase.from('product_category').select('id').eq('store_id', config.TEST_STORE_ID).limit(1).single()
  categoryId = category.id
})

const createTestProduct = async (name, stock) => {
  const { data, error: dbError } = await supabase
    .from('product')
    .insert({ store_id: config.TEST_STORE_ID, product_code: null, name, price: 0, origin_price: 0, category_id: categoryId, is_enable: false, stock })
    .select('id')
    .single()
  if (dbError) throw dbError
  productCleanupIds.push(data.id)
  return data.id
}

// display_id 欄位是 varchar(14)，比照正式訂單格式（YYMMDD + 6 碼隨機數字）
const genDisplayId = () => {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const datePart = `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const randPart = String(Math.floor(Math.random() * 1000000)).padStart(6, '0')
  return `${datePart}${randPart}`
}

const insertOrder = async ({ deadline, isPaid = false, isCancelled = false }) => {
  const { data, error } = await supabase
    .from('order')
    .insert({
      store_id: config.TEST_STORE_ID,
      user_id: config.TEST_ADMIN_USER_ID,
      display_id: genDisplayId(),
      is_paid: isPaid,
      is_cancelled: isCancelled,
      total_price: 100,
      payment_deadline_at: deadline,
    })
    .select('id, is_cancelled')
    .single()
  if (error) throw error
  cleanupIds.push(data.id)
  return data
}

const insertOrderItem = async (orderId, productId, quantity, isGift = false) => {
  const { error: dbError } = await supabase
    .from('order_item')
    .insert({ order_id: orderId, product_id: productId, product_name: 'test', product_price: 0, quantity, subtotal: 0, is_gift: isGift })
  if (dbError) throw dbError
}

after(async () => {
  for (const id of cleanupIds) {
    await supabase.from('order_item').delete().eq('order_id', id)
    await supabase.from('order').delete().eq('id', id)
  }
  for (const id of productCleanupIds) await supabase.from('product').delete().eq('id', id)
})

test('逾期未付款訂單會被自動取消（不分現金/線上付款方式）', async () => {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1 小時前
  const order = await insertOrder({ deadline: past })
  assert.equal(order.is_cancelled, false)

  await cancelExpiredOrders()

  const { data: after } = await supabase.from('order').select('is_cancelled, cancelled_at').eq('id', order.id).single()
  assert.equal(after.is_cancelled, true)
  assert.ok(after.cancelled_at)
})

test('還沒到期的訂單不會被取消', async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 小時後
  const order = await insertOrder({ deadline: future })

  await cancelExpiredOrders()

  const { data: after } = await supabase.from('order').select('is_cancelled').eq('id', order.id).single()
  assert.equal(after.is_cancelled, false)
})

test('已經付款的訂單即使過期也不會被取消', async () => {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const order = await insertOrder({ deadline: past, isPaid: true })

  await cancelExpiredOrders()

  const { data: after } = await supabase.from('order').select('is_cancelled').eq('id', order.id).single()
  assert.equal(after.is_cancelled, false)
})

test('沒有設定 payment_deadline_at 的一般商品訂單不受影響', async () => {
  const order = await insertOrder({ deadline: null })

  await cancelExpiredOrders()

  const { data: after } = await supabase.from('order').select('is_cancelled').eq('id', order.id).single()
  assert.equal(after.is_cancelled, false)
})

// 迴歸測試：2026-08 發現正式環境有中秋預購訂單取消後，庫存沒有加回去
// （createOrder 建單時扣庫存，但 cancelOrder/merchantCancelOrder/逾期自動取消
// 三條路徑過去都只標記 is_cancelled，沒有任何一條把庫存加回來）
test('逾期自動取消時，非贈品品項的庫存會加回去', async () => {
  const productId = await createTestProduct('[TEST] 逾期回補庫存', 10)
  await supabase.from('product').update({ stock: 7 }).eq('id', productId) // 模擬下單扣掉 3 件

  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const order = await insertOrder({ deadline: past })
  await insertOrderItem(order.id, productId, 3)

  await cancelExpiredOrders()

  const { data: product } = await supabase.from('product').select('stock').eq('id', productId).single()
  assert.equal(product.stock, 10)
})

test('贈品品項（is_gift=true）取消時不會被加回庫存', async () => {
  const productId = await createTestProduct('[TEST] 贈品不回補', 10)

  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const order = await insertOrder({ deadline: past })
  await insertOrderItem(order.id, productId, 5, true)

  await cancelExpiredOrders()

  const { data: product } = await supabase.from('product').select('stock').eq('id', productId).single()
  assert.equal(product.stock, 10)
})

test('stock 為 null（不限量）的商品取消時不受影響，維持 null', async () => {
  const productId = await createTestProduct('[TEST] 不限量商品', null)

  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const order = await insertOrder({ deadline: past })
  await insertOrderItem(order.id, productId, 2)

  await cancelExpiredOrders()

  const { data: product } = await supabase.from('product').select('stock').eq('id', productId).single()
  assert.equal(product.stock, null)
})

test('restoreOrderStock 可以獨立呼叫（供 cancelOrder/merchantCancelOrder 共用）', async () => {
  const productId = await createTestProduct('[TEST] 獨立呼叫回補', 5)

  const order = await insertOrder({ deadline: null })
  await insertOrderItem(order.id, productId, 2)

  await restoreOrderStock(order.id)

  const { data: product } = await supabase.from('product').select('stock').eq('id', productId).single()
  assert.equal(product.stock, 7)
})

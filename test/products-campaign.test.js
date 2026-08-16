const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const server = require('./helpers/server')
const config = require('./helpers/config')
const supabase = require('./helpers/db')

let baseUrl
let campaignId, productId

before(async () => {
  baseUrl = await server.start()

  const { data: category, error: categoryErr } = await supabase
    .from('product_category')
    .select('id')
    .eq('store_id', config.TEST_STORE_ID)
    .limit(1)
    .single()
  if (categoryErr) throw categoryErr

  const now = Date.now()
  const days = n => new Date(now + n * 24 * 60 * 60 * 1000)

  const { data: campaign, error: campaignErr } = await supabase
    .from('campaign')
    .insert({
      store_id: config.TEST_STORE_ID,
      name: '[TEST] CI 迴歸測試檔期',
      order_start_at: days(3).toISOString(),
      order_end_at: days(10).toISOString(),
      pickup_start_date: days(10).toISOString().slice(0, 10),
      pickup_end_date: days(17).toISOString().slice(0, 10),
      payment_deadline_days: 7,
      is_enable: true,
    })
    .select('id')
    .single()
  if (campaignErr) throw campaignErr
  campaignId = campaign.id

  const { data: product, error: productErr } = await supabase
    .from('product')
    .insert({
      store_id: config.TEST_STORE_ID,
      product_code: 'CITESTCAMP',
      name: '[TEST] CI 迴歸測試商品',
      price: 100,
      origin_price: 100,
      category_id: category.id,
      campaign_id: campaignId,
      is_enable: true,
    })
    .select('id')
    .single()
  if (productErr) throw productErr
  productId = product.id
})

after(async () => {
  if (productId) await supabase.from('product').delete().eq('id', productId)
  if (campaignId) await supabase.from('campaign').delete().eq('id', campaignId)
  await server.stop()
})

// 迴歸測試：曾經因為 productController.js 的 attachCampaigns select 打錯欄位名稱
// （改用 payment_deadline_days 後漏改，還在查已被刪除的 payment_deadline_at），
// 導致整條查詢失敗、每個商品的 campaign 都變成 null，讓「尚未開賣」的檔期商品
// 在前台可以被正常點擊下單。這裡直接斷言 campaign 資料真的有回來
test('GET /api/products 回傳的檔期商品帶有完整 campaign 資料', async () => {
  const res = await fetch(`${baseUrl}/api/products?is_enable=true`, {
    headers: { 'X-Store-ID': config.TEST_STORE_ID },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  const product = body.data.find(p => p.id === productId)
  assert.ok(product, 'test product should be in the product list')
  assert.ok(product.campaign, 'campaign should not be null')
  assert.ok(product.campaign.order_start_at, 'campaign.order_start_at should be present')
  assert.equal(product.campaign.id, campaignId)
})

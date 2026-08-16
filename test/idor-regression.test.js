const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const server = require('./helpers/server')
const config = require('./helpers/config')
const { signMerchantToken } = require('./helpers/auth')
const supabase = require('./helpers/db')

let baseUrl, token, otherStoreProductId, otherStoreProductWithAddonId

before(async () => {
  baseUrl = await server.start()
  token = signMerchantToken()

  // 找一個「不屬於測試商家」的真實商品 id（唯讀查詢，不會動到任何資料），
  // 用來驗證測試商家的 token 不能跨租戶操作它
  const { data: product, error } = await supabase
    .from('product')
    .select('id')
    .neq('store_id', config.TEST_STORE_ID)
    .limit(1)
    .single()
  if (error) throw error
  otherStoreProductId = product.id

  // 找一個「不屬於測試商家、且真的掛了至少一個已上架加購項目」的商品，
  // 這樣測試才有意義——如果那個商品本來就沒有加購項目，就算 IDOR 漏洞
  // 還在，測試也會誤判成通過（回傳空陣列剛好跟修好之後長得一樣）
  const { data: linked } = await supabase
    .from('product_addon')
    .select('product_id, product:product_id!inner(store_id), addon:addon_id!inner(is_enable)')
    .neq('product.store_id', config.TEST_STORE_ID)
    .eq('addon.is_enable', true)
    .limit(1)
    .maybeSingle()
  otherStoreProductWithAddonId = linked?.product_id || null
})

after(async () => { await server.stop() })

// 迴歸測試：這個 session 稍早修過 getProductAddons/setProductAddons 沒有先驗證
// product 是否屬於呼叫者的 store 就直接操作 product_addon，導致任何商家的 merchant
// 都能讀取/覆寫其他商家的加購設定
test('跨租戶：測試商家的 token 不能讀取其他商家商品的加購設定', async () => {
  const res = await fetch(`${baseUrl}/api/merchant/products/${otherStoreProductId}/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(res.status, 404)
})

test('跨租戶：測試商家的 token 不能覆寫其他商家商品的加購設定', async () => {
  const res = await fetch(`${baseUrl}/api/merchant/products/${otherStoreProductId}/addons`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ addon_ids: [] }),
  })
  assert.equal(res.status, 404)
})

// 迴歸測試：顧客端 GET /api/addons?product_id= 沒有驗證 product_id 是否屬於
// X-Store-ID 指定的商家，帶別家商家的 product_id 就能撈到別家商家的加購項目
// 名稱/價格，這個 session 稍早修好了
test('跨租戶：顧客端加購清單 API 不能用別家商家的 product_id 撈到加購項目', async (t) => {
  if (!otherStoreProductWithAddonId) {
    t.skip('測試環境找不到「別家商家且掛了已上架加購項目」的商品，跳過')
    return
  }
  const res = await fetch(`${baseUrl}/api/addons?product_id=${otherStoreProductWithAddonId}`, {
    headers: { 'X-Store-ID': config.TEST_STORE_ID },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.data, [])
})

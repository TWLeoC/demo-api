const { test, before, after, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const server = require('./helpers/server')
const config = require('./helpers/config')
const { signMerchantToken } = require('./helpers/auth')
const supabase = require('./helpers/db')

let baseUrl, token
const cleanupIds = { products: [], categories: [], campaigns: [], pickupSlots: [], giftRules: [], giftPools: [], orders: [] }

const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` })

const clearCart = async () => {
  const { data: cart } = await supabase.from('cart').select('id').eq('user_id', config.TEST_ADMIN_USER_ID).eq('store_id', config.TEST_STORE_ID).maybeSingle()
  if (cart) await supabase.from('cart_item').delete().eq('cart_id', cart.id)
}

const addToCart = async (productId, quantity) => {
  const res = await fetch(`${baseUrl}/api/cart/items`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ product_id: productId, quantity }),
  })
  const body = await res.json()
  assert.equal(res.status, 201, `addToCart failed: ${JSON.stringify(body)}`)
}

const placeOrder = async (extraBody = {}) => {
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(extraBody),
  })
  const body = await res.json()
  if (body.data?.order_id) cleanupIds.orders.push(body.data.order_id)
  return { status: res.status, body }
}

const createHiddenProduct = async (name, categoryId, campaignId = null) => {
  const { data, error: dbError } = await supabase
    .from('product')
    .insert({ store_id: config.TEST_STORE_ID, product_code: null, name, price: 0, origin_price: 0, category_id: categoryId, campaign_id: campaignId, is_enable: false })
    .select('id')
    .single()
  if (dbError) throw dbError
  cleanupIds.products.push(data.id)
  return data.id
}

before(async () => {
  baseUrl = await server.start()
  token = signMerchantToken()
  await clearCart()

  // 用測試店已有的「測試分類」當一般商品規則的分類
  const { data: category } = await supabase.from('product_category').select('id').eq('store_id', config.TEST_STORE_ID).limit(1).single()
  cleanupIds.testCategoryId = category.id

  // 一般商品規則要用的贈品品項
  cleanupIds.bagProductId = await createHiddenProduct('[TEST] 保溫袋', category.id)

  // 一般商品：直接用店裡既有的測試商品（50 元一份），沒有的話就自己建一個
  const { data: existingProduct } = await supabase
    .from('product')
    .select('id, price')
    .eq('store_id', config.TEST_STORE_ID)
    .is('campaign_id', null)
    .eq('is_enable', true)
    .limit(1)
    .single()
  cleanupIds.regularProductId = existingProduct.id
  cleanupIds.regularProductPrice = existingProduct.price

  // 一般商品訂單也需要選取餐時段（店家有設定過時段，強制要選）
  const regularSlotDate = new Date(Date.now() + 50 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { data: regularSlot, error: slotErr } = await supabase
    .from('pickup_slot')
    .insert({ store_id: config.TEST_STORE_ID, date: regularSlotDate, start_time: '10:00:00', end_time: '12:00:00' })
    .select('id')
    .single()
  if (slotErr) throw slotErr
  cleanupIds.pickupSlots.push(regularSlot.id)
  cleanupIds.regularSlotId = regularSlot.id

  // 自己建一個「現在正在開賣」的測試檔期，不依賴既有檔期的時間窗（可能還沒開賣或已截止）
  const now = Date.now()
  const days = n => new Date(now + n * 24 * 60 * 60 * 1000)
  const { data: campaign, error: campErr } = await supabase
    .from('campaign')
    .insert({
      store_id: config.TEST_STORE_ID,
      name: '[TEST] 贈品測試檔期',
      order_start_at: days(-1).toISOString(),
      order_end_at: days(30).toISOString(),
      pickup_start_date: days(10).toISOString().slice(0, 10),
      pickup_end_date: days(17).toISOString().slice(0, 10),
      payment_deadline_days: 7,
      is_enable: true,
    })
    .select('id')
    .single()
  if (campErr) throw campErr
  cleanupIds.campaigns.push(campaign.id)
  cleanupIds.campaignId = campaign.id

  cleanupIds.campaignProductId = await createHiddenProduct('[TEST] 檔期商品', category.id, campaign.id)
  // 檔期商品要能實際下單（is_enable 才能加入購物車），售價設高一點方便湊金額，
  // stock 預設是 0 不是不限，要明確設成 null 才不會被庫存檢查擋下
  await supabase.from('product').update({ is_enable: true, price: 500, origin_price: 500, stock: null }).eq('id', cleanupIds.campaignProductId)

  const campaignSlotDate = days(12).toISOString().slice(0, 10)
  const { data: campaignSlot, error: campSlotErr } = await supabase
    .from('pickup_slot')
    .insert({ store_id: config.TEST_STORE_ID, date: campaignSlotDate, start_time: '10:00:00', end_time: '12:00:00', campaign_id: campaign.id })
    .select('id')
    .single()
  if (campSlotErr) throw campSlotErr
  cleanupIds.pickupSlots.push(campaignSlot.id)
  cleanupIds.campaignSlotId = campaignSlot.id

  // 贈品二選一的三個小菜子選項用的品項
  cleanupIds.sauceProductId = await createHiddenProduct('[TEST] 烤肉醬', category.id)
  cleanupIds.gingerProductId = await createHiddenProduct('[TEST] 嫩薑片', category.id)
  cleanupIds.pickleProductId = await createHiddenProduct('[TEST] 酸菜', category.id)
  cleanupIds.kimchiProductId = await createHiddenProduct('[TEST] 韓式泡菜', category.id)
})

afterEach(async () => {
  await clearCart()
})

after(async () => {
  for (const orderId of cleanupIds.orders) {
    await supabase.from('order_item').delete().eq('order_id', orderId)
    await supabase.from('order').delete().eq('id', orderId)
  }
  for (const ruleId of cleanupIds.giftRules) {
    await supabase.from('gift_rule_option').delete().eq('gift_rule_id', ruleId)
    await supabase.from('gift_rule').delete().eq('id', ruleId)
  }
  for (const poolId of cleanupIds.giftPools) await supabase.from('gift_pool').delete().eq('id', poolId)
  for (const slotId of cleanupIds.pickupSlots) await supabase.from('pickup_slot').delete().eq('id', slotId)
  for (const productId of cleanupIds.products) await supabase.from('product').delete().eq('id', productId)
  for (const campaignId of cleanupIds.campaigns) await supabase.from('campaign').delete().eq('id', campaignId)
  await server.stop()
})

// ── 規則 A：一般商品滿額免費贈送（限量）──────────────────────
test('一般商品滿額贈送：達門檻拿到免費贈品，名額用完後不再送', async () => {
  const { data: rule, error: dbError } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 熟食滿額贈保溫袋', campaign_id: null, threshold_amount: 200, mode: 'flat', max_redemptions: 1, is_enable: true })
    .select('id')
    .single()
  if (dbError) throw dbError
  cleanupIds.giftRules.push(rule.id)
  await supabase.from('gift_rule_option').insert({ gift_rule_id: rule.id, product_id: cleanupIds.bagProductId, label: '保溫袋' })

  const qty = Math.ceil(200 / cleanupIds.regularProductPrice)
  await addToCart(cleanupIds.regularProductId, qty)
  const { status, body } = await placeOrder({ pickup_slot_id: cleanupIds.regularSlotId, pickup_time: '10:00:00', payment_method_id: 1 })
  assert.equal(status, 201, JSON.stringify(body))

  // 用 gift_rule_id 篩選這個測試自己建的規則，不能只看「有沒有任何贈品品項」——
  // 測試店裡可能還有商家自己在後台設定的其他一般商品規則（真實資料，不是這個測試建的），
  // 一樣會命中同一張訂單，用 is_gift 廣泛過濾會被那些規則的贈品品項干擾
  const { data: items } = await supabase.from('order_item').select('*').eq('order_id', body.data.order_id)
  const myGiftItems = items.filter(i => i.gift_rule_id === rule.id)
  assert.equal(myGiftItems.length, 1)
  assert.equal(myGiftItems[0].product_price, 0)
  assert.equal(myGiftItems[0].quantity, 1)

  // 第二張同樣達標的訂單：名額已用完，不應該再有贈品品項
  await addToCart(cleanupIds.regularProductId, qty)
  const second = await placeOrder({ pickup_slot_id: cleanupIds.regularSlotId, pickup_time: '10:00:00', payment_method_id: 1 })
  assert.equal(second.status, 201, JSON.stringify(second.body))
  const { data: items2 } = await supabase.from('order_item').select('*').eq('order_id', second.body.data.order_id)
  assert.equal(items2.filter(i => i.gift_rule_id === rule.id).length, 0)
})

// ── 共用庫存池：兩個不同規則指到同一個池子，額度是共用的 ────
test('共用庫存池：規則 A 用掉額度後，規則 B（同一個池子）也拿不到贈品', async () => {
  const { data: pool, error: poolErr } = await supabase
    .from('gift_pool')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 保溫袋共用庫存', max_redemptions: 1 })
    .select('id')
    .single()
  if (poolErr) throw poolErr
  cleanupIds.giftPools.push(pool.id)

  const { data: ruleA, error: ruleAErr } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 規則A-共用池', campaign_id: null, threshold_amount: 100, mode: 'flat', gift_pool_id: pool.id, is_enable: true })
    .select('id')
    .single()
  if (ruleAErr) throw ruleAErr
  cleanupIds.giftRules.push(ruleA.id)
  await supabase.from('gift_rule_option').insert({ gift_rule_id: ruleA.id, product_id: cleanupIds.bagProductId, label: '保溫袋' })

  const { data: ruleB, error: ruleBErr } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 規則B-共用池', campaign_id: null, threshold_amount: 200, mode: 'flat', gift_pool_id: pool.id, is_enable: true })
    .select('id')
    .single()
  if (ruleBErr) throw ruleBErr
  cleanupIds.giftRules.push(ruleB.id)
  await supabase.from('gift_rule_option').insert({ gift_rule_id: ruleB.id, product_id: cleanupIds.bagProductId, label: '保溫袋' })

  // 第一張訂單只達規則 A 的門檻（100），拿到贈品、把池子的唯一額度用掉
  const qtyA = Math.ceil(100 / cleanupIds.regularProductPrice)
  await addToCart(cleanupIds.regularProductId, qtyA)
  const first = await placeOrder({ pickup_slot_id: cleanupIds.regularSlotId, pickup_time: '10:00:00', payment_method_id: 1 })
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const { data: items1 } = await supabase.from('order_item').select('*').eq('order_id', first.body.data.order_id)
  assert.equal(items1.filter(i => i.gift_rule_id === ruleA.id).length, 1, '規則 A 應該要拿到贈品')

  // 第二張訂單達規則 B 的門檻（200，是不同規則），但共用池子額度已經被規則 A 用完，不該再有贈品
  const qtyB = Math.ceil(200 / cleanupIds.regularProductPrice)
  await addToCart(cleanupIds.regularProductId, qtyB)
  const second = await placeOrder({ pickup_slot_id: cleanupIds.regularSlotId, pickup_time: '10:00:00', payment_method_id: 1 })
  assert.equal(second.status, 201, JSON.stringify(second.body))
  const { data: items2 } = await supabase.from('order_item').select('*').eq('order_id', second.body.data.order_id)
  assert.equal(items2.filter(i => i.gift_rule_id === ruleB.id).length, 0, '規則 B 共用同一個池子，額度已被規則 A 用完，不該再送')
})

// ── 規則 A：加價購 ──────────────────────────────────────────
test('一般商品加價購：勾選後總金額正確加上加購金額', async () => {
  const { data: rule, error: dbError } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 熟食加價購保溫袋', campaign_id: null, threshold_amount: 150, mode: 'addon_purchase', addon_price: 39, is_enable: true })
    .select('id')
    .single()
  if (dbError) throw dbError
  cleanupIds.giftRules.push(rule.id)
  await supabase.from('gift_rule_option').insert({ gift_rule_id: rule.id, product_id: cleanupIds.bagProductId, label: '保溫袋' })

  const qty = Math.ceil(150 / cleanupIds.regularProductPrice)
  await addToCart(cleanupIds.regularProductId, qty)
  const expectedSubtotal = qty * cleanupIds.regularProductPrice

  const { status, body } = await placeOrder({
    pickup_slot_id: cleanupIds.regularSlotId, pickup_time: '10:00:00', payment_method_id: 1,
    gift_addon_purchases: [{ gift_rule_id: rule.id, quantity: 1 }],
  })
  assert.equal(status, 201, JSON.stringify(body))
  assert.equal(body.data.total_price, expectedSubtotal + 39)

  const { data: items } = await supabase.from('order_item').select('*').eq('order_id', body.data.order_id)
  const giftItems = items.filter(i => i.gift_rule_id === rule.id)
  assert.equal(giftItems.length, 1)
  assert.equal(giftItems[0].product_price, 39)
})

test('加價購可以一次買多個：總金額跟共用庫存池消耗都要照數量算，不是照筆數算', async () => {
  const { data: pool, error: poolErr } = await supabase
    .from('gift_pool')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 加購多個-庫存池', max_redemptions: 5 })
    .select('id')
    .single()
  if (poolErr) throw poolErr
  cleanupIds.giftPools.push(pool.id)

  const { data: rule, error: dbError } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 加價購-可買多個', campaign_id: null, threshold_amount: 150, mode: 'addon_purchase', addon_price: 39, gift_pool_id: pool.id, is_enable: true })
    .select('id')
    .single()
  if (dbError) throw dbError
  cleanupIds.giftRules.push(rule.id)
  await supabase.from('gift_rule_option').insert({ gift_rule_id: rule.id, product_id: cleanupIds.bagProductId, label: '保溫袋' })

  const qty = Math.ceil(150 / cleanupIds.regularProductPrice)
  await addToCart(cleanupIds.regularProductId, qty)
  const expectedSubtotal = qty * cleanupIds.regularProductPrice

  // 一次買 3 個加購品項
  const first = await placeOrder({
    pickup_slot_id: cleanupIds.regularSlotId, pickup_time: '10:00:00', payment_method_id: 1,
    gift_addon_purchases: [{ gift_rule_id: rule.id, quantity: 3 }],
  })
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(first.body.data.total_price, expectedSubtotal + 39 * 3)

  const { data: items } = await supabase.from('order_item').select('*').eq('order_id', first.body.data.order_id)
  const giftItems = items.filter(i => i.gift_rule_id === rule.id)
  assert.equal(giftItems.length, 1)
  assert.equal(giftItems[0].quantity, 3, '應該是同一筆 order_item，quantity=3，不是拆成 3 筆')

  // 池子額度只剩 2 個（5 - 3），再買 3 個應該被擋下（超過剩餘）
  await addToCart(cleanupIds.regularProductId, qty)
  const second = await placeOrder({
    pickup_slot_id: cleanupIds.regularSlotId, pickup_time: '10:00:00', payment_method_id: 1,
    gift_addon_purchases: [{ gift_rule_id: rule.id, quantity: 3 }],
  })
  assert.equal(second.status, 400, JSON.stringify(second.body))

  // 買剩餘的 2 個應該成功
  await addToCart(cleanupIds.regularProductId, qty)
  const third = await placeOrder({
    pickup_slot_id: cleanupIds.regularSlotId, pickup_time: '10:00:00', payment_method_id: 1,
    gift_addon_purchases: [{ gift_rule_id: rule.id, quantity: 2 }],
  })
  assert.equal(third.status, 201, JSON.stringify(third.body))
})

// ── max_amount：兩個規則依金額區間互斥 ──────────────────────
test('max_amount：150~199 只看到加購規則，200 以上只看到滿額送規則', async () => {
  const { data: flatRule, error: e1 } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 互斥-滿額送', campaign_id: null, threshold_amount: 200, max_amount: null, mode: 'flat', is_enable: true })
    .select('id')
    .single()
  if (e1) throw e1
  cleanupIds.giftRules.push(flatRule.id)
  await supabase.from('gift_rule_option').insert({ gift_rule_id: flatRule.id, product_id: cleanupIds.bagProductId, label: '保溫袋' })

  const { data: addonRule, error: e2 } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 互斥-加價購', campaign_id: null, threshold_amount: 150, max_amount: 200, mode: 'addon_purchase', addon_price: 39, is_enable: true })
    .select('id')
    .single()
  if (e2) throw e2
  cleanupIds.giftRules.push(addonRule.id)
  await supabase.from('gift_rule_option').insert({ gift_rule_id: addonRule.id, product_id: cleanupIds.bagProductId, label: '保溫袋' })

  const getCartGiftRuleIds = async () => {
    const res = await fetch(`${baseUrl}/api/cart`, { headers: authHeaders() })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    return (body.data.gift_eligibility || []).map(g => g.gift_rule_id)
  }

  // 150~199：只有加購規則（用 includes 判斷這兩個規則各自在不在，不斷言完整陣列——
  // 測試店可能還有其他一般商品規則同時符合資格，不影響「這兩個規則互斥」這件事本身）
  const qty150 = Math.ceil(150 / cleanupIds.regularProductPrice)
  await addToCart(cleanupIds.regularProductId, qty150)
  const subtotal150 = qty150 * cleanupIds.regularProductPrice
  if (subtotal150 < 200) {
    const ids = await getCartGiftRuleIds()
    assert.ok(ids.includes(addonRule.id), '150~199 應該看得到加購規則')
    assert.ok(!ids.includes(flatRule.id), '150~199 不該看到滿額送規則')
  }
  await clearCart()

  // 200 以上：只有滿額送規則
  const qty200 = Math.ceil(200 / cleanupIds.regularProductPrice)
  await addToCart(cleanupIds.regularProductId, qty200)
  const ids200 = await getCartGiftRuleIds()
  assert.ok(ids200.includes(flatRule.id), '200 以上應該看得到滿額送規則')
  assert.ok(!ids200.includes(addonRule.id), '200 以上不該再看到加購規則')
})

// ── 規則 B：檔期商品 scaling + 二選一（含巢狀三選一）疊加 ──────
test('檔期商品：滿額累進贈送 + 二選一贈品同時疊加', async () => {
  const { data: scalingRule, error: e1 } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 檔期累進保溫袋', campaign_id: cleanupIds.campaignId, threshold_amount: 500, mode: 'scaling', qty_per_step: 1, is_enable: true })
    .select('id')
    .single()
  if (e1) throw e1
  cleanupIds.giftRules.push(scalingRule.id)
  await supabase.from('gift_rule_option').insert({ gift_rule_id: scalingRule.id, product_id: cleanupIds.bagProductId, label: '保溫袋' })

  const { data: choiceRule, error: e2 } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 檔期二選一', campaign_id: cleanupIds.campaignId, threshold_amount: 1000, mode: 'flat', is_enable: true })
    .select('id')
    .single()
  if (e2) throw e2
  cleanupIds.giftRules.push(choiceRule.id)

  const { data: sauceOpt } = await supabase.from('gift_rule_option').insert({ gift_rule_id: choiceRule.id, product_id: cleanupIds.sauceProductId, label: '招牌烤肉醬', sort_order: 0 }).select('id').single()
  const { data: sideGroup } = await supabase.from('gift_rule_option').insert({ gift_rule_id: choiceRule.id, product_id: null, label: '小菜', sort_order: 1 }).select('id').single()
  const { data: pickleOpt } = await supabase.from('gift_rule_option').insert({ gift_rule_id: choiceRule.id, parent_option_id: sideGroup.id, product_id: cleanupIds.pickleProductId, label: '酸菜', sort_order: 0 }).select('id').single()
  await supabase.from('gift_rule_option').insert({ gift_rule_id: choiceRule.id, parent_option_id: sideGroup.id, product_id: cleanupIds.gingerProductId, label: '嫩薑片', sort_order: 1 })
  await supabase.from('gift_rule_option').insert({ gift_rule_id: choiceRule.id, parent_option_id: sideGroup.id, product_id: cleanupIds.kimchiProductId, label: '韓式泡菜', sort_order: 2 })

  // 檔期商品單價 500，買 2 個剛好 1000 元：符合 scaling（qty=2）+ 二選一（門檻 1000）
  await addToCart(cleanupIds.campaignProductId, 2)
  const { status, body } = await placeOrder({
    pickup_slot_id: cleanupIds.campaignSlotId, pickup_time: '10:00:00', payment_method_id: 1,
    gift_choices: [{ gift_rule_id: choiceRule.id, option_id: pickleOpt.id }],
  })
  assert.equal(status, 201, JSON.stringify(body))

  const { data: items } = await supabase.from('order_item').select('*').eq('order_id', body.data.order_id)
  const giftItems = items.filter(i => i.is_gift)
  const bagItem = giftItems.find(i => i.gift_rule_id === scalingRule.id)
  const pickleItem = giftItems.find(i => i.gift_rule_id === choiceRule.id)
  assert.ok(bagItem, '應該有保溫袋贈品')
  assert.equal(bagItem.quantity, 2)
  assert.ok(pickleItem, '應該有酸菜贈品')
  assert.equal(pickleItem.product_name, '酸菜')
  assert.equal(pickleItem.product_price, 0)
})

test('檔期商品：選到分組節點本身（沒往下選）視為無效，訂單建立失敗', async () => {
  const { data: choiceRule, error: e2 } = await supabase
    .from('gift_rule')
    .insert({ store_id: config.TEST_STORE_ID, name: '[TEST] 檔期二選一-無效測試', campaign_id: cleanupIds.campaignId, threshold_amount: 1000, mode: 'flat', is_enable: true })
    .select('id')
    .single()
  if (e2) throw e2
  cleanupIds.giftRules.push(choiceRule.id)
  await supabase.from('gift_rule_option').insert({ gift_rule_id: choiceRule.id, product_id: cleanupIds.sauceProductId, label: '招牌烤肉醬', sort_order: 0 })
  const { data: sideGroup } = await supabase.from('gift_rule_option').insert({ gift_rule_id: choiceRule.id, product_id: null, label: '小菜', sort_order: 1 }).select('id').single()
  await supabase.from('gift_rule_option').insert({ gift_rule_id: choiceRule.id, parent_option_id: sideGroup.id, product_id: cleanupIds.gingerProductId, label: '嫩薑片', sort_order: 0 })

  await addToCart(cleanupIds.campaignProductId, 2)
  const { status, body } = await placeOrder({
    pickup_slot_id: cleanupIds.campaignSlotId, pickup_time: '10:00:00', payment_method_id: 1,
    gift_choices: [{ gift_rule_id: choiceRule.id, option_id: sideGroup.id }], // 選到分組節點本身，不合法
  })
  assert.equal(status, 400, JSON.stringify(body))
  assert.equal(body.success, false)
})

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { calculateGiftEligibility, validateGiftChoice } = require('../src/utils/giftCalculator')

const cartOf = (amount) => [{ product_id: 'p1', category_id: 'cat-regular', campaign_id: null, quantity: 1, unit_price: amount }]

const bagOption = () => [{ id: 'opt-bag', product_id: 'prod-bag', label: '保溫袋', children: [] }]

test('flat 模式：未達門檻不符合', () => {
  const rules = [{ id: 'r1', mode: 'flat', threshold_amount: 200, campaign_id: null, options: bagOption() }]
  const result = calculateGiftEligibility({ cartItems: cartOf(199), campaignId: null, rules })
  assert.equal(result.length, 0)
})

test('flat 模式：剛好達門檻，qty=1', () => {
  const rules = [{ id: 'r1', mode: 'flat', threshold_amount: 200, campaign_id: null, options: bagOption() }]
  const result = calculateGiftEligibility({ cartItems: cartOf(200), campaignId: null, rules })
  assert.equal(result.length, 1)
  assert.equal(result[0].qty, 1)
})

test('flat 模式：超過門檻很多，還是只有 qty=1（不會往上疊加）', () => {
  const rules = [{ id: 'r1', mode: 'flat', threshold_amount: 200, campaign_id: null, options: bagOption() }]
  const result = calculateGiftEligibility({ cartItems: cartOf(400), campaignId: null, rules })
  assert.equal(result.length, 1)
  assert.equal(result[0].qty, 1)
})

test('scaling 模式：未達第一階不符合', () => {
  const rules = [{ id: 'r2', mode: 'scaling', threshold_amount: 500, qty_per_step: 1, campaign_id: 'camp-1', options: bagOption() }]
  const result = calculateGiftEligibility({ cartItems: cartOf(499), campaignId: 'camp-1', rules })
  assert.equal(result.length, 0)
})

test('scaling 模式：500/1000/1500 分別對應 qty 1/2/3', () => {
  const rules = [{ id: 'r2', mode: 'scaling', threshold_amount: 500, qty_per_step: 1, campaign_id: 'camp-1', options: bagOption() }]
  for (const [amount, expectedQty] of [[500, 1], [1000, 2], [1500, 3]]) {
    const result = calculateGiftEligibility({ cartItems: cartOf(amount), campaignId: 'camp-1', rules })
    assert.equal(result.length, 1, `amount=${amount}`)
    assert.equal(result[0].qty, expectedQty, `amount=${amount}`)
  }
})

test('addon_purchase 模式：未達門檻不符合，達門檻回傳 addon_price', () => {
  const rules = [{ id: 'r3', mode: 'addon_purchase', threshold_amount: 150, addon_price: 39, campaign_id: null, options: bagOption() }]
  const notYet = calculateGiftEligibility({ cartItems: cartOf(149), campaignId: null, rules })
  assert.equal(notYet.length, 0)

  const qualifies = calculateGiftEligibility({ cartItems: cartOf(150), campaignId: null, rules })
  assert.equal(qualifies.length, 1)
  assert.equal(qualifies[0].addon_price, 39)
  assert.equal(qualifies[0].qty, 1)
})

test('excluded_category_id：排除分類的金額不算進門檻', () => {
  const rules = [{ id: 'r1', mode: 'flat', threshold_amount: 200, campaign_id: null, excluded_category_id: 'cat-fresh', options: bagOption() }]
  const cartItems = [
    { product_id: 'p1', category_id: 'cat-regular', campaign_id: null, quantity: 1, unit_price: 100 },
    { product_id: 'p2', category_id: 'cat-fresh', campaign_id: null, quantity: 1, unit_price: 200 }, // 生鮮，不計入
  ]
  // 總金額 300，但扣掉生鮮的 200 之後只剩 100，未達 200 門檻
  const result = calculateGiftEligibility({ cartItems, campaignId: null, rules })
  assert.equal(result.length, 0)
})

test('excluded_category_id：扣掉排除分類後仍達標則符合', () => {
  const rules = [{ id: 'r1', mode: 'flat', threshold_amount: 200, campaign_id: null, excluded_category_id: 'cat-fresh', options: bagOption() }]
  const cartItems = [
    { product_id: 'p1', category_id: 'cat-regular', campaign_id: null, quantity: 1, unit_price: 250 },
    { product_id: 'p2', category_id: 'cat-fresh', campaign_id: null, quantity: 1, unit_price: 200 },
  ]
  const result = calculateGiftEligibility({ cartItems, campaignId: null, rules })
  assert.equal(result.length, 1)
})

test('max_redemptions：名額用完後不符合資格（不是報錯）', () => {
  const rules = [{ id: 'r1', mode: 'flat', threshold_amount: 200, campaign_id: null, max_redemptions: 5, redeemed_count: 5, options: bagOption() }]
  const result = calculateGiftEligibility({ cartItems: cartOf(200), campaignId: null, rules })
  assert.equal(result.length, 0)
})

test('max_redemptions：還有名額時正常給予，並回傳剩餘數', () => {
  const rules = [{ id: 'r1', mode: 'flat', threshold_amount: 200, campaign_id: null, max_redemptions: 5, redeemed_count: 3, options: bagOption() }]
  const result = calculateGiftEligibility({ cartItems: cartOf(200), campaignId: null, rules })
  assert.equal(result.length, 1)
  assert.equal(result[0].remaining_redemptions, 2)
})

test('max_amount：兩個規則依金額區間互斥（150~199 只有加購，200+ 只有滿額送）', () => {
  const rules = [
    { id: 'r-addon', mode: 'addon_purchase', threshold_amount: 150, max_amount: 200, addon_price: 39, campaign_id: null, options: bagOption() },
    { id: 'r-flat', mode: 'flat', threshold_amount: 200, max_amount: null, campaign_id: null, options: bagOption() },
  ]

  const at150 = calculateGiftEligibility({ cartItems: cartOf(150), campaignId: null, rules })
  assert.equal(at150.length, 1)
  assert.equal(at150[0].gift_rule_id, 'r-addon')

  const at199 = calculateGiftEligibility({ cartItems: cartOf(199), campaignId: null, rules })
  assert.equal(at199.length, 1)
  assert.equal(at199[0].gift_rule_id, 'r-addon')

  const at200 = calculateGiftEligibility({ cartItems: cartOf(200), campaignId: null, rules })
  assert.equal(at200.length, 1)
  assert.equal(at200[0].gift_rule_id, 'r-flat')

  const at400 = calculateGiftEligibility({ cartItems: cartOf(400), campaignId: null, rules })
  assert.equal(at400.length, 1)
  assert.equal(at400[0].gift_rule_id, 'r-flat')
})

test('max_amount：留空代表沒有上限，維持原本行為', () => {
  const rules = [{ id: 'r1', mode: 'flat', threshold_amount: 200, max_amount: null, campaign_id: null, options: bagOption() }]
  const result = calculateGiftEligibility({ cartItems: cartOf(99999), campaignId: null, rules })
  assert.equal(result.length, 1)
})

// 多門檻疊加送（不設 max_amount）：每個規則各自獨立判斷門檻，達到多個門檻
// 就疊加拿到多個贈品，不是只拿最高門檻那一個——跟 max_amount 的互斥情境是相反的
// 兩種需求，預設（不設 max_amount）就是疊加，要互斥才需要額外設定 max_amount
test('多門檻各自獨立疊加：150送A、250送B、500送C，買400元同時拿到A+B，買600元拿到A+B+C', () => {
  const rules = [
    { id: 'r-a', mode: 'flat', threshold_amount: 150, max_amount: null, campaign_id: null, options: [{ id: 'opt-a', product_id: 'prod-a', label: 'A', children: [] }] },
    { id: 'r-b', mode: 'flat', threshold_amount: 250, max_amount: null, campaign_id: null, options: [{ id: 'opt-b', product_id: 'prod-b', label: 'B', children: [] }] },
    { id: 'r-c', mode: 'flat', threshold_amount: 500, max_amount: null, campaign_id: null, options: [{ id: 'opt-c', product_id: 'prod-c', label: 'C', children: [] }] },
  ]

  const at400 = calculateGiftEligibility({ cartItems: cartOf(400), campaignId: null, rules })
  assert.deepEqual(at400.map(g => g.gift_rule_id).sort(), ['r-a', 'r-b'])

  const at600 = calculateGiftEligibility({ cartItems: cartOf(600), campaignId: null, rules })
  assert.deepEqual(at600.map(g => g.gift_rule_id).sort(), ['r-a', 'r-b', 'r-c'])
})

test('campaign_id 不符的規則不會套用（一般商品購物車不會拿到檔期限定規則）', () => {
  const rules = [{ id: 'r2', mode: 'flat', threshold_amount: 100, campaign_id: 'camp-1', options: bagOption() }]
  const result = calculateGiftEligibility({ cartItems: cartOf(500), campaignId: null, rules })
  assert.equal(result.length, 0)
})

test('requires_choice：只有 1 個選項時不用選', () => {
  const rules = [{ id: 'r1', mode: 'flat', threshold_amount: 200, campaign_id: null, options: bagOption() }]
  const result = calculateGiftEligibility({ cartItems: cartOf(200), campaignId: null, rules })
  assert.equal(result[0].requires_choice, false)
})

test('requires_choice：>=2 個頂層選項時要選', () => {
  const options = [
    { id: 'opt-sauce', product_id: 'prod-sauce', label: '招牌烤肉醬', children: [] },
    {
      id: 'opt-side',
      product_id: null,
      label: '小菜',
      children: [
        { id: 'opt-ginger', product_id: 'prod-ginger', label: '嫩薑片', children: [] },
        { id: 'opt-pickle', product_id: 'prod-pickle', label: '酸菜', children: [] },
        { id: 'opt-kimchi', product_id: 'prod-kimchi', label: '韓式泡菜', children: [] },
      ],
    },
  ]
  const rules = [{ id: 'r4', mode: 'flat', threshold_amount: 1000, campaign_id: 'camp-1', options }]
  const result = calculateGiftEligibility({ cartItems: cartOf(1000), campaignId: 'camp-1', rules })
  assert.equal(result[0].requires_choice, true)
  assert.equal(result[0].options.length, 2)
  assert.equal(result[0].options[1].children.length, 3)
})

test('validateGiftChoice：選到分組節點（沒有 product_id）視為無效，要往下選到葉節點', () => {
  const rule = {
    options: [
      { id: 'opt-sauce', product_id: 'prod-sauce', label: '招牌烤肉醬', children: [] },
      { id: 'opt-side', product_id: null, label: '小菜', children: [
        { id: 'opt-ginger', product_id: 'prod-ginger', label: '嫩薑片', children: [] },
      ] },
    ],
  }
  const invalid = validateGiftChoice(rule, 'opt-side')
  assert.equal(invalid.valid, false)

  const valid = validateGiftChoice(rule, 'opt-ginger')
  assert.equal(valid.valid, true)
  assert.equal(valid.option.product_id, 'prod-ginger')
})

test('validateGiftChoice：選項 id 不存在於這個規則時無效', () => {
  const rule = { options: [{ id: 'opt-sauce', product_id: 'prod-sauce', label: '招牌烤肉醬', children: [] }] }
  const result = validateGiftChoice(rule, 'not-a-real-option-id')
  assert.equal(result.valid, false)
})

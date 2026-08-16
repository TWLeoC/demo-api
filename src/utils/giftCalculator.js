// 贈品規則計算——純函式，不碰資料庫。呼叫端（cartController/orderController）
// 負責把候選規則（已經依 store_id/is_enable/時間窗篩過）跟目前已兌換數查好，
// 這裡只做「這個購物車符合哪些規則、各自要送幾個、選項長什麼樣子」的計算。
//
// cartItems 格式：[{ product_id, category_id, campaign_id, quantity, unit_price }]
// unit_price 是單價（含加購選項後的單件總價，由呼叫端算好傳入）

// 門檻金額只算「沒有被排除分類」的品項（例如熟食規則要排除生鮮）
const computeQualifyingAmount = (cartItems, excludedCategoryId) => {
  return cartItems.reduce((sum, item) => {
    if (excludedCategoryId && item.category_id === excludedCategoryId) return sum
    return sum + item.unit_price * item.quantity
  }, 0)
}

// 規則本身適不適用這張購物車：campaign_id 要完全對得上（都是 null = 一般商品訂單，
// 或兩邊是同一個檔期 id）——檔期商品跟一般商品本來就不會混在同一張購物車，
// 所以不會有「兩種規則都符合」的情況
const ruleAppliesToCart = (rule, campaignId) => {
  return (rule.campaign_id ?? null) === (campaignId ?? null)
}

// 依 mode 計算符合資格時要送幾個：
// - flat：固定 1 個，金額超過門檻不會往上疊加
// - scaling：每跨一個門檻整數倍送 qty_per_step 個（500 送 1、1000 送 2...）
// - addon_purchase：不是自動送，是「顧客可以加價購 1 個」的資格，qty 固定 1
const computeQty = (rule, qualifyingAmount) => {
  if (rule.mode === 'scaling') {
    return Math.floor(qualifyingAmount / rule.threshold_amount) * rule.qty_per_step
  }
  return 1
}

// 計算這張購物車符合哪些贈品規則。rules 每筆需要帶 redeemed_count（呼叫端先查好
// 目前已經兌換多少次，用來跟 max_redemptions 比對）
const calculateGiftEligibility = ({ cartItems, campaignId, rules }) => {
  const results = []

  for (const rule of rules) {
    if (!ruleAppliesToCart(rule, campaignId)) continue

    const qualifyingAmount = computeQualifyingAmount(cartItems, rule.excluded_category_id)
    if (qualifyingAmount < rule.threshold_amount) continue
    // max_amount：金額區間互斥用，例如「熟食滿200送保冷袋」沒有上限、「熟食150加購」
    // 上限訂 200，達到 200 之後就不再顯示加購選項，只剩滿額送的規則
    if (rule.max_amount != null && qualifyingAmount >= rule.max_amount) continue

    const qty = computeQty(rule, qualifyingAmount)
    if (qty <= 0) continue

    let remainingRedemptions = null
    if (rule.max_redemptions != null) {
      remainingRedemptions = rule.max_redemptions - (rule.redeemed_count || 0)
      // 名額不夠這次要送的數量就整條規則不適用（不做部分兌現），
      // 送完為止的語意——不是報錯擋單，單純這次沒有這個贈品
      if (remainingRedemptions < qty) continue
    }

    results.push({
      gift_rule_id: rule.id,
      name: rule.name,
      mode: rule.mode,
      qty,
      addon_price: rule.mode === 'addon_purchase' ? rule.addon_price : null,
      requires_choice: (rule.options || []).length >= 2,
      options: rule.options || [],
      remaining_redemptions: remainingRedemptions,
    })
  }

  return results
}

// 在 options 樹（含巢狀 children）裡找某個 option id，回傳該節點或 null
const findOption = (options, optionId) => {
  for (const opt of options || []) {
    if (opt.id === optionId) return opt
    const found = findOption(opt.children, optionId)
    if (found) return found
  }
  return null
}

// 驗證顧客選的 option 是「葉節點」（有 product_id，不是像「小菜」那種還要再往下選的分組節點）
// 且真的屬於這個規則的選項樹。用在 order 建立時重新驗證顧客送來的選擇，不能只信前端。
const validateGiftChoice = (rule, optionId) => {
  const option = findOption(rule.options, optionId)
  if (!option) return { valid: false, reason: '選項不存在' }
  if (!option.product_id) return { valid: false, reason: '請選擇到最終品項，不能只選分類' }
  return { valid: true, option }
}

module.exports = {
  computeQualifyingAmount,
  ruleAppliesToCart,
  computeQty,
  calculateGiftEligibility,
  findOption,
  validateGiftChoice,
}

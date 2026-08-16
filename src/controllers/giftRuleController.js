const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')

// gift_rule_option 是自我參照的巢狀結構（parent_option_id），從扁平列表組成樹狀結構
const buildOptionTree = (flatOptions) => {
  const byId = Object.fromEntries(flatOptions.map(o => [o.id, { ...o, children: [] }]))
  const roots = []
  flatOptions.forEach(o => {
    if (o.parent_option_id && byId[o.parent_option_id]) {
      byId[o.parent_option_id].children.push(byId[o.id])
    } else if (!o.parent_option_id) {
      roots.push(byId[o.id])
    }
  })
  const sortTree = (nodes) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order)
    nodes.forEach(n => sortTree(n.children))
  }
  sortTree(roots)
  return roots
}

// 已兌換數：這個規則底下所有非取消訂單的贈品 order_item「數量加總」，不是筆數——
// 加購模式現在可以一次買多個（例如一張訂單買 5 個），要算 5 個庫存被佔用，不是 1 筆
const countRedemptions = async (giftRuleId) => {
  const { data, error: dbError } = await supabase
    .from('order_item')
    .select('quantity, order:order_id!inner(is_cancelled)')
    .eq('gift_rule_id', giftRuleId)
    .eq('order.is_cancelled', false)
  if (dbError) throw dbError
  return (data || []).reduce((sum, item) => sum + item.quantity, 0)
}

// 共用庫存池的已兌換數：多個規則可能指到同一個池子（例如「熟食滿200」跟「檔期滿500」
// 都送同一批保溫袋、總共只有 100 個），要把所有指到這個池子的規則兌換數加總，
// 不能只算單一規則自己的；同樣是加總數量而不是筆數
const countPoolRedemptions = async (poolId) => {
  const { data: rules, error: ruleErr } = await supabase.from('gift_rule').select('id').eq('gift_pool_id', poolId)
  if (ruleErr) throw ruleErr
  const ruleIds = (rules || []).map(r => r.id)
  if (!ruleIds.length) return 0
  const { data, error: dbError } = await supabase
    .from('order_item')
    .select('quantity, order:order_id!inner(is_cancelled)')
    .in('gift_rule_id', ruleIds)
    .eq('order.is_cancelled', false)
  if (dbError) throw dbError
  return (data || []).reduce((sum, item) => sum + item.quantity, 0)
}

// 決定一個規則「真正生效」的兌換上限/已兌換數：如果掛在共用庫存池底下，
// 上限跟已兌換數都以池子為準（多個規則共用同一份額度）；否則用規則自己的 max_redemptions
const resolveRedemption = async (rule, poolsById) => {
  if (rule.gift_pool_id) {
    const pool = poolsById[rule.gift_pool_id]
    if (!pool) return { max_redemptions: null, redeemed_count: 0 }
    return { max_redemptions: pool.max_redemptions, redeemed_count: await countPoolRedemptions(pool.id) }
  }
  if (rule.max_redemptions != null) {
    return { max_redemptions: rule.max_redemptions, redeemed_count: await countRedemptions(rule.id) }
  }
  return { max_redemptions: null, redeemed_count: 0 }
}

const fetchPoolsMap = async (storeId) => {
  const { data: pools, error: dbError } = await supabase.from('gift_pool').select('*').eq('store_id', storeId)
  if (dbError) throw dbError
  return Object.fromEntries((pools || []).map(p => [p.id, p]))
}

// 撈出「現在這個當下」對這家店有效的贈品規則（is_enable + 時間窗內），
// 附上巢狀 options 跟已兌換數，可以直接餵給 giftCalculator。
// getCart（預覽）跟 createOrder（下單時重新驗證）共用這支，確保兩邊邏輯一致
const fetchApplicableGiftRules = async (storeId) => {
  const now = new Date().toISOString()
  const { data: rules, error: dbError } = await supabase
    .from('gift_rule')
    .select('*')
    .eq('store_id', storeId)
    .eq('is_enable', true)
    .or(`start_at.is.null,start_at.lte.${now}`)
    .or(`end_at.is.null,end_at.gte.${now}`)
  if (dbError) throw dbError
  if (!rules?.length) return []

  const ruleIds = rules.map(r => r.id)
  const [{ data: options, error: optErr }, poolsById] = await Promise.all([
    supabase.from('gift_rule_option').select('*').in('gift_rule_id', ruleIds),
    fetchPoolsMap(storeId),
  ])
  if (optErr) throw optErr

  return Promise.all(rules.map(async (r) => {
    const { max_redemptions, redeemed_count } = await resolveRedemption(r, poolsById)
    return {
      ...r,
      max_redemptions,
      redeemed_count,
      options: buildOptionTree((options || []).filter(o => o.gift_rule_id === r.id)),
    }
  }))
}

// GET /api/merchant/gift-rules
const getGiftRules = async (req, res, next) => {
  try {
    const { data: rules, error: dbError } = await supabase
      .from('gift_rule')
      .select('*')
      .eq('store_id', req.storeId)
      .order('sort_order')

    if (dbError) throw dbError

    const ruleIds = rules.map(r => r.id)
    let optionsByRule = {}
    if (ruleIds.length > 0) {
      const { data: options, error: optErr } = await supabase
        .from('gift_rule_option')
        .select('*')
        .in('gift_rule_id', ruleIds)
      if (optErr) throw optErr
      optionsByRule = ruleIds.reduce((acc, id) => {
        acc[id] = buildOptionTree((options || []).filter(o => o.gift_rule_id === id))
        return acc
      }, {})
    }

    const poolsById = await fetchPoolsMap(req.storeId)
    const result = await Promise.all(rules.map(async (r) => {
      const { max_redemptions, redeemed_count } = await resolveRedemption(r, poolsById)
      return {
        ...r,
        max_redemptions,
        redeemed_count: (r.gift_pool_id || r.max_redemptions != null) ? redeemed_count : null,
        options: optionsByRule[r.id] || [],
      }
    }))

    return success(res, result)
  } catch (err) {
    next(err)
  }
}

// options 是巢狀陣列（每個可以有 children），扁平化後 insert，先建父節點拿到 id 才能建子節點
const insertOptions = async (giftRuleId, options) => {
  for (let i = 0; i < (options || []).length; i++) {
    const opt = options[i]
    const { data: inserted, error: dbError } = await supabase
      .from('gift_rule_option')
      .insert({
        gift_rule_id: giftRuleId,
        product_id: opt.product_id || null,
        label: opt.label,
        sort_order: i,
      })
      .select()
      .single()
    if (dbError) throw dbError

    if (opt.children?.length) {
      for (let j = 0; j < opt.children.length; j++) {
        const child = opt.children[j]
        const { error: childErr } = await supabase
          .from('gift_rule_option')
          .insert({
            gift_rule_id: giftRuleId,
            parent_option_id: inserted.id,
            product_id: child.product_id || null,
            label: child.label,
            sort_order: j,
          })
        if (childErr) throw childErr
      }
    }
  }
}

const RULE_FIELDS = ['name', 'start_at', 'end_at', 'is_enable', 'campaign_id', 'excluded_category_id', 'threshold_amount', 'max_amount', 'mode', 'qty_per_step', 'max_redemptions', 'gift_pool_id', 'addon_price', 'sort_order']

// POST /api/merchant/gift-rules
const createGiftRule = async (req, res, next) => {
  try {
    const { options, ...body } = req.body
    if (!['flat', 'scaling', 'addon_purchase'].includes(body.mode)) return error(res, 'mode 必須是 flat/scaling/addon_purchase 其中之一', 400)
    if (!options?.length) return error(res, '至少要有一個贈品選項', 400)

    const payload = { store_id: req.storeId }
    RULE_FIELDS.forEach(k => { if (body[k] !== undefined) payload[k] = body[k] === '' ? null : body[k] })
    // 掛在共用庫存池底下時，規則自己的 max_redemptions 沒有意義，避免混淆直接清掉
    if (payload.gift_pool_id) payload.max_redemptions = null

    const { data: rule, error: dbError } = await supabase
      .from('gift_rule')
      .insert(payload)
      .select()
      .single()
    if (dbError) throw dbError

    await insertOptions(rule.id, options)
    return success(res, rule, '贈品規則建立成功', 201)
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/gift-rules/:id
const updateGiftRule = async (req, res, next) => {
  try {
    const { id } = req.params
    const { options, ...body } = req.body

    const updates = {}
    RULE_FIELDS.forEach(k => { if (body[k] !== undefined) updates[k] = body[k] === '' ? null : body[k] })
    if (updates.gift_pool_id) updates.max_redemptions = null
    updates.updated_at = new Date().toISOString()

    const { data: rule, error: dbError } = await supabase
      .from('gift_rule')
      .update(updates)
      .eq('id', id)
      .eq('store_id', req.storeId)
      .select()
      .single()
    if (dbError) throw dbError
    if (!rule) return error(res, '贈品規則不存在', 404)

    // options 用整批刪除重建，不用複雜的差異比對（比照 setProductAddons 的既有作法）
    if (options !== undefined) {
      await supabase.from('gift_rule_option').delete().eq('gift_rule_id', id)
      if (options.length) await insertOptions(id, options)
    }

    return success(res, rule, '贈品規則已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/gift-rules/:id
const deleteGiftRule = async (req, res, next) => {
  try {
    const { id } = req.params

    const redeemedCount = await countRedemptions(id)
    if (redeemedCount > 0) return error(res, '此規則已經有訂單兌換過贈品，不能刪除（可改為停用）', 400)

    const { error: dbError } = await supabase
      .from('gift_rule')
      .delete()
      .eq('id', id)
      .eq('store_id', req.storeId)
    if (dbError) throw dbError

    return success(res, null, '贈品規則已刪除')
  } catch (err) {
    next(err)
  }
}

// ── Gift Pool（多個規則共用同一份贈送額度）─────────────────

// GET /api/merchant/gift-pools
const getGiftPools = async (req, res, next) => {
  try {
    const { data: pools, error: dbError } = await supabase
      .from('gift_pool')
      .select('*')
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false })
    if (dbError) throw dbError

    const result = await Promise.all(pools.map(async (p) => ({
      ...p,
      redeemed_count: await countPoolRedemptions(p.id),
    })))
    return success(res, result)
  } catch (err) {
    next(err)
  }
}

// POST /api/merchant/gift-pools
const createGiftPool = async (req, res, next) => {
  try {
    const { name, max_redemptions } = req.body
    const { data, error: dbError } = await supabase
      .from('gift_pool')
      .insert({ store_id: req.storeId, name, max_redemptions })
      .select()
      .single()
    if (dbError) throw dbError
    return success(res, data, '庫存池建立成功', 201)
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/gift-pools/:id
const updateGiftPool = async (req, res, next) => {
  try {
    const { id } = req.params
    const updates = {}
    if (req.body.name !== undefined) updates.name = req.body.name
    if (req.body.max_redemptions !== undefined) updates.max_redemptions = req.body.max_redemptions
    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('gift_pool')
      .update(updates)
      .eq('id', id)
      .eq('store_id', req.storeId)
      .select()
      .single()
    if (dbError) throw dbError
    if (!data) return error(res, '庫存池不存在', 404)
    return success(res, data, '庫存池已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/gift-pools/:id
const deleteGiftPool = async (req, res, next) => {
  try {
    const { id } = req.params

    const { count: ruleCount } = await supabase
      .from('gift_rule')
      .select('id', { count: 'exact', head: true })
      .eq('gift_pool_id', id)
      .eq('store_id', req.storeId)
    if (ruleCount > 0) return error(res, '仍有贈品規則使用這個庫存池，請先改掉那些規則的設定再刪除', 400)

    const { error: dbError } = await supabase
      .from('gift_pool')
      .delete()
      .eq('id', id)
      .eq('store_id', req.storeId)
    if (dbError) throw dbError
    return success(res, null, '庫存池已刪除')
  } catch (err) {
    next(err)
  }
}

module.exports = {
  getGiftRules, createGiftRule, updateGiftRule, deleteGiftRule,
  getGiftPools, createGiftPool, updateGiftPool, deleteGiftPool,
  countRedemptions, countPoolRedemptions, buildOptionTree, fetchApplicableGiftRules,
}

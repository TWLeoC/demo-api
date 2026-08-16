const supabase = require('../config/supabase')
const { writeAuditLog } = require('../utils/auditLog')
const { success, error, paginate } = require('../utils/response')

// GET /api/merchant/discounts
const getDiscounts = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, is_enable } = req.query
    const from = (page - 1) * limit
    const to = from + Number(limit) - 1

    let query = supabase
      .from('discount_method')
      .select('*', { count: 'exact' })
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (is_enable !== undefined) query = query.eq('is_enable', is_enable === 'true')

    const { data, count, error: dbError } = await query
    if (dbError) throw dbError

    return paginate(res, data, count, page, limit)
  } catch (err) {
    next(err)
  }
}

// GET /api/merchant/discounts/:id
const getDiscount = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('discount_method')
      .select('*')
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .single()

    if (dbError || !data) return error(res, '折扣碼不存在', 404)
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

// POST /api/merchant/discounts
const createDiscount = async (req, res, next) => {
  try {
    const { discount_kol, discount_percent, discount_price, is_enable, expires_at } = req.body

    const { data: existing } = await supabase
      .from('discount_method')
      .select('id')
      .eq('discount_kol', discount_kol)
      .eq('store_id', req.storeId)
      .single()

    if (existing) return error(res, '折扣碼已存在', 409)

    const { data, error: dbError } = await supabase
      .from('discount_method')
      .insert({
        discount_kol,
        discount_percent: discount_percent ?? 1,
        discount_price: discount_price ?? 0,
        is_enable: is_enable ?? true,
        expires_at: expires_at || null,
        store_id: req.storeId,
      })
      .select()
      .single()

    if (dbError) throw dbError
    writeAuditLog(req, 'create_discount', 'discount', data.id, { code: discount_kol })
    return success(res, data, '折扣碼建立成功', 201)
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/discounts/:id
const updateDiscount = async (req, res, next) => {
  try {
    const allowed = ['discount_kol', 'discount_percent', 'discount_price', 'is_enable', 'expires_at']
    const updates = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })
    updates.updated_at = new Date().toISOString()

    if (updates.discount_kol) {
      const { data: existing } = await supabase
        .from('discount_method')
        .select('id')
        .eq('discount_kol', updates.discount_kol)
        .eq('store_id', req.storeId)
        .neq('id', req.params.id)
        .single()
      if (existing) return error(res, '折扣碼已存在', 409)
    }

    const { data, error: dbError } = await supabase
      .from('discount_method')
      .update(updates)
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '折扣碼已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/discounts/:id (hard delete)
const deleteDiscount = async (req, res, next) => {
  try {
    const { id } = req.params

    const { count: orderCount } = await supabase
      .from('order')
      .select('id', { count: 'exact', head: true })
      .eq('discount_id', id)
      .eq('store_id', req.storeId)

    if (orderCount > 0) return error(res, '此優惠碼已被訂單使用，無法刪除（可改為停用）', 400)

    const { error: dbError } = await supabase
      .from('discount_method')
      .delete()
      .eq('id', id)
      .eq('store_id', req.storeId)

    if (dbError) throw dbError
    writeAuditLog(req, 'delete_discount', 'discount', id)
    return success(res, null, '折扣碼已刪除')
  } catch (err) {
    next(err)
  }
}

module.exports = { getDiscounts, getDiscount, createDiscount, updateDiscount, deleteDiscount }

const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')

// GET /api/merchant/payment-methods
const getPaymentMethods = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('payment_method')
      .select('*')
      .eq('store_id', req.storeId)
      .order('id')

    if (dbError) throw dbError
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

// POST /api/merchant/payment-methods
const createPaymentMethod = async (req, res, next) => {
  try {
    const { payment_method } = req.body

    const { data: existing } = await supabase
      .from('payment_method')
      .select('id')
      .eq('payment_method', payment_method)
      .eq('store_id', req.storeId)
      .single()

    if (existing) return error(res, '付款方式已存在', 409)

    const { data, error: dbError } = await supabase
      .from('payment_method')
      .insert({ payment_method, store_id: req.storeId })
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '付款方式建立成功', 201)
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/payment-methods/:id
const updatePaymentMethod = async (req, res, next) => {
  try {
    const { payment_method } = req.body

    const { data: existing } = await supabase
      .from('payment_method')
      .select('id')
      .eq('payment_method', payment_method)
      .eq('store_id', req.storeId)
      .neq('id', req.params.id)
      .single()

    if (existing) return error(res, '付款方式已存在', 409)

    const { data, error: dbError } = await supabase
      .from('payment_method')
      .update({ payment_method, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '付款方式已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/payment-methods/:id
const deletePaymentMethod = async (req, res, next) => {
  try {
    const { count } = await supabase
      .from('order')
      .select('id', { count: 'exact', head: true })
      .eq('payment_method_id', req.params.id)
      .eq('store_id', req.storeId)

    if (count > 0) return error(res, `無法刪除：有 ${count} 筆訂單使用此付款方式`, 409)

    const { error: dbError } = await supabase
      .from('payment_method')
      .delete()
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)

    if (dbError) throw dbError
    return success(res, null, '付款方式已刪除')
  } catch (err) {
    next(err)
  }
}

module.exports = { getPaymentMethods, createPaymentMethod, updatePaymentMethod, deletePaymentMethod }

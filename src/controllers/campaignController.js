const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')

// GET /api/merchant/campaigns
const merchantGetCampaigns = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('campaign')
      .select('*')
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false })

    if (dbError) throw dbError
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

// POST /api/merchant/campaigns
const createCampaign = async (req, res, next) => {
  try {
    const { name, order_start_at, order_end_at, payment_deadline_days, pickup_start_date, pickup_end_date, is_enable } = req.body

    if (pickup_start_date > pickup_end_date) return error(res, '取貨區間結束日期不能早於開始日期', 400)

    const { data, error: dbError } = await supabase
      .from('campaign')
      .insert({
        name,
        order_start_at: order_start_at || null,
        order_end_at: order_end_at || null,
        payment_deadline_days: payment_deadline_days === '' || payment_deadline_days == null ? null : Number(payment_deadline_days),
        pickup_start_date,
        pickup_end_date,
        is_enable: is_enable ?? true,
        store_id: req.storeId,
      })
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '檔期建立成功', 201)
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/campaigns/:id
const updateCampaign = async (req, res, next) => {
  try {
    const allowed = ['name', 'order_start_at', 'order_end_at', 'payment_deadline_days', 'pickup_start_date', 'pickup_end_date', 'is_enable']
    const updates = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })
    if (updates.payment_deadline_days === '') updates.payment_deadline_days = null
    else if (updates.payment_deadline_days != null) updates.payment_deadline_days = Number(updates.payment_deadline_days)

    if (updates.pickup_start_date !== undefined || updates.pickup_end_date !== undefined) {
      const { data: existing, error: fetchErr } = await supabase
        .from('campaign').select('pickup_start_date, pickup_end_date').eq('id', req.params.id).eq('store_id', req.storeId).single()
      if (fetchErr) throw fetchErr
      const finalStart = updates.pickup_start_date ?? existing.pickup_start_date
      const finalEnd = updates.pickup_end_date ?? existing.pickup_end_date
      if (finalStart > finalEnd) return error(res, '取貨區間結束日期不能早於開始日期', 400)
    }

    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('campaign')
      .update(updates)
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '檔期已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/campaigns/:id
const deleteCampaign = async (req, res, next) => {
  try {
    const { id } = req.params

    const { count: productCount } = await supabase
      .from('product')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', id)
      .eq('store_id', req.storeId)
      .is('deleted_at', null)

    if (productCount > 0) return error(res, '此檔期下仍有商品，請先移除商品的檔期關聯再刪除', 400)

    const { error: dbError } = await supabase
      .from('campaign')
      .delete()
      .eq('id', id)
      .eq('store_id', req.storeId)

    if (dbError) throw dbError
    return success(res, null, '檔期已刪除')
  } catch (err) {
    next(err)
  }
}

module.exports = { merchantGetCampaigns, createCampaign, updateCampaign, deleteCampaign }

const supabase = require('../config/supabase')
const { success, error, paginate } = require('../utils/response')

// GET /pickup-slots  (前端用 — 只回今天以後、有開放的時段)
// ?campaign_id= 不帶時只回一般時段（campaign_id is null）；帶了就回該檔期的專屬時段
const getPickupSlots = async (req, res, next) => {
  try {
    const { campaign_id } = req.query
    const today = new Date().toISOString().slice(0, 10)

    let query = supabase
      .from('pickup_slot')
      .select('id, date, start_time, end_time, max_orders, campaign_id')
      .eq('store_id', req.storeId)
      .eq('is_enable', true)
      .gte('date', today)
      .order('date')
      .order('start_time')

    query = campaign_id ? query.eq('campaign_id', campaign_id) : query.is('campaign_id', null)

    const { data, error: dbError } = await query
    if (dbError) throw dbError
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

// GET /api/merchant/pickup-slots  (merchant 看全部，?campaign_id=none 只看一般時段，帶 uuid 只看該檔期)
const merchantGetPickupSlots = async (req, res, next) => {
  try {
    const { page = 1, limit = 30, campaign_id } = req.query
    const from = (page - 1) * limit
    const to = from + Number(limit) - 1

    let query = supabase
      .from('pickup_slot')
      .select('*', { count: 'exact' })
      .eq('store_id', req.storeId)
      .order('date')
      .order('start_time')
      .range(from, to)

    if (campaign_id === 'none') query = query.is('campaign_id', null)
    else if (campaign_id) query = query.eq('campaign_id', campaign_id)

    const { data, count, error: dbError } = await query
    if (dbError) throw dbError
    return paginate(res, data, count, page, limit)
  } catch (err) {
    next(err)
  }
}

// POST /api/merchant/pickup-slots
const createPickupSlot = async (req, res, next) => {
  try {
    const { date, start_time, end_time, max_orders, is_enable, campaign_id } = req.body

    if (start_time >= end_time) return error(res, 'end_time 必須大於 start_time', 400)

    const { data, error: dbError } = await supabase
      .from('pickup_slot')
      .insert({ date, start_time, end_time, max_orders: max_orders || 20, is_enable: is_enable ?? true, campaign_id: campaign_id || null, store_id: req.storeId })
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '時段建立成功', 201)
  } catch (err) {
    next(err)
  }
}

// POST /api/merchant/pickup-slots/batch  (批次建立多個時段)
const batchCreatePickupSlots = async (req, res, next) => {
  try {
    const { slots } = req.body
    if (!Array.isArray(slots) || !slots.length) return error(res, '請提供時段陣列', 400)

    const invalid = slots.find(s => s.start_time >= s.end_time)
    if (invalid) return error(res, `時段 ${invalid.date} end_time 必須大於 start_time`, 400)

    const inserts = slots.map(s => ({
      date: s.date,
      start_time: s.start_time,
      end_time: s.end_time,
      max_orders: s.max_orders || 20,
      is_enable: s.is_enable ?? true,
      campaign_id: s.campaign_id || null,
      store_id: req.storeId,
    }))

    const { data, error: dbError } = await supabase
      .from('pickup_slot')
      .upsert(inserts, { onConflict: 'store_id,date,start_time,campaign_id' })
      .select()

    if (dbError) throw dbError
    return success(res, data, `已建立 ${data.length} 個時段`, 201)
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/pickup-slots/:id
const updatePickupSlot = async (req, res, next) => {
  try {
    const allowed = ['date', 'start_time', 'end_time', 'max_orders', 'is_enable', 'campaign_id']
    const updates = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })
    if (updates.campaign_id === '') updates.campaign_id = null

    if (updates.start_time !== undefined || updates.end_time !== undefined) {
      const { data: existing, error: fetchErr } = await supabase
        .from('pickup_slot').select('start_time, end_time').eq('id', req.params.id).eq('store_id', req.storeId).single()
      if (fetchErr) throw fetchErr
      const finalStart = updates.start_time ?? existing.start_time
      const finalEnd = updates.end_time ?? existing.end_time
      if (finalStart >= finalEnd) return error(res, 'end_time 必須大於 start_time', 400)
    }

    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('pickup_slot')
      .update(updates)
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '時段已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/pickup-slots/:id
const deletePickupSlot = async (req, res, next) => {
  try {
    const { error: dbError } = await supabase
      .from('pickup_slot')
      .delete()
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)

    if (dbError) throw dbError
    return success(res, null, '時段已刪除')
  } catch (err) {
    next(err)
  }
}

module.exports = { getPickupSlots, merchantGetPickupSlots, createPickupSlot, batchCreatePickupSlots, updatePickupSlot, deletePickupSlot }

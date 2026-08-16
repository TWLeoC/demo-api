const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')

// GET /receivers
const getReceivers = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('receiver')
      .select('*')
      .eq('user_id', req.user.id)
      .order('is_default', { ascending: false })

    if (dbError) throw dbError
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

// POST /receivers
const createReceiver = async (req, res, next) => {
  try {
    const { name, phone, post_code, address, is_default } = req.body
    const userId = req.user.id

    if (is_default) {
      await supabase.from('receiver').update({ is_default: false }).eq('user_id', userId)
    }

    const { data, error: dbError } = await supabase
      .from('receiver')
      .insert({ user_id: userId, name, phone, post_code, address, is_default: is_default || false })
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '收件人已新增', 201)
  } catch (err) {
    next(err)
  }
}

// PATCH /receivers/:id
const updateReceiver = async (req, res, next) => {
  try {
    const { id } = req.params
    const { name, phone, post_code, address, is_default } = req.body
    const userId = req.user.id

    if (is_default) {
      await supabase.from('receiver').update({ is_default: false }).eq('user_id', userId)
    }

    const updates = {}
    if (name !== undefined) updates.name = name
    if (phone !== undefined) updates.phone = phone
    if (post_code !== undefined) updates.post_code = post_code
    if (address !== undefined) updates.address = address
    if (is_default !== undefined) updates.is_default = is_default
    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('receiver')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '收件人已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /receivers/:id
const deleteReceiver = async (req, res, next) => {
  try {
    const { id } = req.params
    const { error: dbError } = await supabase
      .from('receiver')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id)

    if (dbError) throw dbError
    return success(res, null, '收件人已刪除')
  } catch (err) {
    next(err)
  }
}

module.exports = { getReceivers, createReceiver, updateReceiver, deleteReceiver }

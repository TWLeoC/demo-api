const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')

const getAddons = async (req, res, next) => {
  try {
    const { product_id } = req.query

    let data, dbError
    if (product_id) {
      // product_id 是客戶端傳入的，一定要先確認這個商品真的屬於目前這個商家，
      // 不然帶別家商家的 product_id 就能撈到別家商家的加購項目名稱/價格（IDOR）
      const { data: product } = await supabase.from('product').select('id').eq('id', product_id).eq('store_id', req.storeId).single()
      if (!product) return success(res, [])

      const res2 = await supabase
        .from('product_addon')
        .select('addon ( id, type, name, price, sort_order, is_enable )')
        .eq('product_id', product_id)
      dbError = res2.error
      data = (res2.data || []).map(r => r.addon).filter(a => a?.is_enable)
    } else {
      const res2 = await supabase
        .from('addon')
        .select('*')
        .eq('store_id', req.storeId)
        .eq('is_enable', true)
        .order('sort_order')
      dbError = res2.error
      data = res2.data
    }

    if (dbError) throw dbError
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

const getProductAddons = async (req, res, next) => {
  try {
    const { id } = req.params
    const { data: product } = await supabase.from('product').select('id').eq('id', id).eq('store_id', req.storeId).single()
    if (!product) return error(res, '商品不存在', 404)

    const { data, error: dbError } = await supabase
      .from('product_addon')
      .select('addon ( id, type, name, price, sort_order, is_enable )')
      .eq('product_id', id)
    if (dbError) throw dbError
    return success(res, (data || []).map(r => r.addon).filter(Boolean))
  } catch (err) {
    next(err)
  }
}

const setProductAddons = async (req, res, next) => {
  try {
    const { id } = req.params
    const { addon_ids } = req.body
    const { data: product } = await supabase.from('product').select('id').eq('id', id).eq('store_id', req.storeId).single()
    if (!product) return error(res, '商品不存在', 404)

    await supabase.from('product_addon').delete().eq('product_id', id)
    if (addon_ids.length) {
      const inserts = addon_ids.map(addon_id => ({ product_id: id, addon_id }))
      const { error: dbError } = await supabase.from('product_addon').insert(inserts)
      if (dbError) throw dbError
    }
    return success(res, null, '加購選項已更新')
  } catch (err) {
    next(err)
  }
}

const merchantGetAddons = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('addon')
      .select('*')
      .eq('store_id', req.storeId)
      .order('sort_order')

    if (dbError) throw dbError
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

const createAddon = async (req, res, next) => {
  try {
    const { type, name, price, sort_order } = req.body
    const { data, error: dbError } = await supabase
      .from('addon')
      .insert({ type, name, price: price || 0, sort_order: sort_order || 0, store_id: req.storeId })
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '加購項目建立成功', 201)
  } catch (err) {
    next(err)
  }
}

const updateAddon = async (req, res, next) => {
  try {
    const { id } = req.params
    const allowed = ['type', 'name', 'price', 'sort_order', 'is_enable']
    const updates = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })
    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('addon')
      .update(updates)
      .eq('id', id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '加購項目已更新')
  } catch (err) {
    next(err)
  }
}

const deleteAddon = async (req, res, next) => {
  try {
    const { id } = req.params

    const { count: productCount } = await supabase
      .from('product_addon')
      .select('id', { count: 'exact', head: true })
      .eq('addon_id', id)

    if (productCount > 0) return error(res, '此選項已連結商品，請先解除連結再刪除', 400)

    const { error: dbError } = await supabase
      .from('addon')
      .delete()
      .eq('id', id)
      .eq('store_id', req.storeId)

    if (dbError) throw dbError
    return success(res, null, '加購項目已刪除')
  } catch (err) {
    next(err)
  }
}

module.exports = { getAddons, merchantGetAddons, createAddon, updateAddon, deleteAddon, getProductAddons, setProductAddons }

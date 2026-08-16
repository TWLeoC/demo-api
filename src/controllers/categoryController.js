const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')

const getCategories = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('product_category')
      .select('id, name, sort_order, is_enable')
      .eq('store_id', req.storeId)
      .eq('is_enable', true)
      .order('sort_order')

    if (dbError) throw dbError
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

const merchantGetCategories = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('product_category')
      .select('id, name, sort_order, is_enable, created_at, updated_at')
      .eq('store_id', req.storeId)
      .order('sort_order')

    if (dbError) throw dbError
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

const createCategory = async (req, res, next) => {
  try {
    const { name, sort_order } = req.body
    const { data, error: dbError } = await supabase
      .from('product_category')
      .insert({ name, sort_order: sort_order || 0, store_id: req.storeId })
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '分類建立成功', 201)
  } catch (err) {
    next(err)
  }
}

const updateCategory = async (req, res, next) => {
  try {
    const allowed = ['name', 'sort_order', 'is_enable']
    const updates = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })
    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('product_category')
      .update(updates)
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    return success(res, data, '分類已更新')
  } catch (err) {
    next(err)
  }
}

const deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params

    const { count: productCount } = await supabase
      .from('product')
      .select('id', { count: 'exact', head: true })
      .eq('category_id', id)
      .eq('store_id', req.storeId)
      .is('deleted_at', null)

    if (productCount > 0) return error(res, '此分類下仍有商品，請先移除商品再刪除', 400)

    const { error: dbError } = await supabase
      .from('product_category')
      .delete()
      .eq('id', id)
      .eq('store_id', req.storeId)

    if (dbError) throw dbError
    return success(res, null, '分類已刪除')
  } catch (err) {
    next(err)
  }
}

const getCategoryAddons = async (req, res, next) => {
  try {
    const { id } = req.params
    const { data: category } = await supabase.from('product_category').select('id').eq('id', id).eq('store_id', req.storeId).single()
    if (!category) return error(res, '分類不存在', 404)

    const { data, error: dbError } = await supabase
      .from('category_addon')
      .select('addon ( id, type, name, price, sort_order, is_enable )')
      .eq('category_id', id)

    if (dbError) throw dbError
    return success(res, (data || []).map(r => r.addon))
  } catch (err) {
    next(err)
  }
}

const setCategoryAddons = async (req, res, next) => {
  try {
    const { id } = req.params
    const { addon_ids = [] } = req.body
    const { data: category } = await supabase.from('product_category').select('id').eq('id', id).eq('store_id', req.storeId).single()
    if (!category) return error(res, '分類不存在', 404)

    await supabase.from('category_addon').delete().eq('category_id', id)

    if (addon_ids.length) {
      const inserts = addon_ids.map(addon_id => ({ category_id: id, addon_id }))
      const { error: dbError } = await supabase.from('category_addon').insert(inserts)
      if (dbError) throw dbError
    }

    return success(res, null, '加購選項已更新')
  } catch (err) {
    next(err)
  }
}

module.exports = { getCategories, merchantGetCategories, createCategory, updateCategory, deleteCategory, getCategoryAddons, setCategoryAddons }

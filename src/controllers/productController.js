const supabase = require('../config/supabase')
const { success, error, paginate } = require('../utils/response')
const { writeAuditLog } = require('../utils/auditLog')

// GET /products
const getProducts = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, is_enable, category_id } = req.query
    const from = (page - 1) * limit
    const to = from + Number(limit) - 1

    let query = supabase
      .from('product')
      .select('id, product_code, name, description, origin_price, price, cost, stock, primary_image_url, is_enable, is_pre_listed, advance_days, requires_payment_confirmation, category_id, campaign_id, created_at', { count: 'exact' })
      .eq('store_id', req.storeId)
      .is('deleted_at', null)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(from, to)

    if (is_enable !== undefined) {
      if (is_enable === 'true') {
        // Also include pre-listed products for the frontend menu
        query = query.or('is_enable.eq.true,is_pre_listed.eq.true')
      } else {
        query = query.eq('is_enable', false).eq('is_pre_listed', false)
      }
    }
    if (category_id) query = query.eq('category_id', category_id)

    const { data, count, error: dbError } = await query
    if (dbError) throw dbError

    const withCampaigns = await attachCampaigns(data)
    return paginate(res, withCampaigns, count, page, limit)
  } catch (err) {
    next(err)
  }
}

// 手動 map-fetch 檔期資訊，比照 category_id 的既有作法（不用 embedded select）
const attachCampaigns = async (products) => {
  const campaignIds = [...new Set(products.map(p => p.campaign_id).filter(Boolean))]
  if (!campaignIds.length) return products

  const { data: campaigns } = await supabase
    .from('campaign')
    .select('id, name, order_start_at, order_end_at, payment_deadline_days, pickup_start_date, pickup_end_date, is_enable')
    .in('id', campaignIds)
  const campaignMap = Object.fromEntries((campaigns || []).map(c => [c.id, c]))

  return products.map(p => ({ ...p, campaign: p.campaign_id ? campaignMap[p.campaign_id] || null : null }))
}

// GET /products/:id
const getProduct = async (req, res, next) => {
  try {
    const { id } = req.params
    const { data, error: dbError } = await supabase
      .from('product')
      .select(`
        id, product_code, name, description, origin_price, price, cost, stock, primary_image_url, is_enable, is_pre_listed, advance_days, requires_payment_confirmation, category_id, campaign_id, created_at, updated_at,
        product_image ( id, url, sort_order, is_primary ),
        product_addon ( addon ( id, type, name, price, sort_order ) )
      `)
      .eq('id', id)
      .eq('store_id', req.storeId)
      .is('deleted_at', null)
      .single()

    if (dbError || !data) return error(res, '商品不存在', 404)
    const [withCampaign] = await attachCampaigns([data])
    return success(res, withCampaign)
  } catch (err) {
    next(err)
  }
}

// POST /products (merchant)
const createProduct = async (req, res, next) => {
  try {
    const { product_code, name, description, origin_price, price, cost, stock, unlimited_stock, primary_image_url, is_enable, category_id, requires_payment_confirmation, campaign_id } = req.body
    const stockVal = unlimited_stock ? null : (stock !== undefined && stock !== '' ? Number(stock) : 0)

    const { data: product, error: dbError } = await supabase
      .from('product')
      .insert({
        product_code, name, description: description || null,
        origin_price: origin_price != null && origin_price !== '' ? Number(origin_price) : Number(price),
        price,
        cost: cost !== undefined && cost !== '' ? Number(cost) : null,
        stock: stockVal, primary_image_url,
        is_enable: is_enable ?? true,
        category_id: category_id || null,
        requires_payment_confirmation: requires_payment_confirmation ?? false,
        campaign_id: campaign_id || null,
        store_id: req.storeId,
      })
      .select()
      .single()

    if (dbError) throw dbError
    writeAuditLog(req, 'create_product', 'product', product.id, { name: product.name })
    return success(res, product, '商品建立成功', 201)
  } catch (err) {
    next(err)
  }
}

// PATCH /products/:id (merchant)
const updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params
    const allowed = ['product_code', 'name', 'description', 'origin_price', 'price', 'cost', 'primary_image_url', 'is_enable', 'is_pre_listed', 'advance_days', 'requires_payment_confirmation', 'category_id', 'campaign_id', 'sort_order']
    const updates = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })
    if (updates.campaign_id === '') updates.campaign_id = null

    if (req.body.unlimited_stock) {
      updates.stock = null
    } else if (req.body.stock !== undefined) {
      updates.stock = req.body.stock !== '' ? Number(req.body.stock) : 0
    }

    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('product')
      .update(updates)
      .eq('id', id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    const action = updates.is_enable === true ? 'enable_product' : updates.is_enable === false ? 'disable_product' : 'update_product'
    writeAuditLog(req, action, 'product', id, { name: data.name, updates })
    return success(res, data, '商品更新成功')
  } catch (err) {
    next(err)
  }
}

// DELETE /products/:id (merchant — soft delete)
const deleteProduct = async (req, res, next) => {
  try {
    const { id } = req.params

    const { count: orderCount } = await supabase
      .from('order_item')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', id)

    if (orderCount > 0) return error(res, '此商品已有訂單紀錄，無法刪除（可改為下架）', 400)

    const { error: dbError } = await supabase
      .from('product')
      .update({ deleted_at: new Date().toISOString(), is_enable: false })
      .eq('id', id)
      .eq('store_id', req.storeId)

    if (dbError) throw dbError
    writeAuditLog(req, 'delete_product', 'product', id)
    return success(res, null, '商品已刪除')
  } catch (err) {
    next(err)
  }
}

// PATCH /products/reorder (merchant) — 批次更新 sort_order
const reorderProducts = async (req, res, next) => {
  try {
    const items = req.body // [{ id, sort_order }]
    if (!Array.isArray(items) || items.length === 0) return error(res, '請提供排序資料', 400)

    await Promise.all(
      items.map(({ id, sort_order }) =>
        supabase.from('product').update({ sort_order }).eq('id', id).eq('store_id', req.storeId)
      )
    )
    return success(res, null, '排序已更新')
  } catch (err) {
    next(err)
  }
}

module.exports = { getProducts, getProduct, createProduct, updateProduct, deleteProduct, reorderProducts }

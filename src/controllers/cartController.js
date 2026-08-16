const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')
const { fetchApplicableGiftRules } = require('./giftRuleController')
const { calculateGiftEligibility } = require('../utils/giftCalculator')

const getOrCreateCart = async (userId, storeId) => {
  let { data: cart } = await supabase
    .from('cart').select('*')
    .eq('user_id', userId).eq('store_id', storeId)
    .single()
  if (!cart) {
    const { data: newCart, error: e } = await supabase
      .from('cart').insert({ user_id: userId, store_id: storeId }).select().single()
    if (e) throw e
    cart = newCart
  }
  return cart
}

const getCart = async (req, res, next) => {
  try {
    const cart = await getOrCreateCart(req.user.id, req.storeId)

    const { data: items, error: dbError } = await supabase
      .from('cart_item')
      .select(`
        id, quantity, note, created_at,
        product ( id, name, price, primary_image_url, stock, requires_payment_confirmation, campaign_id, category_id ),
        cart_item_addon ( addon ( id, type, name, price ) )
      `)
      .eq('cart_id', cart.id)

    if (dbError) throw dbError

    // 手動 map-fetch 檔期的付款期限，讓前端結帳前能提醒顧客（比照 category_id 的既有作法）
    const campaignIds = [...new Set((items || []).map(i => i.product?.campaign_id).filter(Boolean))]
    let campaignMap = {}
    if (campaignIds.length > 0) {
      const { data: campaigns } = await supabase
        .from('campaign')
        .select('id, name, payment_deadline_days')
        .in('id', campaignIds)
      campaignMap = Object.fromEntries((campaigns || []).map(c => [c.id, c]))
    }
    const itemsWithCampaign = (items || []).map(i => ({
      ...i,
      product: { ...i.product, campaign: i.product?.campaign_id ? campaignMap[i.product.campaign_id] || null : null },
    }))

    let discount = null
    if (cart.discount_id) {
      const { data: d } = await supabase
        .from('discount_method')
        .select('id, discount_kol, discount_percent, discount_price')
        .eq('id', cart.discount_id)
        .single()
      discount = d || null
    }

    // 贈品資格預覽：購物車混單已經在 addItem 擋掉，整車 campaign_id 必然一致
    let giftEligibility = []
    if (items?.length) {
      const cartCampaignId = items[0].product?.campaign_id ?? null
      const cartItemsForGift = items.map(i => {
        const addonTotal = (i.cart_item_addon || []).reduce((s, a) => s + (a.addon?.price || 0), 0)
        return {
          product_id: i.product?.id,
          category_id: i.product?.category_id ?? null,
          campaign_id: i.product?.campaign_id ?? null,
          quantity: i.quantity,
          unit_price: (i.product?.price || 0) + addonTotal,
        }
      })
      const rules = await fetchApplicableGiftRules(req.storeId)
      giftEligibility = calculateGiftEligibility({ cartItems: cartItemsForGift, campaignId: cartCampaignId, rules })
    }

    return success(res, { cart_id: cart.id, discount_id: cart.discount_id, discount, items: itemsWithCampaign, gift_eligibility: giftEligibility })
  } catch (err) {
    next(err)
  }
}

const addItem = async (req, res, next) => {
  try {
    const { product_id, quantity = 1, addon_ids = [], note = null } = req.body
    const cart = await getOrCreateCart(req.user.id, req.storeId)

    const { data: product } = await supabase
      .from('product')
      .select('id, stock, is_enable, campaign_id')
      .eq('id', product_id)
      .eq('store_id', req.storeId)
      .is('deleted_at', null)
      .single()

    if (!product || !product.is_enable) return error(res, '商品不存在', 404)
    if (product.stock !== null && product.stock < quantity) return error(res, '庫存不足', 400)

    // 檔期商品：檢查檔期是否開放預購（is_enable + 預購時間視窗）
    if (product.campaign_id) {
      const { data: campaign } = await supabase
        .from('campaign')
        .select('is_enable, order_start_at, order_end_at')
        .eq('id', product.campaign_id)
        .single()

      if (!campaign || !campaign.is_enable) return error(res, '此檔期目前未開放預購', 400)
      const now = new Date()
      if (campaign.order_start_at && now < new Date(campaign.order_start_at)) return error(res, '此檔期尚未開賣', 400)
      if (campaign.order_end_at && now > new Date(campaign.order_end_at)) return error(res, '此檔期預購已截止', 400)
    }

    // 購物車不能混合不同檔期／一般商品（避免一張訂單要對應多組取貨區間）
    const { data: existingItems } = await supabase
      .from('cart_item')
      .select('product ( campaign_id )')
      .eq('cart_id', cart.id)

    const incomingCampaignId = product.campaign_id ?? null
    const hasMismatch = (existingItems || []).some(ci => (ci.product?.campaign_id ?? null) !== incomingCampaignId)
    if (hasMismatch) return error(res, '購物車內已有其他檔期／一般商品，請先結清目前購物車', 400)

    // 同一個商品但備註或加購選項不同（例如切片盒裝 vs 不切）要視為不同購物車項目，
    // 不能只用 product_id 比對合併，否則後加入的備註/加購選項會被默默蓋掉、
    // 數量卻被錯誤加總在一起（結帳畫面因此顯示成單一種選項的總數量）
    const sortedAddonIds = [...addon_ids].sort()
    const { data: candidates } = await supabase
      .from('cart_item')
      .select('id, quantity, note, cart_item_addon(addon_id)')
      .eq('cart_id', cart.id)
      .eq('product_id', product_id)

    const existing = (candidates || []).find(c => {
      const cAddonIds = (c.cart_item_addon || []).map(a => a.addon_id).sort()
      return (c.note || null) === (note || null)
        && JSON.stringify(cAddonIds) === JSON.stringify(sortedAddonIds)
    })

    let itemId
    if (existing) {
      await supabase.from('cart_item').update({ quantity: existing.quantity + quantity, updated_at: new Date().toISOString() }).eq('id', existing.id)
      itemId = existing.id
    } else {
      const { data: newItem, error: e } = await supabase
        .from('cart_item')
        .insert({ cart_id: cart.id, product_id, quantity, note })
        .select()
        .single()
      if (e) throw e
      itemId = newItem.id
    }

    if (addon_ids.length) {
      const addonLinks = addon_ids.map(addon_id => ({ cart_item_id: itemId, addon_id }))
      await supabase.from('cart_item_addon').upsert(addonLinks, { onConflict: 'cart_item_id,addon_id' })
    }

    return success(res, null, '已加入購物車', 201)
  } catch (err) {
    next(err)
  }
}

const updateItem = async (req, res, next) => {
  try {
    const { itemId } = req.params
    const { quantity } = req.body
    const cart = await getOrCreateCart(req.user.id, req.storeId)

    if (quantity <= 0) {
      await supabase.from('cart_item').delete().eq('id', itemId).eq('cart_id', cart.id)
      return success(res, null, '已移除商品')
    }

    const { error: dbError } = await supabase
      .from('cart_item')
      .update({ quantity, updated_at: new Date().toISOString() })
      .eq('id', itemId)
      .eq('cart_id', cart.id)

    if (dbError) throw dbError
    return success(res, null, '購物車已更新')
  } catch (err) {
    next(err)
  }
}

const removeItem = async (req, res, next) => {
  try {
    const { itemId } = req.params
    const cart = await getOrCreateCart(req.user.id, req.storeId)

    const { error: dbError } = await supabase
      .from('cart_item')
      .delete()
      .eq('id', itemId)
      .eq('cart_id', cart.id)

    if (dbError) throw dbError
    return success(res, null, '已移除')
  } catch (err) {
    next(err)
  }
}

const applyDiscount = async (req, res, next) => {
  try {
    const { code } = req.body
    const cart = await getOrCreateCart(req.user.id, req.storeId)

    const { data: discount } = await supabase
      .from('discount_method')
      .select('*')
      .eq('discount_kol', code)
      .eq('store_id', req.storeId)
      .eq('is_enable', true)
      .single()

    if (!discount) return error(res, '折扣碼無效', 400)
    if (discount.expires_at && new Date(discount.expires_at) < new Date()) return error(res, '折扣碼已過期', 400)

    await supabase.from('cart').update({ discount_id: discount.id }).eq('id', cart.id)
    return success(res, { discount_percent: discount.discount_percent, discount_price: discount.discount_price }, '折扣碼套用成功')
  } catch (err) {
    next(err)
  }
}

module.exports = { getCart, addItem, updateItem, removeItem, applyDiscount }

const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')

// GET /api/merchant/ad-settings
const getAdSettings = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('store')
      .select('ad_enabled, ad_image_url, ad_text')
      .eq('id', req.storeId)
      .single()

    if (dbError || !data) return error(res, '找不到店家資料', 404)

    return success(res, {
      ad_enabled: data.ad_enabled ?? false,
      ad_image_url: data.ad_image_url || '',
      ad_text: data.ad_text || '',
    })
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/ad-settings
const updateAdSettings = async (req, res, next) => {
  try {
    const allowed = ['ad_enabled', 'ad_image_url', 'ad_text']
    const updates = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })

    if (Object.keys(updates).length === 0) return error(res, '沒有可更新的欄位', 400)

    const { error: dbError } = await supabase
      .from('store')
      .update(updates)
      .eq('id', req.storeId)

    if (dbError) throw dbError
    return success(res, null, '設定已儲存')
  } catch (err) {
    next(err)
  }
}

module.exports = { getAdSettings, updateAdSettings }

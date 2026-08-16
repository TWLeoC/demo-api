const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')
const { encrypt } = require('../utils/secretEncryption')

// GET /api/merchant/newebpay-settings
const getNewebpaySettings = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('store')
      .select('newebpay_enabled, newebpay_custom_allowed, newebpay_mode, newebpay_merchant_id, newebpay_hash_key, newebpay_hash_iv')
      .eq('id', req.storeId)
      .single()

    if (dbError || !data) return error(res, '找不到店家資料', 404)

    return success(res, {
      enabled: data.newebpay_enabled ?? false,
      custom_allowed: data.newebpay_custom_allowed ?? false,
      mode: data.newebpay_mode || 'platform',
      merchant_id: data.newebpay_merchant_id || '',
      hash_key_set: !!data.newebpay_hash_key,
      hash_iv_set: !!data.newebpay_hash_iv,
    })
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/newebpay-settings
// enabled/custom_allowed 是 平台專屬開關，商家這支 API 不能自己打開
const updateNewebpaySettings = async (req, res, next) => {
  try {
    const { mode, merchant_id, hash_key, hash_iv } = req.body
    const updates = {}

    if (mode !== undefined) {
      if (!['platform', 'custom'].includes(mode)) return error(res, 'mode 必須是 platform 或 custom', 400)
      if (mode === 'custom') {
        const { data: store } = await supabase.from('store').select('newebpay_custom_allowed').eq('id', req.storeId).single()
        if (!store?.newebpay_custom_allowed) return error(res, '尚未開通自訂藍新帳號權限，請聯繫平台', 403)
      }
      updates.newebpay_mode = mode
    }
    if (merchant_id !== undefined) updates.newebpay_merchant_id = merchant_id
    // 空字串不覆蓋，避免前端遮罩值把已存的金鑰洗掉；HashKey/HashIV 是藍新的加解密
    // 憑證本身，不能以明碼存進資料庫，寫入前一律加密（AES-256-GCM）
    if (hash_key) updates.newebpay_hash_key = encrypt(hash_key)
    if (hash_iv) updates.newebpay_hash_iv = encrypt(hash_iv)

    if (Object.keys(updates).length === 0) return error(res, '沒有可更新的欄位', 400)

    const { error: dbError } = await supabase.from('store').update(updates).eq('id', req.storeId)
    if (dbError) throw dbError
    return success(res, null, '設定已儲存')
  } catch (err) {
    next(err)
  }
}

module.exports = { getNewebpaySettings, updateNewebpaySettings }

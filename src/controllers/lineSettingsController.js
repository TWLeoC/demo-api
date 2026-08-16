const crypto = require('crypto')
const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')

// GET /api/merchant/line-settings
const getLineSettings = async (req, res, next) => {
  try {
    let { data, error: dbError } = await supabase
      .from('store')
      .select('line_bot_enabled, line_notify_target, webhook_token')
      .eq('id', req.storeId)
      .single()

    if (dbError || !data) return error(res, '找不到店家資料', 404)

    // Auto-generate webhook_token if missing
    if (!data.webhook_token) {
      const token = crypto.randomBytes(24).toString('hex')
      const { error: updateErr } = await supabase
        .from('store')
        .update({ webhook_token: token })
        .eq('id', req.storeId)
      if (!updateErr) data.webhook_token = token
    }

    return success(res, {
      line_bot_enabled: data.line_bot_enabled ?? false,
      line_notify_target: data.line_notify_target || '',
      webhook_token: data.webhook_token || '',
      line_bot_basic_id: process.env.LINE_BOT_BASIC_ID || '',
    })
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/line-settings
const updateLineSettings = async (req, res, next) => {
  try {
    const allowed = ['line_bot_enabled', 'line_notify_target']
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

module.exports = { getLineSettings, updateLineSettings }

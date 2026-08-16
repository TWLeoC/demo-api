const supabase = require('../config/supabase')

async function writeAuditLog(req, action, targetType = null, targetId = null, detail = {}) {
  try {
    await supabase.from('merchant_audit_log').insert({
      store_id: req.storeId || null,
      admin_id: req.user?.id || null,
      admin_phone: req.user?.phone || null,
      action,
      target_type: targetType,
      target_id: targetId != null ? String(targetId) : null,
      detail: Object.keys(detail).length > 0 ? detail : null,
      ip: req.ip || null,
    })
  } catch (err) {
    console.error('[AuditLog] 寫入失敗:', err.message)
  }
}

module.exports = { writeAuditLog }

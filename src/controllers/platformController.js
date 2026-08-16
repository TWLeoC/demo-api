const { randomUUID } = require('crypto')
const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')
const { sendHealthStatus, invalidateAlertConfig } = require('../services/alertService')
const ipBlacklist = require('../middlewares/ipBlacklist')
const { PLAN_TIERS, getPlanFeatures, savePlanFeatures, applyPlanTierToStoreUpdates } = require('../utils/planFeatures')

// GET /api/platform/logs/summary?hours=1&store_id=xxx
const getSummary = async (req, res, next) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 1, 168)
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

    let query = supabase
      .from('api_log')
      .select('status, latency_ms')
      .gte('created_at', since)

    if (req.query.store_id) query = query.eq('store_id', req.query.store_id)

    const { data, error: dbError } = await query
    if (dbError) throw dbError

    const total = data.length
    const errors = data.filter(r => r.status >= 400).length
    const serverErrors = data.filter(r => r.status >= 500).length
    const avgLatency = total > 0
      ? Math.round(data.reduce((s, r) => s + r.latency_ms, 0) / total)
      : 0
    const errorRate = total > 0 ? ((errors / total) * 100).toFixed(1) : '0.0'

    return success(res, { total, errors, serverErrors, avgLatency, errorRate: Number(errorRate) })
  } catch (err) {
    next(err)
  }
}

// GET /api/platform/logs/timeline?hours=24&store_id=xxx
const getTimeline = async (req, res, next) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 24, 168)
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

    let query = supabase
      .from('api_log')
      .select('status, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true })

    if (req.query.store_id) query = query.eq('store_id', req.query.store_id)

    const { data, error: dbError } = await query
    if (dbError) throw dbError

    // 依小時分組（台灣時間 UTC+8）
    const TZ_OFFSET = 8 * 60 * 60 * 1000
    const toTWKey = (ms) => {
      const t = new Date(ms + TZ_OFFSET)
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')} ${String(t.getUTCHours()).padStart(2, '0')}:00`
    }

    const buckets = {}
    for (let i = hours - 1; i >= 0; i--) {
      const key = toTWKey(Date.now() - i * 60 * 60 * 1000)
      buckets[key] = { time: key, total: 0, errors: 0 }
    }

    for (const row of data) {
      const key = toTWKey(new Date(row.created_at).getTime())
      if (buckets[key]) {
        buckets[key].total++
        if (row.status >= 400) buckets[key].errors++
      }
    }

    return success(res, Object.values(buckets))
  } catch (err) {
    next(err)
  }
}

// GET /api/platform/logs/recent?limit=50&store_id=xxx
const getRecent = async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200)

    let query = supabase
      .from('api_log')
      .select('id, store_id, method, path, status, latency_ms, ip, created_at')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (req.query.store_id) query = query.eq('store_id', req.query.store_id)

    const { data, error: dbError } = await query
    if (dbError) throw dbError

    return success(res, data)
  } catch (err) {
    next(err)
  }
}

// POST /api/platform/stores
const createStore = async (req, res, next) => {
  try {
    const { name, slug } = req.body
    if (!name?.trim()) return error(res, '商家名稱為必填', 400)
    if (!slug?.trim()) return error(res, 'Slug 為必填', 400)
    if (!/^[a-z0-9-]+$/.test(slug.trim())) return error(res, 'Slug 只能包含小寫英文、數字與連字號', 400)

    const { data, error: dbError } = await supabase
      .from('store')
      .insert({ name: name.trim(), slug: slug.trim(), status: 'active', webhook_token: randomUUID() })
      .select('id, name, status')
      .single()

    if (dbError) throw dbError
    return success(res, data, '商家已建立', 201)
  } catch (err) {
    next(err)
  }
}

// GET /api/platform/stores
const getStores = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('store')
      .select('id, name, slug, status, line_bot_enabled, line_notify_target, line_channel_access_token, line_channel_secret, line_login_enabled, line_login_channel_id, line_login_channel_secret, line_login_redirect_uri, phone_login_enabled, printer_enabled, printer_user, printer_pass, printer_paper_width, customer_notify_enabled, webhook_token, billing_plan, billing_monthly_fee, billing_setup_fee, billing_commission_type, billing_commission_value, frontend_url, newebpay_enabled, newebpay_custom_allowed, newebpay_mode, newebpay_merchant_id, newebpay_hash_key, newebpay_hash_iv')

    if (dbError) throw dbError

    const stores = (data || []).map(s => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      status: s.status ?? 'active',
      webhook_token: s.webhook_token,
      frontend_url: s.frontend_url || '',
      settings: storeToSettings(s),
    }))

    return success(res, stores)
  } catch (err) {
    next(err)
  }
}

// GET /api/platform/stores/:id
const getStore = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('store')
      .select('id, name, status, line_bot_enabled, line_notify_target, line_channel_access_token, line_channel_secret, line_login_enabled, line_login_channel_id, line_login_channel_secret, line_login_redirect_uri, phone_login_enabled, printer_enabled, printer_user, printer_pass, printer_paper_width, customer_notify_enabled, webhook_token, billing_plan, billing_monthly_fee, billing_setup_fee, billing_commission_type, billing_commission_value, frontend_url, newebpay_enabled, newebpay_custom_allowed, newebpay_mode, newebpay_merchant_id, newebpay_hash_key, newebpay_hash_iv')
      .eq('id', req.params.id)
      .single()

    if (dbError || !data) return error(res, '找不到商家', 404)

    return success(res, {
      id: data.id,
      name: data.name,
      status: data.status ?? 'active',
      webhook_token: data.webhook_token,
      frontend_url: data.frontend_url || '',
      settings: storeToSettings(data),
    })
  } catch (err) {
    next(err)
  }
}

// PATCH /api/platform/stores/:id
const updateStore = async (req, res, next) => {
  try {
    const { status, frontend_url, settings } = req.body
    const updates = {}

    if (status !== undefined) updates.status = status
    if (frontend_url !== undefined) updates.frontend_url = frontend_url

    if (settings) {
      // 套用方案等級預設值：這次請求若帶了 billing.plan（入門/成長/旗艦），先把
      // 該 tier 在 plan_features 裡設定的預設功能值寫進 updates。下面的個別欄位
      // 判斷式如果同一次請求也明確帶了對應的值，會覆蓋掉這裡套用的預設值——
      // 也就是「先套用方案預設，個別欄位傳值可再覆蓋」
      if (PLAN_TIERS.includes(settings.billing?.plan)) {
        const planFeatures = await getPlanFeatures()
        applyPlanTierToStoreUpdates(updates, planFeatures?.[settings.billing.plan])
      }

      const { line_login, phone_login, line_notify, printer } = settings
      if (line_login?.enabled !== undefined)    updates.line_login_enabled     = line_login.enabled
      if (line_login?.channel_id !== undefined) updates.line_login_channel_id  = line_login.channel_id
      if (line_login?.channel_secret)           updates.line_login_channel_secret = line_login.channel_secret  // 空字串不覆蓋
      if (line_login?.redirect_uri !== undefined) updates.line_login_redirect_uri = line_login.redirect_uri
      if (phone_login?.enabled !== undefined)   updates.phone_login_enabled    = phone_login.enabled
      if (line_notify?.enabled !== undefined)   updates.line_bot_enabled       = line_notify.enabled
      if (line_notify?.target_id !== undefined) updates.line_notify_target     = line_notify.target_id
      if (line_notify?.channel_access_token)    updates.line_channel_access_token = line_notify.channel_access_token  // 空字串不覆蓋
      if (line_notify?.channel_secret)          updates.line_channel_secret    = line_notify.channel_secret            // 空字串不覆蓋
      if (printer?.enabled !== undefined)       updates.printer_enabled      = printer.enabled
      if (printer?.user !== undefined)          updates.printer_user         = printer.user
      if (printer?.pass)                        updates.printer_pass         = printer.pass  // 空字串不覆蓋
      if (printer?.paper_width !== undefined)   updates.printer_paper_width  = printer.paper_width
      const customer_notify = settings.customer_notify
      if (customer_notify?.enabled !== undefined) updates.customer_notify_enabled = customer_notify.enabled
      const newebpay = settings.newebpay
      if (newebpay?.enabled !== undefined) updates.newebpay_enabled = newebpay.enabled
      if (newebpay?.custom_allowed !== undefined) updates.newebpay_custom_allowed = newebpay.custom_allowed
      const billing = settings.billing
      if (billing) {
        if (billing.plan !== undefined)             updates.billing_plan             = billing.plan
        if (billing.monthly_fee !== undefined)      updates.billing_monthly_fee      = billing.monthly_fee
        if (billing.setup_fee !== undefined)        updates.billing_setup_fee        = billing.setup_fee
        if (billing.commission_type !== undefined)  updates.billing_commission_type  = billing.commission_type
        if (billing.commission_value !== undefined) updates.billing_commission_value = billing.commission_value
      }
    }

    if (Object.keys(updates).length === 0) return error(res, '沒有可更新的欄位', 400)

    // 藍新付款完成要導回 frontend_url，開通時如果這欄位是空的（這次沒填、資料庫也沒有）
    // 先擋下來，避免忘記設定，顧客付完款被導去一個空的 API 網址
    if (updates.newebpay_enabled === true) {
      const effectiveFrontendUrl = updates.frontend_url !== undefined
        ? updates.frontend_url
        : (await supabase.from('store').select('frontend_url').eq('id', req.params.id).single()).data?.frontend_url
      if (!effectiveFrontendUrl) return error(res, '請先設定「前台網址」才能開通藍新金流', 400)
    }

    const { error: dbError } = await supabase
      .from('store')
      .update(updates)
      .eq('id', req.params.id)

    if (dbError) throw dbError

    // 開通藍新時自動建一筆「線上刷卡」付款方式，讓它自動出現在既有的付款方式
    // 選單（結帳時顧客選這筆會觸發真的線上刷卡流程，不是純文字標籤）。用
    // provider 欄位識別，不存在才新增，關閉時保留這筆讓歷史訂單還查得到來源，
    // 顧客端結帳清單那邊會依 store.newebpay_enabled 決定要不要顯示這個選項。
    if (updates.newebpay_enabled === true) {
      const { data: existing } = await supabase
        .from('payment_method')
        .select('id')
        .eq('store_id', req.params.id)
        .eq('provider', 'newebpay')
        .maybeSingle()
      if (!existing) {
        // payment_method.payment_method 欄位是 varchar(10)，標籤要控制在 10 字內
        const { error: pmError } = await supabase.from('payment_method').insert({
          store_id: req.params.id,
          payment_method: '線上付款',
          provider: 'newebpay',
        })
        if (pmError) throw pmError
      }
    }

    return success(res, null, '設定已儲存')
  } catch (err) {
    next(err)
  }
}

// Map flat store DB row → nested settings shape the frontend expects
// Secrets are never returned in plaintext — only _set booleans
function storeToSettings(s) {
  const hasCustomBot = !!(s.line_channel_access_token || s.line_channel_secret)
  return {
    line_login: {
      enabled: s.line_login_enabled ?? false,
      mode: s.line_login_channel_id ? 'custom' : 'platform',
      channel_id: s.line_login_channel_id ?? '',
      channel_secret_set: !!s.line_login_channel_secret,
      redirect_uri: s.line_login_redirect_uri ?? '',
    },
    phone_login: { enabled: s.phone_login_enabled ?? false },
    line_notify: {
      enabled: s.line_bot_enabled ?? false,
      mode: hasCustomBot ? 'custom' : 'platform',
      target_id: s.line_notify_target ?? '',
      channel_access_token_set: !!s.line_channel_access_token,
      channel_secret_set: !!s.line_channel_secret,
    },
    printer: {
      enabled: s.printer_enabled ?? false,
      user: s.printer_user ?? '',
      pass_set: !!s.printer_pass,
      paper_width: s.printer_paper_width ?? 80,
    },
    customer_notify: { enabled: s.customer_notify_enabled ?? false },
    newebpay: {
      enabled: s.newebpay_enabled ?? false,
      custom_allowed: s.newebpay_custom_allowed ?? false,
      mode: s.newebpay_mode || 'platform',
      merchant_id: s.newebpay_merchant_id ?? '',
      hash_key_set: !!s.newebpay_hash_key,
      hash_iv_set: !!s.newebpay_hash_iv,
    },
    billing: {
      plan: s.billing_plan ?? '',
      monthly_fee: s.billing_monthly_fee ?? 0,
      setup_fee: s.billing_setup_fee ?? 0,
      commission_type: s.billing_commission_type ?? 'none',
      commission_value: Number(s.billing_commission_value ?? 0),
    },
  }
}

// GET /api/platform/stores/:id/billing
const getStoreBillingRecords = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('billing_record')
      .select('id, type, amount, period, status, note, created_at, paid_at')
      .eq('store_id', req.params.id)
      .order('created_at', { ascending: false })
    if (dbError) throw dbError
    return success(res, data || [])
  } catch (err) { next(err) }
}

// POST /api/platform/stores/:id/billing/records
const createBillingRecord = async (req, res, next) => {
  try {
    const { type, amount, period, note } = req.body
    if (!type || !amount) return error(res, '缺少 type 或 amount', 400)
    if (!['subscription', 'setup'].includes(type)) return error(res, 'type 必須是 subscription 或 setup', 400)
    const { data, error: dbError } = await supabase
      .from('billing_record')
      .insert({ store_id: req.params.id, type, amount: Number(amount), period: period || null, note: note || null })
      .select('id, type, amount, period, status, note, created_at, paid_at')
      .single()
    if (dbError) throw dbError
    return success(res, data, '帳單記錄已建立', 201)
  } catch (err) { next(err) }
}

// PATCH /api/platform/billing/records/:recordId
const updateBillingRecord = async (req, res, next) => {
  try {
    const { status, note } = req.body
    const updates = {}
    if (status !== undefined) {
      if (!['pending', 'paid', 'cancelled'].includes(status)) return error(res, '無效的 status', 400)
      updates.status = status
      updates.paid_at = status === 'paid' ? new Date().toISOString() : null
    }
    if (note !== undefined) updates.note = note
    if (Object.keys(updates).length === 0) return error(res, '沒有可更新的欄位', 400)
    const { error: dbError } = await supabase
      .from('billing_record')
      .update(updates)
      .eq('id', req.params.recordId)
    if (dbError) throw dbError
    return success(res, null, '已更新')
  } catch (err) { next(err) }
}

// DELETE /api/platform/billing/records/:recordId
const deleteBillingRecord = async (req, res, next) => {
  try {
    const { error: dbError } = await supabase
      .from('billing_record')
      .delete()
      .eq('id', req.params.recordId)
    if (dbError) throw dbError
    return success(res, null, '已刪除')
  } catch (err) { next(err) }
}

// GET /api/platform/orders?store_id=xxx&is_paid=true&limit=50&offset=0
const getOrders = async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const offset = Number(req.query.offset) || 0

    let query = supabase
      .from('order')
      .select('id, display_id, total_price, is_paid, is_cancelled, is_test, created_at, store:store_id(name), user:user_id(name)')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (req.query.store_id) query = query.eq('store_id', req.query.store_id)
    if (req.query.is_paid !== undefined) query = query.eq('is_paid', req.query.is_paid === 'true')

    const { data, error: dbError } = await query
    if (dbError) throw dbError
    return success(res, data || [])
  } catch (err) {
    next(err)
  }
}

// GET /api/platform/config
const getConfig = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('platform_config')
      .select('key, value')

    if (dbError) throw dbError

    const config = Object.fromEntries((data || []).map(r => [r.key, r.value]))
    return success(res, config)
  } catch (err) {
    next(err)
  }
}

// PATCH /api/platform/config
const updateConfig = async (req, res, next) => {
  try {
    const allowed = [
      'alert_line_target', 'alert_error_rate_threshold', 'alert_cooldown_minutes',
      'alert_request_rate_threshold', 'alert_ip_rate_threshold', 'alert_latency_threshold',
    ]
    const entries = Object.entries(req.body).filter(([k]) => allowed.includes(k))
    if (entries.length === 0) return error(res, '沒有可更新的欄位', 400)

    for (const [key, value] of entries) {
      const { error: dbError } = await supabase
        .from('platform_config')
        .upsert({ key, value: String(value), updated_at: new Date().toISOString() })
      if (dbError) throw dbError
    }

    invalidateAlertConfig()
    return success(res, null, '設定已儲存')
  } catch (err) {
    next(err)
  }
}

// POST /api/platform/config/test-alert
const testAlert = async (req, res, next) => {
  try {
    await sendHealthStatus()
    return success(res, null, '健康度報告已發送')
  } catch (err) {
    return error(res, err.message, 500)
  }
}

// GET /api/platform/blacklist
const getBlacklist = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('ip_blacklist')
      .select('id, ip, reason, active, expires_at, created_at')
      .order('created_at', { ascending: false })
    if (dbError) throw dbError
    return success(res, data || [])
  } catch (err) {
    next(err)
  }
}

// POST /api/platform/blacklist
const addBlacklist = async (req, res, next) => {
  try {
    const { ip, reason } = req.body
    if (!ip) return error(res, '缺少 ip', 400)
    const { error: dbError } = await supabase
      .from('ip_blacklist')
      .upsert({ ip, reason: reason || '', active: true, updated_at: new Date().toISOString() }, { onConflict: 'ip' })
    if (dbError) throw dbError
    ipBlacklist.reload()
    return success(res, null, '已加入黑名單')
  } catch (err) {
    next(err)
  }
}

// PATCH /api/platform/blacklist/:id
const updateBlacklist = async (req, res, next) => {
  try {
    const { active, reason } = req.body
    const updates = { updated_at: new Date().toISOString() }
    if (active !== undefined) updates.active = active
    if (reason !== undefined) updates.reason = reason
    const { error: dbError } = await supabase.from('ip_blacklist').update(updates).eq('id', req.params.id)
    if (dbError) throw dbError
    ipBlacklist.reload()
    return success(res, null, '已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /api/platform/blacklist/:id
const deleteBlacklist = async (req, res, next) => {
  try {
    const { error: dbError } = await supabase.from('ip_blacklist').delete().eq('id', req.params.id)
    if (dbError) throw dbError
    ipBlacklist.reload()
    return success(res, null, '已刪除')
  } catch (err) {
    next(err)
  }
}

// GET /api/platform/watch-notes?ip=xxx
const getWatchNotes = async (req, res, next) => {
  try {
    let query = supabase
      .from('ip_watch_note')
      .select('id, ip, category, note, created_at')
      .order('created_at', { ascending: false })
    if (req.query.ip) query = query.eq('ip', req.query.ip)
    const { data, error: dbError } = await query
    if (dbError) throw dbError
    return success(res, data || [])
  } catch (err) {
    next(err)
  }
}

// POST /api/platform/watch-notes
const addWatchNote = async (req, res, next) => {
  try {
    const { ip, category, note } = req.body
    if (!ip) return error(res, '缺少 ip', 400)
    if (!note) return error(res, '缺少備註內容', 400)
    if (category && !['security', 'testing', 'other'].includes(category)) {
      return error(res, 'category 須為 security/testing/other', 400)
    }
    const { data, error: dbError } = await supabase
      .from('ip_watch_note')
      .insert({ ip, category: category || 'other', note })
      .select('id, ip, category, note, created_at')
      .single()
    if (dbError) throw dbError
    return success(res, data, '已新增備註')
  } catch (err) {
    next(err)
  }
}

// DELETE /api/platform/watch-notes/:id
const deleteWatchNote = async (req, res, next) => {
  try {
    const { error: dbError } = await supabase.from('ip_watch_note').delete().eq('id', req.params.id)
    if (dbError) throw dbError
    return success(res, null, '已刪除')
  } catch (err) {
    next(err)
  }
}

// GET /api/platform/audit-logs
const getAuditLogs = async (req, res, next) => {
  try {
    const { limit = 200, store_id, action } = req.query
    let query = supabase
      .from('merchant_audit_log')
      .select('id, store_id, admin_phone, action, target_type, target_id, detail, ip, created_at, store(name)')
      .order('created_at', { ascending: false })
      .limit(Number(limit))
    if (store_id) query = query.eq('store_id', store_id)
    if (action) query = query.eq('action', action)
    const { data, error: dbError } = await query
    if (dbError) throw dbError
    return success(res, data)
  } catch (err) { next(err) }
}

const promoteUser = async (req, res, next) => {
  try {
    const { id: storeId } = req.params
    const { phone } = req.body
    if (!phone?.trim()) return error(res, '手機號碼為必填', 400)

    const { data: user, error: findErr } = await supabase
      .from('user')
      .select('id, phone, role')
      .eq('phone', phone.trim())
      .eq('store_id', storeId)
      .single()

    if (findErr || !user) return error(res, '找不到此手機號碼的帳號，請確認該用戶已透過 OTP 登入過一次', 404)
    if (user.role === 'MERCHANT') return error(res, '此帳號已經是管理員', 409)

    const { data: store } = await supabase.from('store').select('billing_plan').eq('id', storeId).single()
    const planFeatures = await getPlanFeatures()
    const limit = planFeatures?.[store?.billing_plan]?.merchant_seat_limit
    if (limit !== null && limit !== undefined) {
      const { count, error: countErr } = await supabase
        .from('user')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', storeId)
        .eq('role', 'MERCHANT')
      if (countErr) throw countErr
      if ((count || 0) >= limit) {
        return error(res, `此方案（${store.billing_plan}）最多只能有 ${limit} 個管理員帳號，請先降級其他管理員或升級方案`, 403)
      }
    }

    const { error: updateErr } = await supabase
      .from('user')
      .update({ role: 'MERCHANT' })
      .eq('id', user.id)

    if (updateErr) throw updateErr
    return success(res, { id: user.id, phone: user.phone, role: 'MERCHANT' }, '已升為管理員')
  } catch (err) { next(err) }
}

// GET /api/platform/plan-features
const getPlanFeaturesConfig = async (req, res, next) => {
  try {
    const planFeatures = await getPlanFeatures()
    return success(res, planFeatures || {})
  } catch (err) { next(err) }
}

// PATCH /api/platform/plan-features
const updatePlanFeaturesConfig = async (req, res, next) => {
  try {
    const body = req.body
    for (const tier of PLAN_TIERS) {
      if (!body[tier] || typeof body[tier] !== 'object') {
        return error(res, `缺少 ${tier} 的方案設定`, 400)
      }
    }
    await savePlanFeatures(body)
    return success(res, null, '方案設定已儲存')
  } catch (err) { next(err) }
}

module.exports = {
  getSummary, getTimeline, getRecent, getStores, getStore, createStore, updateStore, getOrders,
  getConfig, updateConfig, testAlert,
  getBlacklist, addBlacklist, updateBlacklist, deleteBlacklist,
  getWatchNotes, addWatchNote, deleteWatchNote,
  getAuditLogs, promoteUser,
  getStoreBillingRecords, createBillingRecord, updateBillingRecord, deleteBillingRecord,
  getPlanFeaturesConfig, updatePlanFeaturesConfig,
}

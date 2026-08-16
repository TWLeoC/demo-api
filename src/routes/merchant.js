const router = require('express').Router()
const { body } = require('express-validator')
const validate = require('../middlewares/validate')
const { authenticate, authorizeMerchant } = require('../middlewares/auth')

const {
  getDiscounts, getDiscount, createDiscount, updateDiscount, deleteDiscount
} = require('../controllers/discountController')

const {
  getExpenses, getExpenseCategories, createExpense, updateExpense, deleteExpense
} = require('../controllers/expenseController')

const {
  merchantGetAddons, getProductAddons, setProductAddons
} = require('../controllers/addonController')

const {
  getPaymentMethods, createPaymentMethod, updatePaymentMethod, deletePaymentMethod
} = require('../controllers/paymentMethodController')

const {
  getUsers, getUser, getUserOrders, setUserStatus, setUserRole, updateUser
} = require('../controllers/merchantUserController')

const {
  merchantGetCategories, createCategory, updateCategory, deleteCategory, getCategoryAddons, setCategoryAddons
} = require('../controllers/categoryController')

const {
  merchantGetPickupSlots, createPickupSlot, batchCreatePickupSlots, updatePickupSlot, deletePickupSlot
} = require('../controllers/pickupSlotController')

const {
  merchantGetCampaigns, createCampaign, updateCampaign, deleteCampaign
} = require('../controllers/campaignController')

const {
  getGiftRules, createGiftRule, updateGiftRule, deleteGiftRule,
  getGiftPools, createGiftPool, updateGiftPool, deleteGiftPool
} = require('../controllers/giftRuleController')

const {
  getLineSettings, updateLineSettings
} = require('../controllers/lineSettingsController')

const {
  getAdSettings, updateAdSettings
} = require('../controllers/adSettingsController')

const {
  getNewebpaySettings, updateNewebpaySettings
} = require('../controllers/newebpaySettingsController')

const {
  merchantGetOrder, merchantGetOrders, shipOrder, merchantConfirmPay, reprintOrder,
} = require('../controllers/orderController')

const { exportOrdersReport } = require('../controllers/reportController')

// 所有 merchant 路由都需要驗證 + merchant 權限
router.use(authenticate, authorizeMerchant)

// ── Image Upload ───────────────────────────────────
const supabase = require('../config/supabase')
const UPLOAD_FOLDERS = ['products', 'ads']
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'demo-uploads'
router.post('/upload-image', async (req, res, next) => {
  try {
    const { base64, filename, folder } = req.body
    if (!base64 || !filename) return res.status(400).json({ success: false, message: '缺少 base64 或 filename' })
    const matched = base64.match(/^data:(image\/\w+);base64,(.+)$/)
    if (!matched) return res.status(400).json({ success: false, message: '無效的 base64 格式' })
    const mimeType = matched[1]
    const buffer = Buffer.from(matched[2], 'base64')
    if (buffer.length > 3 * 1024 * 1024) return res.status(400).json({ success: false, message: '圖片不能超過 3MB' })
    // 白名單限制，folder 是路徑的一部分，不能讓呼叫端隨意帶入任意字串
    const targetFolder = UPLOAD_FOLDERS.includes(folder) ? folder : 'products'
    const ext = filename.split('.').pop().toLowerCase() || 'jpg'
    const storeId = req.storeId || req.user?.store_id || 'unknown'
    const path = `${targetFolder}/${storeId}/${Date.now()}.${ext}`
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, { contentType: mimeType, upsert: false })
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path)
    return res.json({ success: true, data: { url: publicUrl } })
  } catch (err) {
    next(err)
  }
})

// ── Image Delete ───────────────────────────────────
router.delete('/upload-image', async (req, res, next) => {
  try {
    const { url } = req.body
    if (!url) return res.status(400).json({ success: false, message: '缺少 url' })
    const match = url.match(new RegExp(`/object/public/${STORAGE_BUCKET}/(.+)$`))
    if (!match) return res.status(400).json({ success: false, message: '無效的 URL' })
    const storeId = req.storeId || req.user?.store_id
    // 共用 bucket，路徑規則可預期，一定要確認要刪的檔案屬於自己的 store，不然任何商家都能刪別家的圖
    const ownsFile = storeId && UPLOAD_FOLDERS.some(f => match[1].startsWith(`${f}/${storeId}/`))
    if (!ownsFile) {
      return res.status(403).json({ success: false, message: '無權刪除此圖片' })
    }
    await supabase.storage.from(STORAGE_BUCKET).remove([match[1]])
    return res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ── Addons ────────────────────────────────────────
router.get('/addons', merchantGetAddons)
router.get('/products/:id/addons', getProductAddons)
router.put('/products/:id/addons',
  body('addon_ids').isArray(),
  validate,
  setProductAddons
)

// ── Discounts ─────────────────────────────────────
router.get('/discounts', getDiscounts)
router.get('/discounts/:id', getDiscount)

router.post('/discounts',
  body('discount_kol').notEmpty().isLength({ max: 20 }).withMessage('折扣碼最多 20 字'),
  body('discount_percent').optional().isFloat({ min: 0, max: 1 }).withMessage('折扣率需介於 0~1'),
  body('discount_price').optional().isInt({ min: 0 }),
  body('is_enable').optional().isBoolean(),
  body('expires_at').optional({ nullable: true }).isISO8601().withMessage('日期格式錯誤'),
  validate,
  createDiscount
)

router.patch('/discounts/:id',
  body('discount_kol').optional().isLength({ max: 20 }),
  body('discount_percent').optional().isFloat({ min: 0, max: 1 }),
  body('discount_price').optional().isInt({ min: 0 }),
  body('is_enable').optional().isBoolean(),
  body('expires_at').optional({ nullable: true }).isISO8601(),
  validate,
  updateDiscount
)

router.delete('/discounts/:id', deleteDiscount)

// ── Payment Methods ───────────────────────────────
router.get('/payment-methods', getPaymentMethods)

router.post('/payment-methods',
  body('payment_method').notEmpty().isLength({ max: 10 }).withMessage('付款方式名稱最多 10 字'),
  validate,
  createPaymentMethod
)

router.patch('/payment-methods/:id',
  body('payment_method').notEmpty().isLength({ max: 10 }),
  validate,
  updatePaymentMethod
)

router.delete('/payment-methods/:id', deletePaymentMethod)

// ── Categories ───────────────────────────────────────
router.get('/categories', merchantGetCategories)

router.post('/categories',
  body('name').notEmpty().isLength({ max: 50 }),
  body('sort_order').optional().isInt({ min: 0 }),
  validate,
  createCategory
)
router.patch('/categories/:id',
  body('name').optional().isLength({ max: 50 }),
  body('sort_order').optional().isInt({ min: 0 }),
  body('is_enable').optional().isBoolean(),
  validate,
  updateCategory
)
router.delete('/categories/:id', deleteCategory)
router.get('/categories/:id/addons', getCategoryAddons)
router.put('/categories/:id/addons',
  body('addon_ids').isArray(),
  validate,
  setCategoryAddons
)

// ── Pickup Slots ──────────────────────────────────────
router.get('/pickup-slots', merchantGetPickupSlots)

router.post('/pickup-slots',
  body('date').isDate().withMessage('日期格式錯誤'),
  body('start_time').notEmpty().withMessage('請填入開始時間'),
  body('end_time').notEmpty().withMessage('請填入結束時間'),
  body('max_orders').optional().isInt({ min: 1 }),
  body('is_enable').optional().isBoolean(),
  validate,
  createPickupSlot
)
router.post('/pickup-slots/batch',
  body('slots').isArray({ min: 1 }),
  validate,
  batchCreatePickupSlots
)
router.patch('/pickup-slots/:id',
  body('date').optional().isDate(),
  body('start_time').optional().notEmpty(),
  body('end_time').optional().notEmpty(),
  body('max_orders').optional().isInt({ min: 1 }),
  body('is_enable').optional().isBoolean(),
  validate,
  updatePickupSlot
)
router.delete('/pickup-slots/:id', deletePickupSlot)

// ── Campaigns（節慶檔期）──────────────────────────────
router.get('/campaigns', merchantGetCampaigns)

router.post('/campaigns',
  body('name').notEmpty().isLength({ max: 100 }),
  body('pickup_start_date').isDate().withMessage('取貨區間開始日期格式錯誤'),
  body('pickup_end_date').isDate().withMessage('取貨區間結束日期格式錯誤'),
  body('order_start_at').optional({ nullable: true }).isISO8601(),
  body('order_end_at').optional({ nullable: true }).isISO8601(),
  body('payment_deadline_days').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('is_enable').optional().isBoolean(),
  validate,
  createCampaign
)
router.patch('/campaigns/:id',
  body('name').optional().isLength({ max: 100 }),
  body('pickup_start_date').optional().isDate(),
  body('pickup_end_date').optional().isDate(),
  body('order_start_at').optional({ nullable: true }).isISO8601(),
  body('order_end_at').optional({ nullable: true }).isISO8601(),
  body('payment_deadline_days').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('is_enable').optional().isBoolean(),
  validate,
  updateCampaign
)
router.delete('/campaigns/:id', deleteCampaign)

// ── Gift Rules（滿額贈品規則）───────────────────────
router.get('/gift-rules', getGiftRules)

router.post('/gift-rules',
  body('name').notEmpty().isLength({ max: 100 }),
  body('mode').isIn(['flat', 'scaling', 'addon_purchase']),
  body('threshold_amount').isInt({ min: 1 }),
  body('max_amount').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('qty_per_step').optional().isInt({ min: 1 }),
  body('max_redemptions').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('gift_pool_id').optional({ nullable: true }).isUUID(),
  body('addon_price').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('campaign_id').optional({ nullable: true }).isUUID(),
  body('excluded_category_id').optional({ nullable: true }).isUUID(),
  body('start_at').optional({ nullable: true }).isISO8601(),
  body('end_at').optional({ nullable: true }).isISO8601(),
  body('is_enable').optional().isBoolean(),
  body('options').isArray({ min: 1 }),
  validate,
  createGiftRule
)
router.patch('/gift-rules/:id',
  body('name').optional().isLength({ max: 100 }),
  body('mode').optional().isIn(['flat', 'scaling', 'addon_purchase']),
  body('threshold_amount').optional().isInt({ min: 1 }),
  body('max_amount').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('qty_per_step').optional().isInt({ min: 1 }),
  body('max_redemptions').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('gift_pool_id').optional({ nullable: true }).isUUID(),
  body('addon_price').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('campaign_id').optional({ nullable: true }).isUUID(),
  body('excluded_category_id').optional({ nullable: true }).isUUID(),
  body('start_at').optional({ nullable: true }).isISO8601(),
  body('end_at').optional({ nullable: true }).isISO8601(),
  body('is_enable').optional().isBoolean(),
  body('options').optional().isArray(),
  validate,
  updateGiftRule
)
router.delete('/gift-rules/:id', deleteGiftRule)

// ── Gift Pools（多個贈品規則共用同一份贈送額度）────────
router.get('/gift-pools', getGiftPools)
router.post('/gift-pools',
  body('name').notEmpty().isLength({ max: 100 }),
  body('max_redemptions').isInt({ min: 1 }),
  validate,
  createGiftPool
)
router.patch('/gift-pools/:id',
  body('name').optional().isLength({ max: 100 }),
  body('max_redemptions').optional().isInt({ min: 1 }),
  validate,
  updateGiftPool
)
router.delete('/gift-pools/:id', deleteGiftPool)

// ── Users ─────────────────────────────────────────
router.get('/users', getUsers)
router.get('/users/:id', getUser)
router.get('/users/:id/orders', getUserOrders)

router.patch('/users/:id/status',
  body('status').isBoolean().withMessage('status 必須是 true 或 false'),
  validate,
  setUserStatus
)

router.patch('/users/:id/role',
  body('role').isIn(['USER', 'MERCHANT']).withMessage('role 必須是 USER 或 MERCHANT'),
  validate,
  setUserRole
)

router.patch('/users/:id',
  body('name').optional().isLength({ max: 50 }),
  body('email').optional({ checkFalsy: true }).isEmail(),
  validate,
  updateUser
)

// ── Expenses ──────────────────────────────────────
router.get('/expenses/categories', getExpenseCategories)
router.get('/expenses', getExpenses)

router.post('/expenses',
  body('category').notEmpty().withMessage('請選擇支出類別'),
  body('amount').isFloat({ min: 0 }).withMessage('金額必須 >= 0'),
  body('expense_date').isDate().withMessage('日期格式錯誤'),
  body('note').optional({ nullable: true }).isLength({ max: 200 }),
  validate,
  createExpense
)

router.patch('/expenses/:id',
  body('category').optional().notEmpty(),
  body('amount').optional().isFloat({ min: 0 }),
  body('expense_date').optional().isDate(),
  body('note').optional({ nullable: true }).isLength({ max: 200 }),
  validate,
  updateExpense
)

router.delete('/expenses/:id', deleteExpense)

// ── Orders (merchant) ────────────────────────────────
router.get('/orders', merchantGetOrders)
// /orders/export 一定要掛在 /orders/:id 前面，不然 Express 會把 "export" 當成
// :id 比對到上面那條路由去（實際踩過：curl 打這條會撞進 merchantGetOrder 回「訂單不存在」）
router.get('/orders/export', exportOrdersReport)
router.get('/orders/:id', merchantGetOrder)
router.patch('/orders/:id/confirm', merchantConfirmPay)
router.patch('/orders/:id/ship', shipOrder)
router.post('/orders/:id/reprint', reprintOrder)

// ── 出攤 / 收攤 ────────────────────────────────────
router.patch('/open-status', async (req, res, next) => {
  try {
    const { is_open } = req.body
    if (typeof is_open !== 'boolean') return res.status(400).json({ success: false, message: '參數錯誤' })
    const supabase = require('../config/supabase')
    const { writeAuditLog } = require('../utils/auditLog')
    await supabase.from('store').update({ is_open }).eq('id', req.storeId)
    writeAuditLog(req, is_open ? '出攤' : '收攤', 'store', req.storeId, {})
    const { success } = require('../utils/response')
    return success(res, null, is_open ? '已出攤' : '已收攤')
  } catch (err) { next(err) }
})

// ── LINE 通知設定 ──────────────────────────────────
router.get('/line-settings', getLineSettings)
router.patch('/line-settings', updateLineSettings)

// ── 廣告 Modal 設定 ────────────────────────────────
router.get('/ad-settings', getAdSettings)
router.patch('/ad-settings', updateAdSettings)

// ── 藍新金流設定 ──────────────────────────────────
router.get('/newebpay-settings', getNewebpaySettings)
router.patch('/newebpay-settings', updateNewebpaySettings)

// ── 稽核紀錄 ──────────────────────────────────────
router.get('/audit-logs', async (req, res, next) => {
  try {
    const supabase = require('../config/supabase')
    const { limit = 100, action } = req.query
    let query = supabase
      .from('merchant_audit_log')
      .select('id, admin_phone, action, target_type, target_id, detail, ip, created_at')
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false })
      .limit(Number(limit))
    if (action) query = query.eq('action', action)
    const { data, error } = await query
    if (error) throw error
    const { success } = require('../utils/response')
    return success(res, data)
  } catch (err) { next(err) }
})

// ── 日報表 ────────────────────────────────────────
router.get('/daily-report', async (req, res, next) => {
  try {
    const supabase = require('../config/supabase')
    const { success } = require('../utils/response')
    const dateStr = req.query.date || (() => {
      const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
      return now.toISOString().split('T')[0]
    })()
    const start = new Date(`${dateStr}T00:00:00+08:00`).toISOString()
    const end   = new Date(`${dateStr}T23:59:59+08:00`).toISOString()

    const { data: orders, error: dbErr } = await supabase
      .from('order')
      .select('total_price, order_item(product_name, product_price, quantity, order_item_addon(addon_price))')
      .eq('store_id', req.storeId)
      .eq('is_cancelled', false)
      .eq('is_test', false)
      .gte('created_at', start)
      .lte('created_at', end)
    if (dbErr) throw dbErr

    const productMap = {}
    let addonTotal = 0
    for (const order of orders || []) {
      for (const item of order.order_item || []) {
        const key = item.product_name
        if (!productMap[key]) productMap[key] = { quantity: 0, total: 0 }
        productMap[key].quantity += item.quantity
        productMap[key].total   += item.product_price * item.quantity
        for (const addon of item.order_item_addon || []) {
          addonTotal += addon.addon_price * item.quantity
        }
      }
    }

    const items = Object.entries(productMap).map(([name, v]) => ({ name, ...v }))
    const grandTotal = items.reduce((s, i) => s + i.total, 0) + addonTotal

    return success(res, {
      date: dateStr,
      order_count: (orders || []).length,
      items,
      addon_total: addonTotal,
      grand_total: grandTotal,
    })
  } catch (err) { next(err) }
})

module.exports = router

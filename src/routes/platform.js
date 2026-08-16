const router = require('express').Router()
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')
const {
  getSummary, getTimeline, getRecent, getStores, getStore, createStore, updateStore, getOrders,
  getConfig, updateConfig, testAlert,
  getBlacklist, addBlacklist, updateBlacklist, deleteBlacklist,
  getWatchNotes, addWatchNote, deleteWatchNote,
  getAuditLogs, promoteUser,
  getStoreBillingRecords, createBillingRecord, updateBillingRecord, deleteBillingRecord,
  getPlanFeaturesConfig, updatePlanFeaturesConfig,
} = require('../controllers/platformController')
const { googleLogin } = require('../controllers/platformAuthController')
const { requirePlatformSession } = require('../middlewares/platformAuth')

// 登入本身不需要真的猜金鑰（要有一個真的 Google 帳號簽出的 ID token），但還是
// 限制一下同 IP 的嘗試次數，避免被拿來打錯誤訊息／耗資源
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `platform-login:${ipKeyGenerator(req.ip ?? '')}`,
  handler: (req, res) => res.status(429).json({ success: false, message: '嘗試次數過多，請稍後再試' }),
  standardHeaders: true,
  legacyHeaders: false,
})

// 登入後的一般請求也做寬鬆的每 IP 限流，防止 session token 外流後被拿來打 API
const apiLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyGenerator: (req) => `platform-api:${ipKeyGenerator(req.ip ?? '')}`,
  handler: (req, res) => res.status(429).json({ success: false, message: '請求次數過多，請稍後再試' }),
  standardHeaders: true,
  legacyHeaders: false,
})

// 登入端點本身不能掛在 requirePlatformSession 後面，不然沒 token 永遠進不來
router.post('/auth/google', loginLimit, googleLogin)

router.use(apiLimit, requirePlatformSession)

router.get('/config', getConfig)
router.patch('/config', updateConfig)
router.post('/config/test-alert', testAlert)
router.get('/stores', getStores)
router.post('/stores', createStore)
router.get('/stores/:id', getStore)
router.patch('/stores/:id', updateStore)
router.post('/stores/:id/promote', promoteUser)
router.get('/stores/:id/billing', getStoreBillingRecords)
router.post('/stores/:id/billing/records', createBillingRecord)
router.patch('/billing/records/:recordId', updateBillingRecord)
router.delete('/billing/records/:recordId', deleteBillingRecord)
router.get('/orders', getOrders)
router.get('/blacklist', getBlacklist)
router.post('/blacklist', addBlacklist)
router.patch('/blacklist/:id', updateBlacklist)
router.delete('/blacklist/:id', deleteBlacklist)
router.get('/watch-notes', getWatchNotes)
router.post('/watch-notes', addWatchNote)
router.delete('/watch-notes/:id', deleteWatchNote)
router.get('/logs/summary', getSummary)
router.get('/logs/timeline', getTimeline)
router.get('/logs/recent', getRecent)
router.get('/audit-logs', getAuditLogs)
router.get('/plan-features', getPlanFeaturesConfig)
router.patch('/plan-features', updatePlanFeaturesConfig)

module.exports = router

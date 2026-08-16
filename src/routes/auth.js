const router = require('express').Router()
const { body } = require('express-validator')
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')
const { sendCode, verifyCode, login, setupPassword, getMe, updateMe, lineLogin, merchantLineLogin, merchantLinkLine, linkPhone } = require('../controllers/authController')
const { authenticate } = require('../middlewares/auth')
const validate = require('../middlewares/validate')

const phoneKey = (prefix) => (req) =>
  `${prefix}:${req.body?.phone || ipKeyGenerator(req.ip ?? '')}`

const smsCooldown = rateLimit({
  windowMs: 60 * 1000,
  max: 1,
  keyGenerator: phoneKey('sms:60s'),
  handler: (req, res) =>
    res.status(429).json({ success: false, message: '請等待 60 秒後再重新傳送驗證碼' }),
  standardHeaders: true,
  legacyHeaders: false,
})

const smsBurst = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  keyGenerator: phoneKey('sms:5m'),
  handler: (req, res) =>
    res.status(429).json({ success: false, message: '5 分鐘內最多傳送 3 次驗證碼，請稍後再試' }),
  standardHeaders: true,
  legacyHeaders: false,
})

const verifyLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: phoneKey('verify'),
  handler: (req, res) =>
    res.status(429).json({ success: false, message: '嘗試次數過多，請重新取得驗證碼' }),
  standardHeaders: true,
  legacyHeaders: false,
})

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: phoneKey('login'),
  handler: (req, res) =>
    res.status(429).json({ success: false, message: '嘗試次數過多，請稍後再試' }),
  standardHeaders: true,
  legacyHeaders: false,
})

// 每小時同一 IP 最多發 10 次驗證碼（防止用不同號碼輪流轟炸）
const smsIpLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `sms:ip:${ipKeyGenerator(req.ip ?? '')}`,
  handler: (req, res) =>
    res.status(429).json({ success: false, message: '此裝置請求次數過多，請稍後再試' }),
  standardHeaders: true,
  legacyHeaders: false,
})

router.post('/send-code',
  smsIpLimit,   // 同一 IP 每小時最多 10 次
  smsBurst,     // 同一手機 5 分鐘最多 3 次
  smsCooldown,  // 同一手機 60 秒冷卻
  body('phone').isMobilePhone().withMessage('請輸入正確手機號碼'),
  validate,
  sendCode
)

router.post('/verify-code',
  verifyLimit,
  body('phone').isMobilePhone(),
  body('code').isLength({ min: 6, max: 6 }).withMessage('驗證碼為 6 位數'),
  validate,
  verifyCode
)

router.post('/login',
  loginLimit,
  body('phone').isMobilePhone().withMessage('請輸入正確手機號碼'),
  body('password').isLength({ min: 6 }).withMessage('密碼至少 6 位'),
  validate,
  login
)

router.post('/setup-password',
  authenticate,
  body('password').isLength({ min: 6 }).withMessage('密碼至少 6 位'),
  body('name').optional().isLength({ max: 50 }),
  validate,
  setupPassword
)

router.post('/line', lineLogin)
router.post('/merchant/line', merchantLineLogin)
router.post('/merchant/link-line',
  verifyLimit,
  body('phone').isMobilePhone().withMessage('請輸入正確手機號碼'),
  body('code').isLength({ min: 6, max: 6 }).withMessage('驗證碼為 6 位數'),
  validate,
  merchantLinkLine
)

router.post('/link-phone',
  authenticate,
  body('phone').isMobilePhone().withMessage('請輸入正確手機號碼'),
  body('code').isLength({ min: 6, max: 6 }).withMessage('驗證碼為 6 位數'),
  validate,
  linkPhone
)

router.get('/me', authenticate, getMe)

router.patch('/me', authenticate,
  body('name').optional().isLength({ max: 50 }),
  body('email').optional().isEmail(),
  body('birth_date').optional().isDate(),
  validate,
  updateMe
)

module.exports = router

const jwt = require('jsonwebtoken')
const config = require('./config')

// 跟 authController.js::signToken 同格式（{ id, role, phone, store_id }），
// 直接用隔離測試商家既有的 MERCHANT 帳號，不用真的走一次手機 OTP 流程
const signMerchantToken = () => jwt.sign(
  { id: config.TEST_ADMIN_USER_ID, role: 'MERCHANT', phone: '0900000001', store_id: config.TEST_STORE_ID },
  config.JWT_SECRET,
  { expiresIn: '1h' }
)

module.exports = { signMerchantToken }

const jwt = require('jsonwebtoken')
const { success, error } = require('../utils/response')
const { verifyGoogleIdToken } = require('../utils/googleAuth')

const allowedEmails = () =>
  (process.env.PLATFORM_ALLOWED_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)

// POST /api/platform/auth/google
// 前端送 Google Sign-In 拿到的 ID token，驗證通過且 email 在白名單內才發 session token。
// 跟商家用的 JWT_SECRET 分開，兩邊的金鑰外流互不影響彼此的權限範圍
const googleLogin = async (req, res, next) => {
  try {
    const { credential } = req.body
    if (!credential) return error(res, '缺少 credential', 400)

    // google-auth-library 對無效/偽造/過期 token 會丟各種不同措辭的 Error，
    // 統一當成「驗證失敗」回 401，不要把內部錯誤訊息原封不動洩漏給前端
    let email
    try {
      ({ email } = await verifyGoogleIdToken(credential))
    } catch {
      return error(res, 'Google 登入驗證失敗，請重新登入', 401)
    }

    if (!allowedEmails().includes(email.toLowerCase())) {
      return error(res, '此帳號未獲授權使用平台管理後台', 403)
    }

    const token = jwt.sign(
      { email, scope: 'platform' },
      process.env.PLATFORM_JWT_SECRET,
      { expiresIn: '8h' }
    )

    return success(res, { token, email }, '登入成功')
  } catch (err) {
    next(err)
  }
}

module.exports = { googleLogin }

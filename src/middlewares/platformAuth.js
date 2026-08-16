const jwt = require('jsonwebtoken')
const { error } = require('../utils/response')

// 驗證 Google 登入後發出的短效 session token（平台層管理介面用）
const requirePlatformSession = (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return error(res, 'Unauthorized', 401)
  }

  const token = authHeader.split(' ')[1]
  try {
    const decoded = jwt.verify(token, process.env.PLATFORM_JWT_SECRET)
    if (decoded.scope !== 'platform') return error(res, 'Unauthorized', 401)
    req.platform = decoded
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') return error(res, 'Session 已過期，請重新登入', 401)
    return error(res, 'Unauthorized', 401)
  }
}

module.exports = { requirePlatformSession }

const jwt = require('jsonwebtoken')
const { error } = require('../utils/response')

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return error(res, 'Missing or invalid authorization header', 401)
  }

  const token = authHeader.split(' ')[1]
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const headerStoreId = req.headers['x-store-id']
    // JWT 帶的 store_id 才是可信來源；如果同時帶了 X-Store-ID header 但兩者對不上，
    // 直接拒絕而不是靜默信任 header——不然只要有 token 沒帶 store_id 的漏洞，
    // 這裡就會變成任何登入使用者都能用 header 冒充別家商家
    if (decoded.store_id && headerStoreId && decoded.store_id !== headerStoreId) {
      return error(res, 'Store mismatch', 403)
    }
    req.user = decoded
    req.storeId = decoded.store_id || headerStoreId
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') return error(res, 'Token expired', 401)
    return error(res, 'Invalid token', 401)
  }
}

const authorizeMerchant = (req, res, next) => {
  if (req.user?.role !== 'MERCHANT') {
    return error(res, 'Forbidden: merchant only', 403)
  }
  next()
}

module.exports = { authenticate, authorizeMerchant }

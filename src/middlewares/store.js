const { error } = require('../utils/response')

// For public routes: read X-Store-ID header → req.storeId
const requireStore = (req, res, next) => {
  const storeId = req.headers['x-store-id']
  if (!storeId) return error(res, 'X-Store-ID header required', 400)
  req.storeId = storeId
  next()
}

module.exports = { requireStore }

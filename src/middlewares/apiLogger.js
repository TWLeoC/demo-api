const supabase = require('../config/supabase')

const SKIP_PATHS = new Set(['/health', '/', '/favicon.ico', '/robots.txt'])

// 常見自動化掃描路徑（WordPress、phpMyAdmin 等），不記錄以免汙染錯誤率
const SCAN_PREFIXES = ['/wp-', '/wordpress', '/phpmyadmin', '/.env', '/.git', '/admin.php', '/xmlrpc.php']

const apiLogger = (req, res, next) => {
  if (SKIP_PATHS.has(req.path) || req.path.startsWith('/cloudprnt') || req.path.startsWith('/api/platform')) return next()
  if (SCAN_PREFIXES.some(p => req.path.startsWith(p) || req.path === p)) return next()

  const start = Date.now()
  res.on('finish', () => {
    supabase.from('api_log').insert({
      store_id: req.storeId || null,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      latency_ms: Date.now() - start,
      ip: req.ip || null,
    }).then(() => {}).catch(() => {})
  })
  next()
}

module.exports = apiLogger

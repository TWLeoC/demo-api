const { logRequest, isScannerUA } = require('../utils/requestLog')

const SKIP_PATHS = new Set(['/health', '/', '/favicon.ico', '/robots.txt'])

// 常見自動化掃描路徑（WordPress、phpMyAdmin 等）。2026-09 資安檢查前是直接
// return 不寫入 api_log，理由是「不記錄以免汙染錯誤率」——但這等於「全記錄」
// 原則名存實亡：這些請求被擋下/被忽略後在 dashboard 上完全消失，稽核時也
// 查不到。現在改成照樣寫入，只是標記 is_scan=true，統計錯誤率／告警時排除
// 這批即可（見 alertService.js），需要時仍查得到完整記錄。
const SCAN_PREFIXES = ['/wp-', '/wordpress', '/phpmyadmin', '/.env', '/.git', '/admin.php', '/xmlrpc.php']

const apiLogger = (req, res, next) => {
  if (SKIP_PATHS.has(req.path) || req.path.startsWith('/cloudprnt') || req.path.startsWith('/api/platform')) return next()

  const isScan = SCAN_PREFIXES.some(p => req.path.startsWith(p) || req.path === p) || isScannerUA(req.headers['user-agent'])

  const start = Date.now()
  res.on('finish', () => {
    logRequest(req, res, { start, isScan })
  })
  next()
}

module.exports = apiLogger

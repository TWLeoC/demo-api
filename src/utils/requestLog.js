const supabase = require('../config/supabase')

// UA 字串裡常見資安掃描工具的特徵字。這只抓「不小心用預設 UA 的機會主義
// 掃描」——認真的攻擊者多半會偽造成瀏覽器 UA，所以這條規則命中即視為高
// 訊號（誤判機率極低：正常瀏覽器、監控服務都不會帶這些字串），但沒命中
// 不代表安全，只是少了這一種訊號來源。
const SCANNER_UA_RE = /sqlmap|nikto|\bnmap\b|nuclei|gobuster|masscan|wpscan|dirbuster|dirb\/|nessus|acunetix|w3af|zgrab|nuclei|fuzz/i

function isScannerUA(ua) {
  return !!ua && SCANNER_UA_RE.test(ua)
}

// apiLogger / ipBlacklist / honeypotPaths 三個 middleware 都要寫 api_log，
// 欄位跟擷取邏輯集中在這裡——三份各自維護欄位清單，正是這次資安檢查發現
// 「ipBlacklist 擋下的請求完全沒有記錄」的原因（改的時候漏改一份）。
function buildLogRow(req, res, { status, latencyMs, isScan = false }) {
  const bytesHeader = res.getHeader ? res.getHeader('content-length') : undefined
  return {
    store_id: req.storeId || null,
    method: req.method,
    path: req.path,
    // 含 query string 的完整路徑——掃描特徵常藏在參數裡，req.path 不含
    full_path: req.originalUrl || req.path,
    status,
    latency_ms: latencyMs,
    ip: req.ip || null,
    user_agent: req.headers['user-agent'] || null,
    referer: req.headers['referer'] || req.headers['referrer'] || null,
    bytes: bytesHeader != null ? Number(bytesHeader) : null,
    is_scan: isScan,
  }
}

function insertApiLog(row) {
  return supabase.from('api_log').insert(row).then(() => {}).catch(() => {})
}

// 供三個 middleware 共用的寫入入口：status 沒特別指定就用當下的 res.statusCode
function logRequest(req, res, { start, isScan = false, status } = {}) {
  const latencyMs = Date.now() - start
  const row = buildLogRow(req, res, { status: status ?? res.statusCode, latencyMs, isScan })
  return insertApiLog(row)
}

module.exports = { logRequest, isScannerUA, SCANNER_UA_RE }

const supabase = require('../config/supabase')

let blacklistSet = new Set()
let loadedAt = 0
const CACHE_TTL = 60 * 1000  // 1 分鐘重新載入

async function loadBlacklist() {
  const now = new Date().toISOString()
  const { data } = await supabase
    .from('ip_blacklist')
    .select('ip')
    .eq('active', true)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
  blacklistSet = new Set((data || []).map(r => r.ip))
  loadedAt = Date.now()
}

// 啟動時先載入一次，之後定期刷新。.unref() 原因同 cloudprnt/queue.js 那顆
// timer——這個也是 module load 當下就註冊、沒有掛在啟動伺服器的函式底下，
// 不 unref 的話，任何短命 script/測試只要 require 到掛這個 middleware 的
// app.js，process 就會被這個 timer 卡住永遠不會自然結束
loadBlacklist().catch(() => {})
const reloadInterval = setInterval(() => loadBlacklist().catch(() => {}), CACHE_TTL)
reloadInterval.unref()

// /api/platform/ 之前排除是因為靠靜態金鑰認證、怕商家後台誤觸黑名單擋到自己人；
// 現在已經是 Google 登入 + 白名單 email，沒有理由再排除在黑名單保護之外
const SKIP_PREFIXES = ['/api/merchant/']

const ipBlacklist = (req, res, next) => {
  if (SKIP_PREFIXES.some(p => req.path.startsWith(p))) return next()
  const ip = req.ip
  if (ip && blacklistSet.has(ip)) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  next()
}

// 讓 controller 可以手動觸發快取刷新（新增黑名單後立即生效）
ipBlacklist.reload = () => loadBlacklist().catch(() => {})

module.exports = ipBlacklist

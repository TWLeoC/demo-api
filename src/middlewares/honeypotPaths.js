const supabase = require('../config/supabase')
const ipBlacklist = require('./ipBlacklist')
const { logRequest, isScannerUA } = require('../utils/requestLog')
const { fireAlert } = require('../services/alertNotifier')

// 這個 app 是 Node/Express + React SPA，絕對不會有這些路徑對應到真正的路由——
// 一次命中就已經是掃描器/攻擊工具在探測，不用等累積到門檻，也不用等
// alertService.js 每 60 秒的批次掃描，第一次打中就立刻封鎖，零誤判風險
// （2026-07-30 兩次掃描事件：現有機制要等到掃描快結束才觸發，反應太慢）
// 2026-09 資安檢查後補上 well-known（AI agent / MCP 探測）跟 config.*
// （2026-07-30 那兩次掃描其中一支就是打 /.well-known/agent.json、
// /.well-known/mcp，當時的 regex 沒收，全部落在門檻式偵測，反應更慢）
const HONEYPOT_RE = /(^|\/)\.(aws|awsvault|git|ssh|env|docker|kube|npmrc|netrc|saml2aws|htpasswd|well-known)($|\/|\.)|wp-admin|wp-login|phpmyadmin|id_rsa|credentials\.(json|ya?ml|txt|bak)|config\.(json|ya?ml|php|bak|old)/i

const honeypotPaths = async (req, res, next) => {
  const ua = req.headers['user-agent']
  const hitPath = HONEYPOT_RE.test(req.path)
  // 已知掃描工具 UA（sqlmap/nikto/nmap/nuclei…）：跟路徑樣板是獨立訊號，
  // 掃描器打的路徑不一定長得像上面那些警戒路徑，但 UA 老實暴露身份時
  // 一樣是零誤判——正常瀏覽器、監控服務都不會帶這些字串
  const hitUA = isScannerUA(ua)
  if (!hitPath && !hitUA) return next()

  const start = Date.now()
  const ip = req.ip
  res.status(403).json({ error: 'Forbidden' })

  const reason = hitPath && hitUA
    ? `警戒路徑＋掃描工具 UA（${req.path}）`
    : hitPath
      ? `命中警戒路徑（${req.path}）`
      : `掃描工具 UA（${ua}）`

  // 這個 middleware 命中就直接回應不會呼叫 next()，apiLogger 永遠跑不到，
  // 這裡要自己補寫一筆，不然平台監控頁面完全看不到這些已經被擋下的請求
  logRequest(req, res, { start, isScan: true })

  if (!ip) return

  console.warn(`[Honeypot] ${reason}，立即封鎖：${ip} ${req.method} ${req.path}`)

  try {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    await supabase.from('ip_blacklist').upsert(
      { ip, reason: `自動封鎖（${reason}）`, active: true, expires_at: expiresAt, updated_at: new Date().toISOString() },
      { onConflict: 'ip' }
    )
    ipBlacklist.reload()
  } catch (err) {
    console.error('[Honeypot] 寫入黑名單失敗:', err.message)
  }

  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  await fireAlert({
    type: 'honeypot',
    severity: 'critical',
    ip,
    message: `🍯 ${reason}，已即時封鎖\nIP：${ip}\n路徑：${req.method} ${req.path}\nUA：${ua || '（無）'}\n時間：${now}`,
  })
}

module.exports = honeypotPaths

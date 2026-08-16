const router = require('express').Router()
const { getPendingJob, getJobByToken, markJobFetched, markJobDone, addRawJob } = require('./queue')
const { buildPrintData } = require('./builder')
const supabase = require('../config/supabase')

// Optional Basic Auth — per-store credentials with fallback to platform-level env vars
const PLATFORM_USER = process.env.CLOUDPRNT_USER
const PLATFORM_PASS = process.env.CLOUDPRNT_PASS

// 紙寬 mm → 可列印 dots（203dpi）
const PAPER_WIDTH_DOTS = { 58: 384, 80: 576 }

async function getStoreConfig(storeId) {
  if (!storeId) return { user: PLATFORM_USER, pass: PLATFORM_PASS, dotWidth: 576 }
  const { data } = await supabase
    .from('store')
    .select('printer_user, printer_pass, printer_paper_width')
    .eq('id', storeId)
    .single()
  return {
    user: data?.printer_user || PLATFORM_USER,
    pass: data?.printer_pass || PLATFORM_PASS,
    dotWidth: PAPER_WIDTH_DOTS[data?.printer_paper_width] ?? 576,
  }
}

async function getStoreAuth(storeId) {
  const { user, pass } = await getStoreConfig(storeId)
  return { user, pass }
}

async function checkAuth(req, res, storeId) {
  const { user: expectedUser, pass: expectedPass } = await getStoreAuth(storeId)
  if (!expectedUser || !expectedPass) return true
  const auth = req.headers['authorization'] || ''
  const b64 = auth.replace(/^Basic\s+/, '')
  const [user, pass] = Buffer.from(b64, 'base64').toString().split(':')
  if (user === expectedUser && pass === expectedPass) return true
  res.set('WWW-Authenticate', 'Basic realm="CloudPRNT"')
  res.sendStatus(401)
  return false
}

async function isPrinterEnabled(storeId) {
  const { data } = await supabase
    .from('store')
    .select('printer_enabled')
    .eq('id', storeId)
    .single()
  return data?.printer_enabled === true
}

// ── Test endpoint (must be before /:storeId) ──────────────────────────────

// GET /cloudprnt/test?store_id=xxx&enc=big5&style=0|1
// style=0 → 純文字
// style=1 → StarPRNT 樣式（粗體、置中、大字、切紙）
router.get('/test', async (req, res) => {
  const { store_id, enc = 'big5', style = '0' } = req.query
  if (!await checkAuth(req, res, store_id)) return
  if (!store_id) return res.status(400).json({ error: 'store_id required' })
  if (!await isPrinterEnabled(store_id)) return res.status(403).json({ error: '出單機未啟用' })

  const iconv = require('iconv-lite')
  const b = str => iconv.encode(str, enc)

  let buf
  if (style === '1') {
    // StarPRNT 控制碼 (Star mC-Print3 預設模式)
    const RESET        = Buffer.from([0x1b, 0x40])
    const ALIGN_CENTER = Buffer.from([0x1b, 0x1d, 0x61, 0x01])
    const ALIGN_LEFT   = Buffer.from([0x1b, 0x1d, 0x61, 0x00])
    const BOLD_ON      = Buffer.from([0x1b, 0x45, 0x01])
    const BOLD_OFF     = Buffer.from([0x1b, 0x46])
    const FONT_2X      = Buffer.from([0x1b, 0x69, 0x01, 0x01])
    const FONT_NORMAL  = Buffer.from([0x1b, 0x69, 0x00, 0x00])

    const { dotWidth } = await getStoreConfig(store_id)
    const cols = { 576: 42, 384: 28 }[dotWidth] ?? 42

    function displayWidth(str) {
      let w = 0
      for (const ch of str) { w += ch.codePointAt(0) > 0x7e ? 2 : 1 }
      return w
    }
    function padBetween(left, right) {
      const spaces = Math.max(1, cols - displayWidth(left) - displayWidth(right))
      return left + ' '.repeat(spaces) + right + '\n'
    }

    buf = Buffer.concat([
      RESET,
      ALIGN_CENTER, FONT_2X, BOLD_ON,
      b('示範商店\n'),
      FONT_NORMAL, BOLD_OFF, ALIGN_LEFT,
      b('='.repeat(cols) + '\n'),
      b('訂單：#260607123456\n'),
      b('顧客：王小明\n'),
      b('手機末三碼：456\n'),
      b('取餐：2026-06-07 15:00\n'),
      BOLD_ON, b('備註：不要太辣\n'), BOLD_OFF,
      b('='.repeat(cols) + '\n'),
      b('品項：\n'),
      b('烤玉米：\n'),
      b(padBetween('  原味烤玉米 x2', 'NT$120')),
      BOLD_ON, b('    加乳酪 +NT$10\n'), BOLD_OFF,
      BOLD_ON, b('    ※ 少鹽\n'), BOLD_OFF,
      b(padBetween('  乳酪玉米 x1', 'NT$80')),
      b('='.repeat(cols) + '\n'),
      b('小計：NT$ 210\n'),
      b('優惠碼：VIP (9折)\n'),
      b('折抵：-NT$ 21\n'),
      BOLD_ON, b('合計：NT$ 189\n'), BOLD_OFF,
      b('\n\n\n'),
    ])
  } else {
    const text = [
      `[純文字測試 enc=${enc}]\n`,
      '--------------------------------\n',
      '示範商店\n',
      '原味烤玉米 x2\n',
      '乳酪玉米 x1\n',
      '取餐：15:00\n',
      '合計：NT$ 200\n',
      '\n\n\n',
    ].join('')
    buf = b(text)
  }

  addRawJob(store_id, buf, `text/plain; charset=${enc}`)
  res.json({ ok: true, enc, style, store_id, message: `測試列印（enc=${enc} style=${style}）已加入佇列` })
})

// ── Legacy fallback: CLOUDPRNT_STORE_ID env still set ────────────────────
// Keeps old printers working at /cloudprnt without URL change

const LEGACY_STORE_ID = process.env.CLOUDPRNT_STORE_ID

router.post('/', async (req, res) => {
  if (!await checkAuth(req, res, LEGACY_STORE_ID)) return
  if (!LEGACY_STORE_ID) return res.json({ jobReady: false })

  const job = getPendingJob(LEGACY_STORE_ID)
  if (job) {
    console.log(`[CloudPRNT] legacy 有工作 jobToken=${job.token}`)
    return res.json({ jobReady: true, mediaTypes: ['text/plain;charset=big5'], jobToken: job.token })
  }
  res.json({ jobReady: false })
})

router.get('/', async (req, res) => {
  if (!await checkAuth(req, res, LEGACY_STORE_ID)) return
  const job = getJobByToken(req.query.token)
  if (!job) return res.sendStatus(404)
  markJobFetched(req.query.token)
  if (job.rawBuffer) {
    res.setHeader('Content-Type', job.contentType || 'text/plain; charset=utf-8')
    return res.send(job.rawBuffer)
  }
  const { dotWidth } = await getStoreConfig(LEGACY_STORE_ID)
  const cols = { 576: 42, 384: 28 }[dotWidth] ?? 42
  res.setHeader('Content-Type', 'text/plain; charset=big5')
  res.send(buildPrintData(job.orderData, cols))
})

router.delete('/', async (req, res) => {
  if (!await checkAuth(req, res, LEGACY_STORE_ID)) return
  const { token: jobToken, code } = req.query
  if (code && code !== '200') console.warn(`[CloudPRNT] legacy 列印失敗 jobToken=${jobToken} code=${code}`)
  markJobDone(jobToken)
  res.sendStatus(200)
})

// ── Per-store CloudPRNT routes ────────────────────────────────────────────
// Printer URL: https://<host>/cloudprnt/<store_id>

// POST /cloudprnt/:storeId — printer asks "any jobs?"
router.post('/:storeId', async (req, res) => {
  if (!await checkAuth(req, res, req.params.storeId)) return
  if (!await isPrinterEnabled(req.params.storeId)) return res.json({ jobReady: false })

  // Log printer's supported media types (useful for debugging)
  if (req.body?.mediaNameList) {
    console.log(`[CloudPRNT] 印表機支援格式: ${req.body.mediaNameList} storeId=${req.params.storeId}`)
  }

  const job = getPendingJob(req.params.storeId)
  if (job) {
    const mediaType = job.contentType || 'text/plain;charset=big5'
    console.log(`[CloudPRNT] 有工作 jobToken=${job.token} mediaType=${mediaType} storeId=${req.params.storeId}`)
    return res.json({
      jobReady: true,
      mediaTypes: [mediaType],
      jobToken: job.token,
    })
  }
  res.json({ jobReady: false })
})

// GET /cloudprnt/:storeId?token=<jobToken> — printer fetches print data
router.get('/:storeId', async (req, res) => {
  if (!await checkAuth(req, res, req.params.storeId)) return
  const job = getJobByToken(req.query.token)
  if (!job || job.storeId !== req.params.storeId) {
    console.warn(`[CloudPRNT] 找不到工作 jobToken=${req.query.token}`)
    return res.sendStatus(404)
  }

  console.log(`[CloudPRNT] 發送列印資料 jobToken=${req.query.token}`)
  markJobFetched(req.query.token)
  if (job.rawBuffer) {
    res.setHeader('Content-Type', job.contentType || 'text/plain; charset=utf-8')
    return res.send(job.rawBuffer)
  }
  const { dotWidth } = await getStoreConfig(req.params.storeId)
  const cols = { 576: 42, 384: 28 }[dotWidth] ?? 42
  const data = buildPrintData(job.orderData, cols)
  res.setHeader('Content-Type', 'text/plain; charset=big5')
  res.send(data)
})

// DELETE /cloudprnt/:storeId?token=<jobToken>&code=<statusCode> — printer reports done
router.delete('/:storeId', async (req, res) => {
  if (!await checkAuth(req, res, req.params.storeId)) return
  const { token: jobToken, code } = req.query
  if (code && code !== '200') {
    console.warn(`[CloudPRNT] 列印失敗 jobToken=${jobToken} code=${code}`)
  }
  markJobDone(jobToken)
  res.sendStatus(200)
})

module.exports = router

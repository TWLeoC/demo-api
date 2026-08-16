const { spawn } = require('child_process')
const path = require('path')
const config = require('./config')

let child = null

const waitForHealth = async (baseUrl, timeoutMs = 15000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.ok) return
    } catch {
      // 還沒起來，繼續等
    }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`test server did not become healthy within ${timeoutMs}ms at ${baseUrl}`)
}

// CI 的 docker-test job 是對已經在跑的 container 打（見 .github/workflows/ci.yml 的
// TEST_BASE_URL），本機或其他情境則自己 spawn 一份 app 當子行程，兩種情境共用同一套測試檔案
const start = async () => {
  if (process.env.TEST_BASE_URL) {
    await waitForHealth(process.env.TEST_BASE_URL)
    return process.env.TEST_BASE_URL
  }

  const port = process.env.TEST_SERVER_PORT || '4055'
  child = spawn('node', [path.join(__dirname, '../../src/app.js')], {
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: 'development',
      JWT_SECRET: config.JWT_SECRET,
      NEWEBPAY_MERCHANT_ID: config.NEWEBPAY_MERCHANT_ID,
      NEWEBPAY_HASH_KEY: config.NEWEBPAY_HASH_KEY,
      NEWEBPAY_HASH_IV: config.NEWEBPAY_HASH_IV,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', d => process.stderr.write(`[test-server] ${d}`))

  const baseUrl = `http://localhost:${port}`
  await waitForHealth(baseUrl)
  return baseUrl
}

const stop = async () => {
  if (!child) return
  child.kill()
  child = null
}

module.exports = { start, stop }

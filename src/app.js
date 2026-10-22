require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const { notFound, errorHandler } = require('./middlewares/errorHandler')
const apiLogger = require('./middlewares/apiLogger')
const ipBlacklist = require('./middlewares/ipBlacklist')
const honeypotPaths = require('./middlewares/honeypotPaths')
const { startAlertMonitor } = require('./services/alertService')
const { startOrderExpiryMonitor } = require('./services/orderExpiryService')

const app = express()

// 正式環境允許的前端來源，用逗號分隔的網域清單（可以是完整網域或含萬用子網域的
// 正規表示式片段），例如 CORS_ALLOWED_ORIGINS=https://my-frontend.vercel.app,https://my-dashboard.vercel.app
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(origin => new RegExp(`^${origin.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`))

if (process.env.NODE_ENV !== 'production' || process.env.CORS_ALLOW_LOCALHOST === 'true') {
  ALLOWED_ORIGINS.push(/^http:\/\/localhost(:\d+)?$/)
  // 開發時用手機透過 ngrok 開前端測試，前端會用 ngrok 的隨機網域打本機後端
  ALLOWED_ORIGINS.push(/^https:\/\/([a-z0-9-]+\.)*ngrok-free\.app$/)
  // 開發時用手機在同一個區網直接連本機前端（LAN IP），例如 http://192.168.x.x:5173
  ALLOWED_ORIGINS.push(/^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/)
}

const corsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server or non-browser requests (no Origin header)
    if (!origin) return callback(null, true)
    if (ALLOWED_ORIGINS.some(re => re.test(origin))) return callback(null, true)
    callback(new Error(`CORS: origin not allowed — ${origin}`))
  },
  credentials: true,
  // Content-Disposition 不在瀏覽器預設可讀的 response header 名單裡，跨網域時
  // 前端讀不到檔名（訂單報表匯出用這個 header 帶檔名），要明確 expose 出去
  exposedHeaders: ['Content-Disposition'],
}

// Trust reverse proxy (Zeabur) so req.ip returns real client IP
app.set('trust proxy', 1)

// Middleware
app.use(helmet())
// morgan 移到 cors/路由之前，確保掛在 cors 前面的 webhook 路由也會被記錄到 log
// （之前 /api/line 掛在 morgan 前面，等於完全沒有存取紀錄）
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))

// LINE webhook must be registered before express.json() so the middleware
// can read the raw body for signature verification
app.use('/api/line', require('./routes/line'))

// 藍新 NewebPay webhook（server-to-server 通知 + 瀏覽器 POST 導回）都不受
// 前端同源政策管轄，掛在 cors middleware 之前避免被擋（ReturnURL 是瀏覽器
// POST 導頁會帶 Origin header，是另一套系統踩過同樣的坑）
app.use('/api/payment', require('./routes/payment'))

app.use(cors(corsOptions))
app.use(express.json({ limit: '5mb' }))
app.use(ipBlacklist)
// 已知黑名單先擋掉之後，才檢查警戒路徑——避免每個請求都跑一次 regex，
// 已經被封鎖的 IP 在上一行就結束了，不會走到這裡
app.use(honeypotPaths)
app.use(apiLogger)

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))


// Routes
app.use('/api/auth', require('./routes/auth'))
app.use('/api/products', require('./routes/products'))
app.use('/api/cart', require('./routes/cart'))
app.use('/api/orders', require('./routes/orders'))
app.use('/api/receivers', require('./routes/receivers'))
app.use('/api/addons', require('./routes/addons'))
app.use('/api/categories', require('./routes/categories'))
app.use('/api/pickup-slots', require('./routes/pickupSlots'))
app.use('/api/merchant', require('./routes/merchant'))
app.use('/api/store-info', require('./routes/storeInfo'))
app.use('/api/payment-methods', require('./routes/paymentMethods'))
app.use('/api/platform', require('./routes/platform'))

// CloudPRNT（Star 印表機輪詢，不需認證）
app.use('/cloudprnt', require('./cloudprnt/router'))

// Error handlers
app.use(notFound)
app.use(errorHandler)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 demo-api running on port ${PORT} [${process.env.NODE_ENV || 'development'}] node ${process.version}`)
  startAlertMonitor()
  startOrderExpiryMonitor()
})

module.exports = app

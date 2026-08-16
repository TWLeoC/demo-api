const { error } = require('../utils/response')

const parseDbError = (err) => {
  const message = err.message || ''
  const code = err.code || ''

  if (code === '23505') {
    if (message.includes('email')) return { status: 409, msg: '此信箱已被使用' }
    if (message.includes('phone')) return { status: 409, msg: '此手機號碼已被使用' }
    if (message.includes('display_id')) return { status: 409, msg: '訂單編號重複，請重試' }
    if (message.includes('provider')) return { status: 409, msg: '此第三方帳號已綁定其他使用者' }
    if (message.includes('discount_kol')) return { status: 409, msg: '折扣碼已存在' }
    if (message.includes('payment_method')) return { status: 409, msg: '付款方式已存在' }
    return { status: 409, msg: '資料重複，請確認後再試' }
  }

  if (code === '23503') return { status: 400, msg: '關聯資料不存在' }
  if (code === '23502') return { status: 400, msg: '必填欄位不能為空' }
  if (code === '23514') return { status: 400, msg: '資料格式不符合規則' }

  return null
}

const notFound = (req, res) => {
  return error(res, `Route ${req.method} ${req.originalUrl} not found`, 404)
}

const errorHandler = (err, req, res, next) => {
  console.error(`[Error] ${err.message}`, err.code || '', err.details || '')

  const dbErr = parseDbError(err)
  if (dbErr) return error(res, dbErr.msg, dbErr.status)

  const statusCode = err.statusCode || 500
  const message = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  return error(res, message, statusCode)
}

module.exports = { notFound, errorHandler }

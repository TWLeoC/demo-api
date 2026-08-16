const crypto = require('crypto')
const { buildTradeSha } = require('../../src/utils/newebpay')
const config = require('./config')

// 模擬藍新 webhook 回傳的加密格式：RespondType=JSON 時明文是巢狀 JSON
// { Status, Message, Result: {...} }（不是 checkout 那個方向用的 query string，
// 兩個方向格式本來就不對稱，藍新自己的規格如此）。TradeSha 直接重用
// src/utils/newebpay.js 真正的簽章函式，確保測試打的是真實邏輯而不是自己另外一套假邏輯
const buildFakeNotifyPayload = (result) => {
  const plaintext = JSON.stringify({ Status: 'SUCCESS', Message: 'test', Result: result })
  const cipher = crypto.createCipheriv('aes-256-cbc', config.NEWEBPAY_HASH_KEY, config.NEWEBPAY_HASH_IV)
  const TradeInfo = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex')
  const TradeSha = buildTradeSha(TradeInfo, config.NEWEBPAY_HASH_KEY, config.NEWEBPAY_HASH_IV)
  return { MerchantID: config.NEWEBPAY_MERCHANT_ID, TradeInfo, TradeSha, Version: '2.2' }
}

module.exports = { buildFakeNotifyPayload }

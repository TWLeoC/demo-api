const crypto = require('crypto')

// key/iv 不固定讀 env——每家商家可能用自己的藍新帳號（見 storePayment.js 的
// getNewebPaySettings），所以全部函式改成參數傳入，呼叫端自己決定要用平台共用
// 還是商家自訂的金鑰。（
// 已經在票務系統實測過，這裡沿用同樣的踩坑修正：TradeInfo 是 JSON 不是 query string）

const buildTradeInfo = (params, key, iv) => {
  const qs = new URLSearchParams(params).toString()
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  return cipher.update(qs, 'utf8', 'hex') + cipher.final('hex')
}

const buildTradeSha = (tradeInfo, key, iv) => {
  const raw = `HashKey=${key}&${tradeInfo}&HashIV=${iv}`
  return crypto.createHash('sha256').update(raw).digest('hex').toUpperCase()
}

// RespondType: 'JSON' 下，解密後的 TradeInfo 是
// { Status, Message, Result: { MerchantOrderNo, TradeNo, Amt, ... } } 巢狀 JSON，
// 不是 query string。把 Result 攤平到最外層，呼叫端可以直接用 data.MerchantOrderNo。
const decryptTradeInfo = (tradeInfo, key, iv) => {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  // 關掉自動 PKCS7 padding 驗證，改成手動過濾 padding 字元——藍新回傳的密文
  // padding 格式在某些情況下沒有 100% 符合 Node 內建 auto-unpad 的嚴格驗證，
  // 會導致 decipher.final() 丟出 bad decrypt，但資料本身其實是可以正確還原的
  decipher.setAutoPadding(false)
  let decrypted = decipher.update(tradeInfo, 'hex', 'utf8') + decipher.final('utf8')
  decrypted = decrypted.split('').filter((ch) => ch.charCodeAt(0) > 32).join('')
  const parsed = JSON.parse(decrypted)
  return { ...parsed, ...(parsed.Result || {}) }
}

const verifyTradeSha = (tradeInfo, tradeSha, key, iv) => {
  return buildTradeSha(tradeInfo, key, iv) === String(tradeSha || '').toUpperCase()
}

// ── 信用卡請/退款 API（CreditCard/Close）專用 ──────────────────────────
// 這支 API 的加密請求跟 MPG 結帳共用同一套 AES-256-CBC，但「回應驗證」公式
// 不一樣：MPG 是 TradeSha（HashKey=...&TradeInfo&HashIV=...），這支是
// CheckCode（HashIV=...&依英文字母排序的 4 個欄位&HashKey=...），且回應本身
// 是明碼 JSON、不是加密過的 TradeInfo（這支是我們主動打的 server-to-server
// API，不是藍新回傳的 webhook，所以不需要另外解密）

const buildCloseRequestBody = ({ merchantId, tradeNo, merchantOrderNo, amt, closeType, cancel }, key, iv) => {
  const params = {
    RespondType: 'JSON',
    Version: '1.1',
    Amt: Math.round(amt).toString(),
    MerchantOrderNo: merchantOrderNo,
    TimeStamp: Math.floor(Date.now() / 1000).toString(),
    IndexType: '1', // 用 MerchantOrderNo 對應交易，不用藍新的 TradeNo
    TradeNo: tradeNo,
    CloseType: closeType.toString(), // 1=請款 2=退款
    ...(cancel ? { Cancel: '1' } : {}), // 搭配 CloseType 變成取消請款/取消退款
  }
  const qs = new URLSearchParams(params).toString()
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const postData = cipher.update(qs, 'utf8', 'hex') + cipher.final('hex')
  return { MerchantID_: merchantId, PostData_: postData }
}

// ── 取消授權 API（CreditCard/Cancel）專用 ──────────────────────────────
// 適用時機：剛付款完、還沒真正請款完成的交易（還在「已授權未請款」狀態），
// 完全撤銷授權，錢沒有真的流動過。已經請款完成的交易這支會失敗，要改用
// 上面的 Close（CloseType=2）才是真正的退款。注意 Version 是 '1.0'，
// 跟 Close 的 '1.1' 不一樣。
const buildCancelRequestBody = ({ merchantId, tradeNo, merchantOrderNo, amt }, key, iv) => {
  const params = {
    RespondType: 'JSON',
    Version: '1.0',
    Amt: Math.round(amt).toString(),
    MerchantOrderNo: merchantOrderNo,
    TimeStamp: Math.floor(Date.now() / 1000).toString(),
    IndexType: '1',
    TradeNo: tradeNo,
  }
  const qs = new URLSearchParams(params).toString()
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const postData = cipher.update(qs, 'utf8', 'hex') + cipher.final('hex')
  return { MerchantID_: merchantId, PostData_: postData }
}

// CheckCode 驗證回應完整性，公式跟 buildTradeSha 不一樣：
// HashIV=<iv>&<Amt/MerchantID/MerchantOrderNo/TradeNo 依英文字母排序>&HashKey=<key>
const buildCheckCode = (fields, key, iv) => {
  const sortedKeys = Object.keys(fields).sort()
  const sorted = {}
  for (const k of sortedKeys) sorted[k] = fields[k]
  const qs = new URLSearchParams(sorted).toString()
  const raw = `HashIV=${iv}&${qs}&HashKey=${key}`
  return crypto.createHash('sha256').update(raw).digest('hex').toUpperCase()
}

const verifyCheckCode = (fields, checkCode, key, iv) => {
  return buildCheckCode(fields, key, iv) === String(checkCode || '').toUpperCase()
}

module.exports = {
  buildTradeInfo, buildTradeSha, decryptTradeInfo, verifyTradeSha,
  buildCloseRequestBody, buildCancelRequestBody, buildCheckCode, verifyCheckCode,
}

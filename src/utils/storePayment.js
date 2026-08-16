const { decrypt } = require('./secretEncryption')

// 商家用 platform（平台共用藍新帳號）或 custom（商家自己的藍新帳號）。
// custom 模式一定要先經平台管理員 把 newebpay_custom_allowed 打開才會生效，
// 就算 store.newebpay_mode 被設成 custom，只要 allowed 是 false 還是退回平台共用金鑰。
const getNewebPaySettings = (store) => {
  const useCustom = store.newebpay_mode === 'custom' && store.newebpay_custom_allowed
    && store.newebpay_merchant_id && store.newebpay_hash_key && store.newebpay_hash_iv

  if (useCustom) {
    return {
      merchantId: store.newebpay_merchant_id,
      // 資料庫存的是加密後的密文（見 newebpaySettingsController.js 寫入時的
      // encrypt()），這裡讀出來要先解密才是真正能拿去用的 HashKey/HashIV
      hashKey: decrypt(store.newebpay_hash_key),
      hashIv: decrypt(store.newebpay_hash_iv),
    }
  }

  return {
    merchantId: process.env.NEWEBPAY_MERCHANT_ID,
    hashKey: process.env.NEWEBPAY_HASH_KEY,
    hashIv: process.env.NEWEBPAY_HASH_IV,
  }
}

module.exports = { getNewebPaySettings }

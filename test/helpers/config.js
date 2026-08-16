require('dotenv').config()

module.exports = {
  // supabase/seed.sql 裡寫死的固定 UUID，不是真實商家資料
  TEST_STORE_ID: process.env.TEST_STORE_ID || '00000000-0000-0000-0000-000000000001',
  TEST_ADMIN_USER_ID: process.env.TEST_ADMIN_USER_ID || '00000000-0000-0000-0000-000000000401',
  // 這三個是測試套件自己簽章、自己驗證用的固定假值，不是真的 JWT/藍新密鑰，
  // 跟本機 .env 或正式環境的值完全無關。跑測試時會蓋掉 spawn 出來那個
  // app 行程的對應環境變數，確保測試永遠自簽自驗、不受本機 .env 內容影響
  JWT_SECRET: 'ci-test-only-secret-not-real',
  NEWEBPAY_MERCHANT_ID: 'CITESTMERCHANT001',
  NEWEBPAY_HASH_KEY: 'ab12'.repeat(8), // 32 bytes，AES-256 要求
  NEWEBPAY_HASH_IV: 'ab12'.repeat(4), // 16 bytes
}

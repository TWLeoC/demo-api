require('./config') // 確保 .env 在建立 supabase client 前已載入

// 測試資料的建立/清理直接重用 app 自己的 Supabase client（同一套 schema 設定），
// 不用另外接一份 client
module.exports = require('../../src/config/supabase')

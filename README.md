# demo-api

多租戶餐飲點餐 SaaS 後端範例。以一套實際上線、服務多家真實商家的生產環境後端為範本重寫而成，
拿掉所有跟真實商家/公司綁定的東西（品牌名稱、正式資料庫、正式金鑰），改用假資料與通用命名，
單純展示後端架構與程式碼風格。

## 技術棧

- Node.js + Express
- Supabase（PostgreSQL + PostgREST），本機透過 Supabase CLI 用 Docker 跑起來，不用申請雲端帳號
- JWT 雙層認證（商家層 `role=MERCHANT`／平台層 Google OAuth）
- `express-validator` 請求驗證、`helmet`/`express-rate-limit` 基礎防護
- 選配整合：LINE Bot／LINE Login、簡訊 OTP（Twilio / 三竹）、藍新金流（NewebPay）、Star CloudPRNT 出單機——全部走「留空 = 功能自動關閉」設計，缺任何一個都不影響核心點餐流程

## 架構重點

- **多租戶隔離**：每個商家（`store`）的商品、訂單、設定完全獨立，JWT 帶 `store_id`，後端每個查詢都會用這個值過濾，避免跨店資料外洩
- **三層權限**：顧客（`role=USER`，一般 JWT）／商家後台（`role=MERCHANT`，一般 JWT + `authorizeMerchant` 中介層）／平台管理（獨立的 Google OAuth 登入 + 專屬 JWT，管理所有商家）
- **RESTful 資源命名**：每個角色層掛在自己的 sub-router 前綴下（`/api/merchant/*`、`/api/platform/*`），底下維持資源導向的路徑設計
- **稽核與防護**：商家後台操作寫入 `merchant_audit_log`；IP 黑名單 + 已知掃描路徑即時封鎖；API 請求全部記錄供流量/錯誤率分析

## Quick Start

```bash
# 1. 安裝依賴
npm install

# 2. 啟動本機 Supabase（需要先裝 Docker Desktop + Supabase CLI）
npx supabase start
# 終端機最後會印出一段資訊，把 API URL 跟 service_role key 記下來

# 3. 設定環境變數
cp .env.example .env
# 把上一步印出的 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 貼進 .env
# JWT_SECRET 用這行產生一組：node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

# 4. 啟動 API
npm run dev
```

`supabase start` 會自動套用 `supabase/migrations/`（schema）跟 `supabase/seed.sql`（假資料），
不用額外下指令建表或塞資料。之後如果想清空重來，跑 `npx supabase db reset` 即可。

## Demo 帳號

| 角色 | 手機 | 密碼 | 登入方式 |
|---|---|---|---|
| 商家後台 | `0900000001` | `Demo1234!` | `POST /api/auth/login`（手機+密碼，帶 `X-Store-ID: 00000000-0000-0000-0000-000000000001`） |
| 顧客 | `0900000002` | — | 手機 OTP（`SMS_PROVIDER` 沒設定的話，驗證碼會直接印在 server console，不用真的收簡訊） |

平台管理層（`/api/platform/*`）需要真的 Google 帳號登入（見下方「哪些是假資料」），沒設定的話這些端點程式碼一樣看得到，只是實際跑不起來。

## 路由總覽

| 前綴 | 說明 | 認證 |
|---|---|---|
| `/api/auth` | 註冊/登入、OTP、LINE 登入綁定 | 依端點而定 |
| `/api/products`、`/api/categories`、`/api/addons`、`/api/pickup-slots`、`/api/payment-methods`、`/api/store-info` | 顧客端瀏覽用（公開或需一般登入） | JWT（顧客） |
| `/api/cart` | 購物車 | JWT（顧客） |
| `/api/orders` | 訂單（建立/查詢自己的訂單、付款） | JWT（顧客） |
| `/api/orders/merchant/*` | 訂單商家端操作（列表、出貨、確認付款、退款、補印） | JWT + `role=MERCHANT` |
| `/api/merchant/*` | 商家後台：商品/分類/加購/折扣碼/取餐時段/檔期/贈品規則/顧客管理/支出/LINE 設定/廣告設定/藍新設定/稽核紀錄/日報表/圖片上傳 | JWT + `role=MERCHANT` |
| `/api/platform/*` | 平台管理：商家開通與帳務、API 監控、IP 黑名單、方案功能設定 | Google OAuth session |
| `/api/payment/newebpay/*` | 藍新金流 webhook（server-to-server） | 簽章驗證 |
| `/api/line/webhook*` | LINE webhook | 簽章驗證 |
| `/cloudprnt` | Star 出單機輪詢協定 | 選配 Basic Auth |

完整端點清單直接看 `src/routes/*.js`，每個路由上面都有一行註解說明對應的 HTTP method + path。

## 哪些是假資料／哪些要自己填

| 項目 | 狀態 |
|---|---|
| 資料庫（schema + demo 商店/商品/訂單/帳號） | ✅ 假資料，`supabase start` 自動套用，不用任何設定 |
| `JWT_SECRET` / `PLATFORM_JWT_SECRET` | 要自己在本機產生（`.env.example` 裡有指令），不能用預設值 |
| LINE Bot / LINE Login / 簡訊 OTP / 藍新金流 / CloudPRNT 出單機 | 選配，留空即自動關閉，不影響核心點餐流程能不能跑 |
| Google OAuth（平台管理層登入） | 要自己申請 Google Cloud OAuth 用戶端才能真的登入 `/api/platform/*`；不申請的話這部分程式碼一樣看得到，只是無法實際呼叫 |

## 測試

```bash
npm test
```

CI（`.github/workflows/ci.yml`）在 GitHub Actions runner 上用 Supabase CLI 起本機 stack 跑完整整合測試，全程不需要設定任何 GitHub repo secrets。

## License

MIT，詳見 `LICENSE`。

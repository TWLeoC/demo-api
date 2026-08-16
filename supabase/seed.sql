-- seed.sql
-- Supabase CLI 在 `supabase start` / `supabase db reset` 時會自動套用這份檔案。
-- 所有 UUID 都寫死方便 README/CI 直接引用，取餐時段用 CURRENT_DATE 動態產生，
-- 所以不管什麼時候跑 `supabase db reset` 都會有「未來 7 天」的可預約時段。

-- ── 商家 ──────────────────────────────────────────────────────────
insert into "store" (id, name, slug, phone_login_enabled, line_login_enabled, printer_enabled, newebpay_enabled, status, frontend_url)
values ('00000000-0000-0000-0000-000000000001', '示範早餐店', 'demo-breakfast', true, false, false, false, 'active', 'http://localhost:5173');

-- ── 商品分類 ──────────────────────────────────────────────────────
insert into "product_category" (id, name, sort_order, store_id) values
  ('00000000-0000-0000-0000-000000000101', '早餐', 1, '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000102', '飲料', 2, '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000103', '加購', 3, '00000000-0000-0000-0000-000000000001');

-- ── 商品（其中一項帶 advance_days/requires_payment_confirmation，示範預購流程）──
insert into "product" (id, name, description, origin_price, price, stock, is_enable, category_id, store_id, advance_days, requires_payment_confirmation) values
  ('00000000-0000-0000-0000-000000000201', '總匯蛋餅', '雞蛋、火腿、生菜', 55, 55, 200, true, '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', null, false),
  ('00000000-0000-0000-0000-000000000202', '古早味蘿蔔糕', '手工現煎', 45, 45, 200, true, '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', null, false),
  ('00000000-0000-0000-0000-000000000203', '季節限定水果鬆餅（預購）', '需提前一天預訂，現場付款需商家確認才算成立', 120, 120, 200, true, '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 1, true),
  ('00000000-0000-0000-0000-000000000204', '古早味紅茶', '大杯', 25, 25, null, true, '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', null, false),
  ('00000000-0000-0000-0000-000000000205', '無糖美式', '冰／熱皆可', 45, 45, null, true, '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', null, false),
  ('00000000-0000-0000-0000-000000000206', '生菜沙拉', '加購配餐', 30, 30, 200, true, '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001', null, false);

-- ── 加購選項 ──────────────────────────────────────────────────────
insert into "addon" (id, type, name, price, store_id) values
  ('00000000-0000-0000-0000-000000000301', 'option', '加蛋', 10, '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000302', 'option', '加起司', 15, '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000303', 'text', '備註（例如：不要辣）', 0, '00000000-0000-0000-0000-000000000001');

insert into "product_addon" (product_id, addon_id) values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301'),
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000302'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000301');

-- ── 付款方式 ──────────────────────────────────────────────────────
insert into "payment_method" (id, payment_method, store_id) overriding system value values
  (1, '現金（到店取貨付款）', '00000000-0000-0000-0000-000000000001'),
  (2, 'LINE Pay', '00000000-0000-0000-0000-000000000001');
select setval(pg_get_serial_sequence('"payment_method"', 'id'), 2);

-- ── 取餐時段（未來 7 天，每天兩個時段）──────────────────────────────
insert into "pickup_slot" (date, start_time, end_time, max_orders, store_id)
select d::date, s.start_time, s.end_time, 20, '00000000-0000-0000-0000-000000000001'
from generate_series(current_date, current_date + interval '6 days', interval '1 day') as d
cross join (values ('08:00'::time, '11:00'::time), ('11:00'::time, '14:00'::time)) as s(start_time, end_time);

-- ── 帳號 ──────────────────────────────────────────────────────────
-- 商家帳號：手機 0900000001 + 密碼 Demo1234!（走 POST /api/auth/login 手機+密碼登入，不用等 OTP）
insert into "user" (id, role, status, name, phone, phone_verified_at, store_id, password_hash) values
  ('00000000-0000-0000-0000-000000000401', 'MERCHANT', true, '示範商家', '0900000001', now(), '00000000-0000-0000-0000-000000000001', '$2a$10$olEOK/mo7mlhH2MjM0s6ZO4i4psB3UXEsWvk.WpInTegH7HlSU9G6');

-- 顧客帳號（示範用，未設密碼，走一般手機 OTP 流程）
insert into "user" (id, role, status, name, phone, phone_verified_at, store_id) values
  ('00000000-0000-0000-0000-000000000402', 'USER', true, '示範顧客', '0900000002', now(), '00000000-0000-0000-0000-000000000001');

-- ── 示範訂單（三種不同狀態，讓商家後台訂單列表/出貨/退款有東西可以操作）────
-- 訂單一：已付款、已出貨、已確認
insert into "order" (id, display_id, user_id, is_paid, paid_at, total_price, payment_method_id, is_ship, pickup_date, pickup_time, store_id, is_confirmed, confirmed_at) values
  ('00000000-0000-0000-0000-000000000501', 'DEMO00000001', '00000000-0000-0000-0000-000000000402', true, now() - interval '1 day', 100, 1, true, current_date, '09:00:00', '00000000-0000-0000-0000-000000000001', true, now() - interval '1 day');
insert into "order_item" (order_id, product_id, product_name, product_price, quantity, subtotal) values
  ('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000201', '總匯蛋餅', 55, 1, 55),
  ('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000204', '古早味紅茶', 25, 1, 25);

-- 訂單二：未付款、待商家接單
insert into "order" (id, display_id, user_id, is_paid, total_price, payment_method_id, is_ship, pickup_date, pickup_time, store_id) values
  ('00000000-0000-0000-0000-000000000502', 'DEMO00000002', '00000000-0000-0000-0000-000000000402', false, 45, 1, false, current_date + 1, '11:30:00', '00000000-0000-0000-0000-000000000001');
insert into "order_item" (order_id, product_id, product_name, product_price, quantity, subtotal) values
  ('00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-000000000202', '古早味蘿蔔糕', 45, 1, 45);

-- 訂單三：已取消
insert into "order" (id, display_id, user_id, is_paid, total_price, payment_method_id, is_ship, pickup_date, pickup_time, store_id, is_cancelled, cancelled_at) values
  ('00000000-0000-0000-0000-000000000503', 'DEMO00000003', '00000000-0000-0000-0000-000000000402', false, 45, 2, false, current_date, '13:00:00', '00000000-0000-0000-0000-000000000001', true, now() - interval '2 hours');
insert into "order_item" (order_id, product_id, product_name, product_price, quantity, subtotal) values
  ('00000000-0000-0000-0000-000000000503', '00000000-0000-0000-0000-000000000205', '無糖美式', 45, 1, 45);

-- ── 第二間商家（僅供跨租戶隔離測試用，見 test/idor-regression.test.js）──
insert into "store" (id, name, slug, status)
values ('00000000-0000-0000-0000-000000000002', '示範第二間商店（測試用）', 'demo-other-store', 'active');
insert into "product_category" (id, name, store_id) values
  ('00000000-0000-0000-0000-000000000104', '其他商店分類', '00000000-0000-0000-0000-000000000002');
insert into "product" (id, name, origin_price, price, is_enable, category_id, store_id) values
  ('00000000-0000-0000-0000-000000000207', '其他商店的商品', 50, 50, true, '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000002');
insert into "addon" (id, type, name, price, is_enable, store_id) values
  ('00000000-0000-0000-0000-000000000304', 'option', '其他商店的加購', 5, true, '00000000-0000-0000-0000-000000000002');
insert into "product_addon" (product_id, addon_id) values
  ('00000000-0000-0000-0000-000000000207', '00000000-0000-0000-0000-000000000304');

-- ── 平台層級參數設定（安全預設值）─────────────────────────────────
insert into "platform_config" (key, value) values
  ('alert_error_rate_threshold', '20'),
  ('alert_cooldown_minutes', '30'),
  ('alert_request_rate_threshold', '500'),
  ('alert_ip_rate_threshold', '100'),
  ('alert_latency_threshold', '3000');

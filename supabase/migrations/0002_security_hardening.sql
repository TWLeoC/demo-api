-- 0002_security_hardening.sql
-- 資安檢查 Phase 1（twleoc/demo-api）：擴充 api_log 欄位、新增告警落地紀錄表。
-- 對應「請求日誌與掃描告警設計筆記」修復規劃第一階段。

-- api_log 補齊筆記要求的加值欄位：user_agent / referer 用來區分掃描工具、
-- 正常瀏覽器、監控服務；full_path 含 query string（掃描特徵常藏在參數裡，
-- 原本的 path 欄位不含 query string）；bytes 供異常流量判讀。
-- is_scan：已知自動化掃描路徑（wp-*、xmlrpc.php…）原本直接不寫入 api_log，
-- 等於「全記錄」原則名存實亡——改成照樣寫入，只是標記起來，統計錯誤率／
-- 告警時排除即可，稽核時仍查得到。
alter table "api_log"
  add column if not exists "user_agent" text,
  add column if not exists "referer" text,
  add column if not exists "full_path" text,
  add column if not exists "bytes" integer,
  add column if not exists "is_scan" boolean not null default false;

-- alertService.js 的滑動窗口統計、honeypotPaths 之後的稽核查詢都是
-- by ip / by created_at 範圍查詢，資料量大了之後沒有索引會全表掃描
create index if not exists "api_log_created_at_idx" on "api_log" ("created_at");
create index if not exists "api_log_ip_created_at_idx" on "api_log" ("ip", "created_at");

-- 告警落地紀錄：舊版聚合式告警（alertService.js）只靠 LINE 推播，推播失敗
-- 或訊息被滑掉就完全查不到、無法事後稽核；honeypot 即時封鎖也一併寫進來，
-- 兩種告警來源（單筆高訊號 / 窗口聚合）統一落地，供 dashboard 呈現。
create table if not exists "security_alert" (
  "id" uuid not null default gen_random_uuid(),
  "type" text not null,
  "severity" text not null default 'medium'::text
    check (severity = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text])),
  "ip" text,
  "message" text not null,
  "created_at" timestamptz not null default now(),
  primary key ("id")
);

create index if not exists "security_alert_created_at_idx" on "security_alert" ("created_at");

-- 權限：比照 0001_init.sql 的作法，CREATE TABLE 不會自動套用 default
-- privileges，明確 GRANT 一次（此陳述式為冪等操作，重複執行安全）
grant all on all tables in schema public to anon, authenticated, service_role;

const supabase = require('../config/supabase')

const PLAN_TIERS = ['entry', 'growth', 'flagship']
const CONFIG_KEY = 'plan_features'

// 存在 platform_config（key/value 都是 text）的一列 JSON 字串，同一張表也被
// alertService.js 拿來存全平台設定，照抄同樣的讀寫模式，不用新開一張表
const getPlanFeatures = async () => {
  const { data, error } = await supabase
    .from('platform_config')
    .select('value')
    .eq('key', CONFIG_KEY)
    .maybeSingle()
  if (error) throw error
  if (!data?.value) return null
  return JSON.parse(data.value)
}

const savePlanFeatures = async (planFeatures) => {
  const { error } = await supabase
    .from('platform_config')
    .upsert({ key: CONFIG_KEY, value: JSON.stringify(planFeatures), updated_at: new Date().toISOString() })
  if (error) throw error
}

// 把某個 tier 的預設功能值轉成可以直接寫進 store 表的欄位（跟 updateStore
// 既有的個別欄位判斷式共用同一組 updates 物件——這裡先套用預設值，若同一次
// 請求也帶了個別欄位的明確值，updateStore 裡後面的判斷式會覆蓋掉這裡的值）
const applyPlanTierToStoreUpdates = (updates, preset) => {
  if (!preset) return
  if (preset.newebpay !== undefined) updates.newebpay_enabled = preset.newebpay
  if (preset.newebpay_custom !== undefined) updates.newebpay_custom_allowed = preset.newebpay_custom
  if (preset.printer !== undefined) updates.printer_enabled = preset.printer
  if (preset.customer_notify !== undefined) updates.customer_notify_enabled = preset.customer_notify
}

module.exports = { PLAN_TIERS, getPlanFeatures, savePlanFeatures, applyPlanTierToStoreUpdates }

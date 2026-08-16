const supabase = require('../config/supabase')
const { verifyTradeSha, decryptTradeInfo } = require('../utils/newebpay')
const { getNewebPaySettings } = require('../utils/storePayment')
const { triggerDeferredOrderNotifications } = require('../services/deferredOrderNotify')

const STORE_SELECT = 'id, frontend_url, newebpay_mode, newebpay_custom_allowed, newebpay_merchant_id, newebpay_hash_key, newebpay_hash_iv'

const getStore = async (storeId) => {
  if (!storeId) return null
  const { data } = await supabase.from('store').select(STORE_SELECT).eq('id', storeId).maybeSingle()
  return data
}

// 藍新 ReturnURL 是用瀏覽器 POST 導回，但前端是純靜態 SPA 無法處理 POST，
// 所以 ReturnURL 指向這支後端端點，這裡收下 POST 後再用 303 轉成 GET 導去前端頁面
const returnRedirect = async (req, res) => {
  let orderId = ''
  let frontendUrl = process.env.API_BASE_URL // 沒查到 store 時的保底，理論上不會發生
  try {
    const store = await getStore(req.query.store_id)
    if (store) {
      frontendUrl = store.frontend_url || frontendUrl
      const { hashKey, hashIv } = getNewebPaySettings(store)
      const { TradeInfo, TradeSha } = req.body
      if (TradeInfo && TradeSha && verifyTradeSha(TradeInfo, TradeSha, hashKey, hashIv)) {
        // MerchantOrderNo 重新付款時會是 `${display_id}R${timestamp}`（見
        // orderController.updatePaymentMethod 註解），display_id 固定 12 碼數字，
        // 取前 12 碼還原成真正的訂單編號
        const merchantOrderNo = decryptTradeInfo(TradeInfo, hashKey, hashIv).MerchantOrderNo || ''
        const displayId = merchantOrderNo.slice(0, 12)
        if (displayId) {
          const { data: order } = await supabase.from('order').select('id').eq('display_id', displayId).eq('store_id', store.id).maybeSingle()
          orderId = order?.id || ''
        }
      }
    }
  } catch { /* 導頁優先，解析失敗不影響轉址 */ }

  const url = new URL(orderId ? `/orders/${orderId}` : '/orders', frontendUrl)
  if (orderId) url.searchParams.set('from', 'payment')
  res.redirect(303, url.toString())
}

const notify = async (req, res) => {
  try {
    const store = await getStore(req.query.store_id)
    if (!store) {
      console.warn(`[NewebPay] notify 帶的 store_id 查無商家: ${req.query.store_id}`)
      return res.send('0|Error')
    }
    const { hashKey, hashIv } = getNewebPaySettings(store)

    const { TradeInfo, TradeSha } = req.body
    if (!TradeInfo || !TradeSha || !verifyTradeSha(TradeInfo, TradeSha, hashKey, hashIv)) {
      console.warn('[NewebPay] invalid signature on payment notify')
      return res.send('0|Error')
    }

    const data = decryptTradeInfo(TradeInfo, hashKey, hashIv)
    if (data.Status !== 'SUCCESS') return res.send('1|OK')

    // MerchantOrderNo 重新付款時會是 `${display_id}R${timestamp}`（見
    // orderController.updatePaymentMethod 註解），display_id 固定 12 碼數字，取前 12 碼還原
    const displayId = (data.MerchantOrderNo || '').slice(0, 12)

    // 簽章驗證只證明「藍新簽過這包資料」，不代表金額沒被動過手腳（例如訂單金額事後被改），
    // 標記付款前多一層金額交叉驗證，避免用一筆金額對不上的付款把訂單標記成已付款
    const { data: pendingOrder } = await supabase
      .from('order')
      .select('id, total_price, is_paid')
      .eq('display_id', displayId)
      .eq('store_id', store.id)
      .maybeSingle()

    if (pendingOrder && !pendingOrder.is_paid && Number(data.Amt) !== pendingOrder.total_price) {
      console.error(`[NewebPay] 金額不符，拒絕標記付款：order=${pendingOrder.id} display_id=${displayId} expected=${pendingOrder.total_price} got=${data.Amt}`)
      return res.send('0|Error')
    }

    // 條件式 UPDATE（只更新 is_paid=false 的）保證幂等
    const { data: order, error: updateErr } = await supabase
      .from('order')
      .update({
        is_paid: true,
        paid_at: new Date().toISOString(),
        newebpay_trade_no: data.TradeNo,
        newebpay_payment_type: data.PaymentType || null, // CREDIT/WEBATM/VACC/CVS 等，之後判斷能否走信用卡退款用
      })
      .eq('display_id', displayId)
      .eq('store_id', store.id)
      .eq('is_paid', false)
      .select('id')
      .maybeSingle()

    if (updateErr) throw updateErr

    if (order) {
      await triggerDeferredOrderNotifications(order.id)
    }
    // order 為 null：可能是重複 webhook（已經是 paid，正常幂等），略過即可

    return res.send('1|OK')
  } catch (err) {
    console.error('[NewebPay notify error]', err)
    return res.send('0|Error')
  }
}

module.exports = { notify, returnRedirect }

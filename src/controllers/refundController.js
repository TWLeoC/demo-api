const supabase = require('../config/supabase')
const { success, error } = require('../utils/response')
const { buildCloseRequestBody, buildCancelRequestBody, verifyCheckCode } = require('../utils/newebpay')
const { getNewebPaySettings } = require('../utils/storePayment')
const { writeAuditLog } = require('../utils/auditLog')

const callNewebPayApi = async (url, body) => {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const text = await resp.text()
  return JSON.parse(text) // RespondType=JSON，這兩支 API 回應本身是明碼 JSON，不用解密
}

// POST /api/orders/merchant/:id/refund
// 只支援信用卡（PaymentType=CREDIT）。ATM 轉帳/超商代碼藍新沒有 API 退款，
// 只能商家自行手動處理，這裡不支援。
//
// 先試「取消授權」（CreditCard/Cancel）：如果訂單剛付款完、藍新那邊還沒真正
// 請款完成，這支可以完全撤銷授權，錢沒有真的流動過。如果失敗（代表已經
// 請款完成，不能再取消），改用「請退款」（CreditCard/Close，CloseType=2）
// 才是真正把已入帳的錢退回去。兩者對顧客而言結果相同（沒被扣款/錢退回），
// 用哪一種完全視交易當下的狀態而定，不需要商家自己判斷。
const refundOrder = async (req, res, next) => {
  try {
    const { id } = req.params

    const { data: order, error: findErr } = await supabase
      .from('order')
      .select('id, display_id, is_paid, total_price, newebpay_trade_no, newebpay_payment_type, is_refunded, store_id')
      .eq('id', id)
      .eq('store_id', req.storeId)
      .single()

    if (findErr || !order) return error(res, '訂單不存在', 404)
    if (!order.is_paid) return error(res, '訂單尚未付款，無法退款', 400)
    if (!order.newebpay_trade_no) return error(res, '這筆訂單不是線上刷卡付款，無法用此功能退款', 400)
    if (order.newebpay_payment_type !== 'CREDIT') {
      return error(res, `付款方式為 ${order.newebpay_payment_type || '未知'}，藍新不提供 API 退款，需自行手動處理`, 400)
    }
    if (order.is_refunded) return error(res, '這筆訂單已經退款過了', 409)

    const { data: store, error: storeErr } = await supabase
      .from('store')
      .select('newebpay_mode, newebpay_custom_allowed, newebpay_merchant_id, newebpay_hash_key, newebpay_hash_iv')
      .eq('id', req.storeId)
      .single()
    if (storeErr || !store) return error(res, '找不到商家資料', 404)

    const { merchantId, hashKey, hashIv } = getNewebPaySettings(store)
    const commonParams = {
      merchantId,
      tradeNo: order.newebpay_trade_no,
      merchantOrderNo: order.display_id,
      amt: order.total_price,
    }

    let result = null
    let method = null

    // Step 1：先試取消授權
    try {
      const cancelBody = buildCancelRequestBody(commonParams, hashKey, hashIv)
      const cancelData = await callNewebPayApi(process.env.NEWEBPAY_CANCEL_API_URL, cancelBody)
      // TRA20001：需由金融機構批次處理，代表取消授權已受理、只是非即時生效，
      // 一樣視為成功，不要再往下改打退款（避免對同一筆交易重複動作）
      if (cancelData.Status === 'SUCCESS' || cancelData.Status === 'TRA20001') {
        result = cancelData.Result
        method = cancelData.Status === 'TRA20001' ? 'cancel_pending' : 'cancel'
      } else {
        console.warn('[NewebPay cancel] 無法取消授權（可能已請款完成），改試退款:', cancelData.Message)
      }
    } catch (err) {
      console.warn('[NewebPay cancel] 呼叫失敗，改試退款:', err.message)
    }

    // Step 2：取消授權不成功（通常代表已經請款完成），改用退款
    if (!result) {
      const closeBody = buildCloseRequestBody({ ...commonParams, closeType: 2 }, hashKey, hashIv)
      let closeData
      try {
        closeData = await callNewebPayApi(process.env.NEWEBPAY_REFUND_API_URL, closeBody)
      } catch (err) {
        console.error('[NewebPay close] 回應解析失敗:', err.message)
        return error(res, '藍新退款回應格式異常，請稍後重試或聯繫技術支援', 502)
      }
      if (closeData.Status !== 'SUCCESS') {
        console.error('[NewebPay close] 失敗:', closeData)
        return error(res, closeData.Message || '藍新退款失敗', 502)
      }
      result = closeData.Result
      method = 'close'
    }

    const checkCodeOk = verifyCheckCode(
      { Amt: result.Amt, MerchantID: result.MerchantID, MerchantOrderNo: result.MerchantOrderNo, TradeNo: result.TradeNo },
      result.CheckCode,
      hashKey,
      hashIv
    )
    if (!checkCodeOk) {
      // CheckCode 驗證失敗代表回應內容可能被竄改或跟我們的請求對不上，錢有沒有
      // 真的處理成功無法從這個回應確認，不要標記已退款，交給人工去藍新後台核對
      console.error('[NewebPay refund] CheckCode 驗證失敗:', result)
      return error(res, '藍新回應驗證失敗，請至藍新後台確認實際狀態，勿重複操作', 502)
    }

    // 退款成功代表這筆訂單不會再出貨，一併標記已取消，避免員工看到「待接單」
    // 誤以為還要備餐/出貨（退款前的接單/出貨狀態已經沒有意義了）。
    // 加 is_refunded=false 條件式更新（比照付款 webhook 的既有寫法），避免兩個
    // 幾乎同時的退款請求都通過了最上面的 is_refunded 檢查，各自把這筆訂單的
    // 退款紀錄覆蓋一次
    const { data: updated, error: updateErr } = await supabase
      .from('order')
      .update({
        is_refunded: true,
        refunded_at: new Date().toISOString(),
        refund_amount: Number(result.Amt),
        is_cancelled: true,
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('is_refunded', false)
      .select('id')
      .maybeSingle()
    if (updateErr) throw updateErr
    if (!updated) {
      console.warn(`[NewebPay refund] order=${id} 更新時已被標記為已退款（可能是重複請求），藍新那邊已呼叫過 ${method}，請至後台確認實際退款狀態`)
      return error(res, '這筆訂單已經退款過了', 409)
    }

    writeAuditLog(req, 'refund_order', 'order', id, { display_id: order.display_id, method, amount: Number(result.Amt) })

    const message = {
      cancel: '取消授權成功，這筆交易沒有真的請款，不會扣款',
      cancel_pending: '取消授權已受理，將由金融機構批次處理完成',
      close: '退款成功',
    }[method]

    return success(res, { refund_amount: Number(result.Amt), method }, message)
  } catch (err) {
    next(err)
  }
}

module.exports = { refundOrder }

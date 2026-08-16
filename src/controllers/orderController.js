const supabase = require('../config/supabase')
const { success, error, paginate } = require('../utils/response')
const { pushOrderNotification, pushCustomerNotification } = require('../services/lineService')
const { addJob } = require('../cloudprnt/queue')
const { writeAuditLog } = require('../utils/auditLog')
const { buildTradeInfo, buildTradeSha } = require('../utils/newebpay')
const { getNewebPaySettings } = require('../utils/storePayment')
const { fetchApplicableGiftRules } = require('./giftRuleController')
const { calculateGiftEligibility, validateGiftChoice } = require('../utils/giftCalculator')

// 「不用選」的贈品規則只有 1 個頂層 option，但那個 option 也可能是分組節點
// （理論上設定錯誤時），保險起見往下找到第一個真正的葉節點（有 product_id 的）
const findLeafOption = (option) => {
  if (!option) return null
  if (option.product_id) return option
  if (option.children?.length) return findLeafOption(option.children[0])
  return null
}

// 組藍新付款表單資料。display_id（現有訂單編號，12 碼純數字）直接拿來當
// MerchantOrderNo 用，符合藍新「英數字、最長 30 字元」的限制，不用另外產生。
// merchantOrderNo 可選傳入覆蓋值——同一張訂單重新前往付款（updatePaymentMethod）
// 時每次都要是新的 MerchantOrderNo，不然藍新會用 display_id 判斷成重複訂單編號
// 直接擋下（MPG03008「已存在相同的商店訂單編號」），顧客付款失敗後永遠卡住不能重試
const buildNewebPayFormData = ({ store, displayId, merchantOrderNo, amount, itemDesc }) => {
  const { merchantId, hashKey, hashIv } = getNewebPaySettings(store)
  const params = {
    MerchantID: merchantId,
    RespondType: 'JSON',
    TimeStamp: Math.floor(Date.now() / 1000).toString(),
    Version: '2.2',
    MerchantOrderNo: merchantOrderNo || displayId,
    Amt: Math.round(amount).toString(),
    ItemDesc: itemDesc || '線上訂購',
    NotifyURL: `${process.env.API_BASE_URL}/api/payment/newebpay/notify?store_id=${store.id}`,
    // 前端是純靜態 SPA 無法處理藍新的 POST 導回，先導到後端這支路由轉成 GET 再導去前端
    ReturnURL: `${process.env.API_BASE_URL}/api/payment/newebpay/return?store_id=${store.id}`,
  }
  const TradeInfo = buildTradeInfo(params, hashKey, hashIv)
  const TradeSha = buildTradeSha(TradeInfo, hashKey, hashIv)
  return {
    paymentUrl: process.env.NEWEBPAY_API_URL,
    formData: { MerchantID: params.MerchantID, TradeInfo, TradeSha, Version: params.Version },
  }
}

const generateDisplayId = () => {
  const now = new Date()
  const date = now.toISOString().slice(2, 10).replace(/-/g, '')
  const rand = Math.floor(Math.random() * 1000000).toString().padStart(6, '0')
  return `${date}${rand}`
}

// POST /orders
const createOrder = async (req, res, next) => {
  try {
    const { pickup_slot_id, pickup_time, payment_method_id, is_test, note } = req.body
    const isTest = is_test === true && req.user?.role === 'MERCHANT'
    const userId = req.user.id
    const storeId = req.storeId

    // 檢查商家營業狀態
    const { data: storeStatus } = await supabase
      .from('store')
      .select(`
        id, name, is_open, rush_until, status, frontend_url,
        newebpay_mode, newebpay_custom_allowed, newebpay_merchant_id, newebpay_hash_key, newebpay_hash_iv
      `)
      .eq('id', storeId)
      .single()

    // 有設定取餐時段的商家（實體店面）不受 is_open 限制
    const { count: slotCount } = await supabase
      .from('pickup_slot')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId)

    if (slotCount === 0 && !storeStatus?.is_open) {
      return error(res, '商家今日尚未出攤，無法下單', 400)
    }
    if (storeStatus?.rush_until && new Date(storeStatus.rush_until) > new Date()) {
      return error(res, '商家目前忙碌中，請稍後再試', 400)
    }

    // 藍新線上付款：這筆訂單選的付款方式是不是自動管理的「線上刷卡」選項
    let isNewebPayOrder = false
    if (payment_method_id) {
      const { data: pm } = await supabase
        .from('payment_method')
        .select('provider')
        .eq('id', payment_method_id)
        .eq('store_id', storeId)
        .maybeSingle()
      isNewebPayOrder = pm?.provider === 'newebpay'
    }

    // 取得手機末三碼與商家名稱
    const [{ data: userProfile }] = await Promise.all([
      supabase.from('user').select('phone, name, line_id').eq('id', userId).single(),
    ])
    const storeProfile = storeStatus
    const phoneLast3 = userProfile?.phone?.slice(-3) || '???'
    const userName = userProfile?.name || ''
    const storeName = storeProfile?.name || ''

    // 取得購物車
    const { data: cart } = await supabase.from('cart').select('*').eq('user_id', userId).eq('store_id', storeId).single()
    if (!cart) return error(res, '購物車不存在', 400)

    const { data: cartItems } = await supabase
      .from('cart_item')
      .select(`
        id, quantity, note,
        product ( id, name, price, stock, category_id, advance_days, requires_payment_confirmation, campaign_id ),
        cart_item_addon ( addon ( id, name, price ) )
      `)
      .eq('cart_id', cart.id)

    // 查詢分類名稱
    const categoryIds = [...new Set(cartItems.map(i => i.product?.category_id).filter(Boolean))]
    let categoryMap = {}
    if (categoryIds.length > 0) {
      const { data: cats } = await supabase
        .from('product_category')
        .select('id, name')
        .in('id', categoryIds)
      categoryMap = Object.fromEntries((cats || []).map(c => [c.id, c.name]))
    }

    if (!cartItems?.length) return error(res, '購物車為空', 400)

    // 購物車混單已經在加入購物車當下擋掉，這裡整車商品的 campaign_id 必然一致
    const campaignId = cartItems[0].product.campaign_id ?? null
    let campaign = null
    if (campaignId) {
      const { data: c } = await supabase
        .from('campaign')
        .select('id, name, pickup_start_date, pickup_end_date, payment_deadline_days')
        .eq('id', campaignId)
        .single()
      campaign = c
    }

    // 付款期限「跟著訂單跑」：下單當下時間 + N 天，不是檔期共用同一個固定日期
    // （否則越晚下單的人付款時間越短）。但不能超過檔期本身的取貨結束日，避免
    // 「東西都該取貨了、付款期限卻還沒到」這種矛盾情況，取兩者較早的
    let paymentDeadlineAt = null
    if (campaign?.payment_deadline_days) {
      const rawDeadline = new Date(Date.now() + campaign.payment_deadline_days * 24 * 60 * 60 * 1000)
      const pickupEndOfDay = new Date(`${campaign.pickup_end_date}T23:59:59`)
      paymentDeadlineAt = rawDeadline < pickupEndOfDay ? rawDeadline : pickupEndOfDay
    }

    // 驗證取貨時段
    let pickup_date = null
    if (pickup_slot_id) {
      if (!pickup_time) return error(res, '請填入取貨時間', 400)
      const { data: slot } = await supabase
        .from('pickup_slot')
        .select('date, start_time, end_time, is_enable, campaign_id')
        .eq('id', pickup_slot_id)
        .eq('store_id', storeId)
        .single()
      if (!slot || !slot.is_enable) return error(res, '取餐時段不存在或已關閉', 400)
      if ((slot.campaign_id ?? null) !== campaignId) return error(res, '取貨時段與購物車商品的檔期不符', 400)
      if (pickup_time < slot.start_time || pickup_time >= slot.end_time) {
        return error(res, `取貨時間須在 ${slot.start_time} ~ ${slot.end_time} 之間`, 400)
      }
      // 前端只在載入時段列表當下把過去的時間濾掉，顧客選完到送出訂單之間可能停留
      // 幾分鐘，如果選到的剛好是今天最後一個時段，送出當下時段可能已經過了——這裡
      // 要再驗證一次，不能只信任前端當初的過濾（2026-08 發現有訂單下單時間晚於取餐時間）
      const nowTaipei = new Date(Date.now() + 8 * 60 * 60 * 1000)
      const todayTaipei = nowTaipei.toISOString().slice(0, 10)
      if (slot.date === todayTaipei && pickup_time <= nowTaipei.toISOString().slice(11, 19)) {
        return error(res, '此取餐時段已過，請重新選擇取餐時間', 400)
      }
      pickup_date = slot.date
    } else if (campaignId) {
      return error(res, '此檔期商品需選擇取貨時段', 400)
    } else if (slotCount > 0) {
      // 商家有設定取貨時段（不論一般或檔期），代表這家店是排程出餐模式，
      // 所有訂單都要選時段，商家才知道什麼時候要準備。完全沒設過時段的店
      // （純現場出攤、靠 is_open 開關）才維持不強制選
      return error(res, '請選擇取貨時段', 400)
    }

    if (campaignId) {
      // 檔期商品：用絕對取貨區間驗證，取代 advance_days
      if (!campaign) return error(res, '檔期不存在', 400)
      if (pickup_date < campaign.pickup_start_date || pickup_date > campaign.pickup_end_date) {
        return error(res, `「${campaign.name}」取貨日期須介於 ${campaign.pickup_start_date} ~ ${campaign.pickup_end_date} 之間`, 400)
      }
    } else {
      // 一般商品：驗證 advance_days（比照前端 OrderSection.jsx 的 diffDays 算法）
      for (const item of cartItems) {
        const advanceDays = item.product.advance_days
        if (advanceDays && advanceDays > 0) {
          if (!pickup_date) {
            return error(res, `「${item.product.name}」需提前 ${advanceDays} 天預訂，請先選擇取餐日期`, 400)
          }
          const today = new Date()
          today.setHours(0, 0, 0, 0)
          const pickupDateObj = new Date(pickup_date)
          pickupDateObj.setHours(0, 0, 0, 0)
          const diffDays = Math.round((pickupDateObj - today) / (1000 * 60 * 60 * 24))
          if (diffDays < advanceDays) {
            return error(res, `「${item.product.name}」需提前 ${advanceDays} 天預訂，最早可選 ${advanceDays} 天後的日期`, 400)
          }
        }
      }
    }

    // 取得折扣
    let discount = null
    if (cart.discount_id) {
      const { data: d } = await supabase.from('discount_method').select('*').eq('id', cart.discount_id).single()
      discount = d
    }

    // 計算金額
    let subtotal = 0
    for (const item of cartItems) {
      const addonTotal = item.cart_item_addon.reduce((sum, a) => sum + (a.addon?.price || 0), 0)
      subtotal += (item.product.price + addonTotal) * item.quantity
    }

    let totalPrice = subtotal
    if (discount) {
      totalPrice = Math.round(totalPrice * discount.discount_percent) - discount.discount_price
    }

    // 贈品：用當下即時資料重新算一次資格，不能只信前端算的結果（比照下面庫存/檔期
    // 時間窗都會重新查一次驗證的既有寫法）。gift_choices/gift_addon_purchases
    // 是顧客在購物車畫面上做的選擇，這裡逐一驗證後才決定真正要附上哪些贈品品項
    const { gift_choices: giftChoices = [], gift_addon_purchases: giftAddonPurchases = [] } = req.body
    const giftRules = await fetchApplicableGiftRules(storeId)
    const cartItemsForGift = cartItems.map(item => {
      const addonTotal = item.cart_item_addon.reduce((sum, a) => sum + (a.addon?.price || 0), 0)
      return {
        product_id: item.product.id,
        category_id: item.product.category_id ?? null,
        campaign_id: item.product.campaign_id ?? null,
        quantity: item.quantity,
        unit_price: item.product.price + addonTotal,
      }
    })
    const eligibleGifts = calculateGiftEligibility({ cartItems: cartItemsForGift, campaignId, rules: giftRules })

    const giftLineItems = []
    for (const gift of eligibleGifts) {
      if (gift.mode === 'addon_purchase') {
        const purchase = giftAddonPurchases.find(p => p.gift_rule_id === gift.gift_rule_id)
        if (!purchase) continue
        const quantity = Number(purchase.quantity)
        if (!Number.isInteger(quantity) || quantity < 1) return error(res, `「${gift.name}」的加購數量無效`, 400)
        // remaining_redemptions 是這個規則/共用庫存池「現在」還剩多少，顧客結帳當下
        // 才重新查一次，不能只信前端購物車畫面顯示的數字（可能已經被別的訂單搶走）
        if (gift.remaining_redemptions != null && quantity > gift.remaining_redemptions) {
          return error(res, `「${gift.name}」剩餘 ${gift.remaining_redemptions} 個，數量超過剩餘庫存`, 400)
        }
        const leafOption = findLeafOption(gift.options[0])
        if (!leafOption) continue
        giftLineItems.push({ gift_rule_id: gift.gift_rule_id, product_id: leafOption.product_id, product_name: leafOption.label, product_price: gift.addon_price, quantity })
        continue
      }
      if (gift.requires_choice) {
        const choice = giftChoices.find(c => c.gift_rule_id === gift.gift_rule_id)
        if (!choice) return error(res, `請選擇「${gift.name}」的贈品選項`, 400)
        const validation = validateGiftChoice({ options: gift.options }, choice.option_id)
        if (!validation.valid) return error(res, `「${gift.name}」的贈品選項無效：${validation.reason}`, 400)
        giftLineItems.push({ gift_rule_id: gift.gift_rule_id, product_id: validation.option.product_id, product_name: validation.option.label, product_price: 0, quantity: gift.qty })
        continue
      }
      const leafOption = findLeafOption(gift.options[0])
      if (!leafOption) continue
      giftLineItems.push({ gift_rule_id: gift.gift_rule_id, product_id: leafOption.product_id, product_name: leafOption.label, product_price: 0, quantity: gift.qty })
    }

    const giftSurcharge = giftLineItems.reduce((s, g) => s + g.product_price * g.quantity, 0)
    totalPrice += giftSurcharge

    const requiresConfirm = cartItems.some(i => i.product.requires_payment_confirmation)

    // 重新查詢即時庫存，避免用購物車查詢當下的舊資料扣減（擋掉單一請求內的庫存不足）
    const productIds = [...new Set(cartItems.map(i => i.product.id))]
    const { data: freshProducts } = await supabase
      .from('product')
      .select('id, name, stock')
      .in('id', productIds)
    const freshStockMap = Object.fromEntries((freshProducts || []).map(p => [p.id, p]))
    for (const item of cartItems) {
      const fresh = freshStockMap[item.product.id]
      if (fresh && fresh.stock !== null && fresh.stock < item.quantity) {
        return error(res, `「${fresh.name}」庫存不足，剩餘 ${fresh.stock} 件`, 400)
      }
    }

    // 建立訂單
    const displayId = generateDisplayId()
    const { data: order, error: orderError } = await supabase
      .from('order')
      .insert({
        display_id: displayId,
        user_id: userId,
        store_id: storeId,
        is_paid: false,
        is_test: isTest,
        discount_id: cart.discount_id,
        shipping_fee: 0,
        total_price: totalPrice,
        payment_method_id,
        pickup_date: pickup_date || null,
        pickup_time: pickup_time || null,
        note: note || null,
        requires_payment_confirmation: requiresConfirm,
        campaign_id: campaignId,
        payment_deadline_at: paymentDeadlineAt ? paymentDeadlineAt.toISOString() : null,
      })
      .select()
      .single()

    if (orderError) throw orderError

    // 建立 order_item
    for (const item of cartItems) {
      const addonTotal = item.cart_item_addon.reduce((sum, a) => sum + (a.addon?.price || 0), 0)
      const itemSubtotal = (item.product.price + addonTotal) * item.quantity

      const { data: orderItem, error: itemError } = await supabase
        .from('order_item')
        .insert({
          order_id: order.id,
          product_id: item.product.id,
          product_name: item.product.name,
          product_price: item.product.price,
          quantity: item.quantity,
          subtotal: itemSubtotal,
          note: item.note || null,
        })
        .select()
        .single()

      if (itemError) throw itemError

      if (item.cart_item_addon.length) {
        const addonInserts = item.cart_item_addon.map(a => ({
          order_item_id: orderItem.id,
          addon_id: a.addon.id,
          addon_name: a.addon.name,
          addon_price: a.addon.price,
        }))
        await supabase.from('order_item_addon').insert(addonInserts)
      }

      const fresh = freshStockMap[item.product.id]
      if (fresh && fresh.stock !== null) {
        await supabase
          .from('product')
          .update({ stock: fresh.stock - item.quantity })
          .eq('id', item.product.id)
      }
    }

    // 建立贈品 order_item（product_price 免費贈送是 0、加購是實收的加購金額；
    // 不動用到贈品實際商品的 stock 欄位——贈品的數量上限是靠 gift_rule.max_redemptions
    // 控管，跟商品本身的庫存是兩件事）
    for (const gift of giftLineItems) {
      await supabase.from('order_item').insert({
        order_id: order.id,
        product_id: gift.product_id,
        product_name: gift.product_name,
        product_price: gift.product_price,
        quantity: gift.quantity,
        subtotal: gift.product_price * gift.quantity,
        is_gift: true,
        gift_rule_id: gift.gift_rule_id,
      })
    }

    // 清空購物車
    await supabase.from('cart_item').delete().eq('cart_id', cart.id)
    await supabase.from('cart').update({ discount_id: null }).eq('id', cart.id)

    const orderItems = cartItems.map(item => ({
      name: item.product.name,
      category: categoryMap[item.product?.category_id] || '',
      product_price: item.product.price,
      quantity: item.quantity,
      note: item.note || null,
      addons: item.cart_item_addon.map(a => ({ name: a.addon.name, price: a.addon.price })),
    })).concat(giftLineItems.map(g => ({
      name: g.product_name,
      category: '贈品',
      product_price: g.product_price,
      quantity: g.quantity,
      note: null,
      addons: [],
      is_gift: true,
    })))

    // 藍新線上付款訂單：這時候顧客還沒付款，通知/出單要等 webhook 確認付款成功
    // 後才觸發（見 paymentController.notify），不然顧客棄單也會誤觸發廚房出單
    if (!isTest && !isNewebPayOrder) {
      // LINE 推播通知（fire-and-forget）
      pushOrderNotification({
        storeId,
        orderId: order.id,
        displayId,
        userName,
        phoneLast3,
        items: orderItems,
        subtotal,
        discount,
        totalPrice,
        pickupDate: pickup_date,
        pickupTime: pickup_time || null,
        note: note || null,
        isPaid: false,
      })

      // CloudPRNT 列印（fire-and-forget，router 依 printer_enabled 決定是否服務）
      addJob(storeId, {
        storeName,
        displayId,
        userName,
        phoneLast3,
        items: orderItems,
        subtotal,
        discount,
        totalPrice,
        pickupDate: pickup_date,
        pickupTime: pickup_time || null,
        note: note || null,
        isPaid: false,
      })
    } else if (isTest) {
      console.log(`[Order] 測試訂單 ${displayId}，跳過通知與出單`)
    } else {
      console.log(`[Order] 藍新線上付款訂單 ${displayId}，通知與出單將於付款成功後觸發`)
    }

    if (isNewebPayOrder) {
      const { paymentUrl, formData } = buildNewebPayFormData({
        store: storeStatus,
        displayId,
        amount: totalPrice,
        itemDesc: storeName,
      })
      return success(res, { order_id: order.id, display_id: displayId, total_price: totalPrice, paymentUrl, formData }, '訂單已建立，請完成付款', 201)
    }

    return success(res, { order_id: order.id, display_id: displayId, total_price: totalPrice }, '訂單建立成功', 201)
  } catch (err) {
    next(err)
  }
}

// GET /orders
const getOrders = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query
    const from = (page - 1) * limit
    const to = from + Number(limit) - 1

    const { data, count, error: dbError } = await supabase
      .from('order')
      .select('id, display_id, is_paid, is_ship, is_confirmed, is_cancelled, requires_payment_confirmation, campaign_id, payment_deadline_at, total_price, shipping_fee, created_at', { count: 'exact' })
      .eq('user_id', req.user.id)
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (dbError) throw dbError
    return paginate(res, data, count, page, limit)
  } catch (err) {
    next(err)
  }
}

// GET /orders/:id
const getOrder = async (req, res, next) => {
  try {
    const { id } = req.params
    const { data, error: dbError } = await supabase
      .from('order')
      .select(`
        id, display_id, is_paid, is_ship, is_confirmed, is_cancelled, cancelled_at, receipt, paid_at, shipping_fee, total_price, pickup_date, pickup_time, created_at, requires_payment_confirmation, campaign_id, payment_deadline_at, payment_method_id,
        discount_method ( discount_kol, discount_percent, discount_price ),
        payment_method ( payment_method, provider ),
        order_item (
          id, product_id, product_name, product_price, quantity, subtotal, note, is_gift,
          order_item_addon ( addon_id, addon_name, addon_price )
        )
      `)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .eq('store_id', req.storeId)
      .single()

    if (dbError || !data) return error(res, '訂單不存在', 404)
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

// PATCH /orders/merchant/:id/items/:itemId
const updateOrderItem = async (req, res, next) => {
  try {
    const { id, itemId } = req.params
    const { quantity } = req.body

    const { data: order } = await supabase.from('order').select('id, display_id, is_paid').eq('id', id).eq('store_id', req.storeId).single()
    if (!order) return error(res, '訂單不存在', 404)
    if (order.is_paid) return error(res, '訂單已確認，無法修改', 400)

    const { data: item } = await supabase.from('order_item').select('id, product_name, product_price, quantity, order_item_addon(addon_price)').eq('id', itemId).eq('order_id', id).single()
    if (!item) return error(res, '項目不存在', 404)

    const addonTotal = item.order_item_addon.reduce((s, a) => s + (a.addon_price || 0), 0)
    const newSubtotal = (item.product_price + addonTotal) * quantity

    await supabase.from('order_item').update({ quantity, subtotal: newSubtotal }).eq('id', itemId)

    const { data: allItems } = await supabase.from('order_item').select('subtotal').eq('order_id', id)
    const newTotal = allItems.reduce((s, i) => s + i.subtotal, 0)
    await supabase.from('order').update({ total_price: newTotal }).eq('id', id)

    writeAuditLog(req, 'update_order_item', 'order', id, {
      display_id: order.display_id,
      product_name: item.product_name,
      old_quantity: item.quantity,
      new_quantity: quantity,
    })

    return success(res, { total_price: newTotal }, '已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /orders/merchant/:id/items/:itemId
const deleteOrderItem = async (req, res, next) => {
  try {
    const { id, itemId } = req.params

    const { data: order } = await supabase.from('order').select('id, display_id, is_paid').eq('id', id).eq('store_id', req.storeId).single()
    if (!order) return error(res, '訂單不存在', 404)
    if (order.is_paid) return error(res, '訂單已確認，無法修改', 400)

    const { count } = await supabase.from('order_item').select('id', { count: 'exact', head: true }).eq('order_id', id)
    if (count <= 1) return error(res, '至少保留一項商品', 400)

    const { data: itemInfo } = await supabase.from('order_item').select('product_name, quantity').eq('id', itemId).eq('order_id', id).single()

    await supabase.from('order_item_addon').delete().eq('order_item_id', itemId)
    await supabase.from('order_item').delete().eq('id', itemId).eq('order_id', id)

    const { data: allItems } = await supabase.from('order_item').select('subtotal').eq('order_id', id)
    const newTotal = allItems.reduce((s, i) => s + i.subtotal, 0)
    await supabase.from('order').update({ total_price: newTotal }).eq('id', id)

    writeAuditLog(req, 'delete_order_item', 'order', id, {
      display_id: order.display_id,
      product_name: itemInfo?.product_name,
      quantity: itemInfo?.quantity,
    })

    return success(res, { total_price: newTotal }, '已刪除')
  } catch (err) {
    next(err)
  }
}

// PATCH /orders/:id/pay
const payOrder = async (req, res, next) => {
  try {
    const { id } = req.params
    const { receipt } = req.body

    const { data, error: dbError } = await supabase
      .from('order')
      .update({ is_paid: true, paid_at: new Date().toISOString(), receipt: receipt || null })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    writeAuditLog(req, 'confirm_payment', 'order', id, { display_id: data.display_id })
    return success(res, data, '付款成功')
  } catch (err) {
    next(err)
  }
}

// PATCH /orders/:id/payment-method — 顧客改自己還沒付款訂單的付款方式
const updatePaymentMethod = async (req, res, next) => {
  try {
    const { id } = req.params
    const { payment_method_id } = req.body
    const storeId = req.storeId

    const { data: order } = await supabase
      .from('order')
      .select('id, display_id, total_price, is_paid, is_cancelled')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .eq('store_id', storeId)
      .single()
    if (!order) return error(res, '訂單不存在', 404)
    if (order.is_paid) return error(res, '訂單已付款，無法更改付款方式', 400)
    if (order.is_cancelled) return error(res, '訂單已取消', 400)

    const { data: pm } = await supabase
      .from('payment_method')
      .select('provider')
      .eq('id', payment_method_id)
      .eq('store_id', storeId)
      .maybeSingle()
    if (!pm) return error(res, '付款方式不存在', 400)

    const isNewebPay = pm.provider === 'newebpay'

    const { data: storeStatus } = await supabase
      .from('store')
      .select('id, name, frontend_url, newebpay_enabled, newebpay_mode, newebpay_custom_allowed, newebpay_merchant_id, newebpay_hash_key, newebpay_hash_iv')
      .eq('id', storeId)
      .single()
    if (isNewebPay && !storeStatus?.newebpay_enabled) return error(res, '此商家尚未開通線上刷卡', 400)

    const { error: dbError } = await supabase
      .from('order')
      .update({ payment_method_id, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('store_id', storeId)
    if (dbError) throw dbError

    if (isNewebPay) {
      // 重新前往付款每次都要換一組 MerchantOrderNo（見 buildNewebPayFormData 註解），
      // 用 display_id 當前綴，notify/returnRedirect 收到後取前 12 碼比對回同一張訂單
      const { paymentUrl, formData } = buildNewebPayFormData({
        store: storeStatus,
        displayId: order.display_id,
        merchantOrderNo: `${order.display_id}R${Date.now().toString().slice(-8)}`,
        amount: order.total_price,
        itemDesc: storeStatus?.name,
      })
      return success(res, { order_id: order.id, paymentUrl, formData }, '請完成付款')
    }

    return success(res, { order_id: order.id, payment_method_id }, '付款方式已更新')
  } catch (err) {
    next(err)
  }
}

// GET /orders/merchant/:id
const merchantGetOrder = async (req, res, next) => {
  try {
    const { id } = req.params
    const { data, error: dbError } = await supabase
      .from('order')
      .select(`
        id, display_id, is_paid, is_ship, is_confirmed, confirmed_at, is_cancelled, cancelled_at, receipt, paid_at, shipping_fee, total_price, pickup_date, pickup_time, created_at, requires_payment_confirmation, campaign_id, payment_deadline_at,
        newebpay_trade_no, newebpay_payment_type, is_refunded, refunded_at, refund_amount,
        discount_method ( discount_kol, discount_percent, discount_price ),
        payment_method ( payment_method, provider ),
        order_item (
          id, product_id, product_name, product_price, quantity, subtotal, note, is_gift,
          order_item_addon ( addon_id, addon_name, addon_price )
        )
      `)
      .eq('id', id)
      .eq('store_id', req.storeId)
      .single()

    if (dbError || !data) return error(res, '訂單不存在', 404)
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

// GET /orders (merchant)
const merchantGetOrders = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, is_paid, is_ship, show_test } = req.query
    const from = (page - 1) * limit
    const to = from + Number(limit) - 1

    let query = supabase
      .from('order')
      .select('id, display_id, user_id, is_paid, is_ship, is_confirmed, is_cancelled, is_refunded, is_test, requires_payment_confirmation, campaign_id, payment_deadline_at, total_price, pickup_date, pickup_time, created_at, user(phone, name)', { count: 'exact' })
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (is_paid !== undefined) query = query.eq('is_paid', is_paid === 'true')
    if (is_ship !== undefined) query = query.eq('is_ship', is_ship === 'true')
    if (show_test !== 'true') query = query.eq('is_test', false)

    const { data, count, error: dbError } = await query
    if (dbError) throw dbError
    return paginate(res, data, count, page, limit)
  } catch (err) {
    next(err)
  }
}

// PATCH /orders/:id/ship (merchant)
const shipOrder = async (req, res, next) => {
  try {
    const { id } = req.params
    const { data, error: dbError } = await supabase
      .from('order')
      .update({ is_ship: true, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    writeAuditLog(req, 'ship_order', 'order', id, { display_id: data.display_id })
    return success(res, data, '已標記出貨')
  } catch (err) {
    next(err)
  }
}

// PATCH /orders/merchant/:id/confirm
const merchantConfirmPay = async (req, res, next) => {
  try {
    const { id } = req.params
    const { data, error: dbError } = await supabase
      .from('order')
      .update({ is_paid: true, paid_at: new Date().toISOString() })
      .eq('id', id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    writeAuditLog(req, 'confirm_payment', 'order', id, { display_id: data.display_id, source: 'merchant' })
    return success(res, data, '已確認付款')
  } catch (err) {
    next(err)
  }
}

// POST /orders/merchant/:id/reprint
const reprintOrder = async (req, res, next) => {
  try {
    const { id } = req.params
    const storeId = req.storeId

    const { data: order, error: dbError } = await supabase
      .from('order')
      .select(`
        id, display_id, total_price, pickup_date, pickup_time, note, is_paid,
        user ( phone, name ),
        store ( name ),
        discount_method ( discount_price, discount_percent, discount_kol ),
        order_item (
          id, product_name, product_price, quantity, subtotal, note, is_gift,
          order_item_addon ( addon_name, addon_price )
        )
      `)
      .eq('id', id)
      .eq('store_id', storeId)
      .single()

    if (dbError || !order) return error(res, '訂單不存在', 404)

    const phoneLast3 = order.user?.phone?.slice(-3) || '???'
    const userName = order.user?.name || ''
    const subtotal = (order.order_item || []).reduce((s, i) => s + i.subtotal, 0)

    addJob(storeId, {
      storeName: order.store?.name || '',
      displayId: order.display_id,
      userName,
      phoneLast3,
      items: (order.order_item || []).map(item => ({
        name: item.product_name,
        category: item.is_gift ? '贈品' : '',
        product_price: item.product_price,
        quantity: item.quantity,
        note: item.note || null,
        addons: (item.order_item_addon || []).map(a => ({ name: a.addon_name, price: a.addon_price })),
        is_gift: item.is_gift,
      })),
      subtotal,
      discount: order.discount_method || null,
      totalPrice: order.total_price,
      isPaid: order.is_paid,
      pickupDate: order.pickup_date,
      pickupTime: order.pickup_time || null,
      note: order.note || null,
    })

    writeAuditLog(req, 'reprint_order', 'order', id, { display_id: order.display_id })
    return success(res, null, '補印指令已送出')
  } catch (err) {
    next(err)
  }
}

// 訂單取消時把扣掉的庫存加回去——createOrder 建立訂單當下會扣 product.stock
// （見上面 fresh.stock !== null 那段），但取消訂單的三條路徑（顧客自取消／
// 商家取消／逾期自動取消）過去都只標記 is_cancelled，沒有任何一條把庫存
// 加回來，導致取消的訂單持續佔用庫存數字，商家實際還能賣的比系統顯示的多。
// 贈品項目（is_gift=true）本來下單時就不會扣庫存，取消時也不用加回去。
const restoreOrderStock = async (orderId) => {
  const { data: items } = await supabase
    .from('order_item')
    .select('product_id, quantity, is_gift')
    .eq('order_id', orderId)
    .eq('is_gift', false)
  if (!items?.length) return

  const productIds = [...new Set(items.map(i => i.product_id))]
  const { data: products } = await supabase.from('product').select('id, stock').in('id', productIds)
  const stockMap = Object.fromEntries((products || []).map(p => [p.id, p.stock]))

  const qtyByProduct = {}
  for (const item of items) {
    qtyByProduct[item.product_id] = (qtyByProduct[item.product_id] || 0) + item.quantity
  }

  for (const [productId, qty] of Object.entries(qtyByProduct)) {
    const currentStock = stockMap[productId]
    if (currentStock === null || currentStock === undefined) continue // null = 不限量，不用加回去
    await supabase.from('product').update({ stock: currentStock + qty }).eq('id', productId)
  }
}

// DELETE /orders/:id  (customer cancel own order)
const cancelOrder = async (req, res, next) => {
  try {
    const { id } = req.params
    const { data: order } = await supabase
      .from('order')
      .select('id, display_id, is_paid, is_cancelled, is_ship')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .eq('store_id', req.storeId)
      .single()
    if (!order) return error(res, '訂單不存在', 404)
    if (order.is_cancelled) return error(res, '訂單已取消', 400)
    if (order.is_paid) return error(res, '訂單已確認付款，請聯繫商家', 400)
    if (order.is_ship) return error(res, '訂單已出貨，無法取消', 400)

    await supabase.from('order').update({ is_cancelled: true, cancelled_at: new Date().toISOString() }).eq('id', id)
    await restoreOrderStock(id)
    return success(res, null, '訂單已取消')
  } catch (err) {
    next(err)
  }
}

// PATCH /orders/merchant/:id/pickup — 顧客選錯或要改取餐時間，商家後台修改
const merchantUpdatePickup = async (req, res, next) => {
  try {
    const { id } = req.params
    const { pickup_slot_id, pickup_time } = req.body

    const { data: order } = await supabase
      .from('order')
      .select('id, display_id, campaign_id, is_cancelled')
      .eq('id', id)
      .eq('store_id', req.storeId)
      .single()
    if (!order) return error(res, '訂單不存在', 404)
    if (order.is_cancelled) return error(res, '訂單已取消，無法修改取餐時間', 400)

    const { data: slot } = await supabase
      .from('pickup_slot')
      .select('date, start_time, end_time, is_enable, campaign_id')
      .eq('id', pickup_slot_id)
      .eq('store_id', req.storeId)
      .single()
    if (!slot || !slot.is_enable) return error(res, '取餐時段不存在或已關閉', 400)
    // 檔期訂單只能改到同一檔期的時段，一般訂單只能改到一般時段，避免改成邏輯上兜不起來的組合
    if ((slot.campaign_id ?? null) !== (order.campaign_id ?? null)) {
      return error(res, '取貨時段與這張訂單的檔期不符', 400)
    }
    if (pickup_time < slot.start_time || pickup_time >= slot.end_time) {
      return error(res, `取貨時間須在 ${slot.start_time} ~ ${slot.end_time} 之間`, 400)
    }

    const { data, error: dbError } = await supabase
      .from('order')
      .update({ pickup_date: slot.date, pickup_time, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('store_id', req.storeId)
      .select()
      .single()

    if (dbError) throw dbError
    writeAuditLog(req, 'update_pickup_time', 'order', id, { display_id: order.display_id, new_date: slot.date, new_time: pickup_time })
    return success(res, data, '取餐時間已更新')
  } catch (err) {
    next(err)
  }
}

// DELETE /orders/merchant/:id  (merchant cancel any order)
const merchantCancelOrder = async (req, res, next) => {
  try {
    const { id } = req.params
    const { data: order } = await supabase
      .from('order')
      .select('id, display_id, is_cancelled')
      .eq('id', id)
      .eq('store_id', req.storeId)
      .single()
    if (!order) return error(res, '訂單不存在', 404)
    if (order.is_cancelled) return error(res, '訂單已取消', 400)

    await supabase.from('order').update({ is_cancelled: true, cancelled_at: new Date().toISOString() }).eq('id', id)
    await restoreOrderStock(id)
    writeAuditLog(req, 'cancel_order', 'order', id, { display_id: order.display_id })
    return success(res, null, '訂單已取消')
  } catch (err) {
    next(err)
  }
}

// PATCH /orders/merchant/:id/confirm — 商家接單（is_confirmed）
const merchantConfirmOrder = async (req, res, next) => {
  try {
    const { id } = req.params
    const storeId = req.storeId

    const { data: order } = await supabase
      .from('order')
      .select('id, display_id, total_price, is_confirmed, is_cancelled, user:user_id(line_id)')
      .eq('id', id)
      .eq('store_id', storeId)
      .single()

    if (!order) return error(res, '找不到訂單', 404)
    if (order.is_cancelled) return error(res, '訂單已取消', 400)
    if (order.is_confirmed) return error(res, '訂單已確認接單', 400)

    await supabase.from('order')
      .update({ is_confirmed: true, confirmed_at: new Date().toISOString() })
      .eq('id', id)

    writeAuditLog(req, 'confirm_order', 'order', id, { display_id: order.display_id })

    const customerLineId = order.user?.line_id
    if (customerLineId) {
      const { data: storeInfo } = await supabase.from('store').select('name').eq('id', storeId).single()
      pushCustomerNotification(storeId, customerLineId,
        `✅ ${storeInfo?.name || '商家'} 已確認您的訂單！\n訂單編號：${order.display_id}\n金額：NT$${order.total_price}`)
    }

    return success(res, null, '已確認接單')
  } catch (err) { next(err) }
}

module.exports = { createOrder, getOrders, getOrder, updateOrderItem, deleteOrderItem, payOrder, updatePaymentMethod, merchantGetOrder, merchantGetOrders, shipOrder, merchantConfirmPay, merchantConfirmOrder, merchantUpdatePickup, reprintOrder, cancelOrder, merchantCancelOrder, restoreOrderStock }

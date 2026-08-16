const supabase = require('../config/supabase')
const { pushOrderNotification } = require('./lineService')
const { addJob } = require('../cloudprnt/queue')

// 藍新線上付款訂單，建立當下還沒付款，LINE 通知/出單機列印要延到付款成功
// （webhook 收到 SUCCESS）才觸發，避免顧客棄單也誤觸發廚房出單。這裡重新從
// DB 撈一次完整訂單內容組通知payload，跟 orderController.createOrder 當下
// 用記憶體裡的值組 payload 是分開的兩條路徑，不動既有（非線上付款）訂單的
// 既有邏輯，降低風險。
const triggerDeferredOrderNotifications = async (orderId) => {
  const { data: order } = await supabase
    .from('order')
    .select(`
      id, store_id, display_id, total_price, discount_id, pickup_date, pickup_time, note, is_test,
      user:user_id ( name, phone ),
      order_item ( product_name, product_price, quantity, note,
        order_item_addon ( addon_name, addon_price ) )
    `)
    .eq('id', orderId)
    .single()

  if (!order || order.is_test) return

  const { data: store } = await supabase.from('store').select('name').eq('id', order.store_id).single()

  let discount = null
  if (order.discount_id) {
    const { data: d } = await supabase.from('discount_method').select('*').eq('id', order.discount_id).single()
    discount = d
  }

  const orderItems = (order.order_item || []).map((item) => ({
    name: item.product_name,
    category: '', // 下單當下的分類名稱沒有保留在 order_item，通知訊息略過分組
    product_price: item.product_price,
    quantity: item.quantity,
    note: item.note || null,
    addons: (item.order_item_addon || []).map((a) => ({ name: a.addon_name, price: a.addon_price })),
  }))
  const subtotal = (order.order_item || []).reduce((sum, item) => sum + (item.product_price * item.quantity), 0)
  const phoneLast3 = order.user?.phone?.slice(-3) || '???'
  const userName = order.user?.name || ''

  // 這條路徑只會在藍新 webhook 確認 Status=SUCCESS 後才觸發，代表這筆訂單
  // 一定已經付款完成，通知/收據都要標註已付款，避免員工誤以為還要收現金
  pushOrderNotification({
    storeId: order.store_id,
    orderId: order.id,
    displayId: order.display_id,
    userName,
    phoneLast3,
    items: orderItems,
    subtotal,
    discount,
    totalPrice: order.total_price,
    pickupDate: order.pickup_date,
    pickupTime: order.pickup_time,
    note: order.note,
    isPaid: true,
  })

  addJob(order.store_id, {
    storeName: store?.name || '',
    displayId: order.display_id,
    userName,
    phoneLast3,
    items: orderItems,
    subtotal,
    discount,
    totalPrice: order.total_price,
    pickupDate: order.pickup_date,
    pickupTime: order.pickup_time,
    note: order.note,
    isPaid: true,
  })
}

module.exports = { triggerDeferredOrderNotifications }

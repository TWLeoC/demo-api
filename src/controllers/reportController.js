const ExcelJS = require('exceljs')
const supabase = require('../config/supabase')
const { error } = require('../utils/response')

const MAX_RANGE_DAYS = 366

const formatDateTime = (isoStr) => {
  if (!isoStr) return ''
  return new Date(isoStr).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  })
}

// 藍新回傳的 PaymentType 代碼（見 paymentController.js::notify 的 newebpay_payment_type
// 存值），只有 provider='newebpay' 的訂單才有值，現場付款/其他方式這欄位是空的
const NEWEBPAY_TYPE_LABELS = {
  CREDIT: '信用卡',
  WEBATM: '網路 ATM',
  VACC: 'ATM 轉帳',
  CVS: '超商代碼',
  BARCODE: '超商條碼',
  LINEPAY: 'LINE Pay',
  TAIWANPAY: '台灣 Pay',
  ANDROIDPAY: 'Android Pay',
  SAMSUNGPAY: 'Samsung Pay',
}

// 品項明細塞進同一個儲存格（多行），贈品比照出單機的慣例標記【贈】，
// 不用 emoji（出單機是 Big5 編碼印不出來，這裡雖然是 Excel 不受這限制，
// 但沿用同一套標記顧客/商家看習慣了，不用兩套符號增加混淆）
const buildItemsCell = (orderItems) => {
  const lines = []
  for (const item of orderItems || []) {
    const prefix = item.is_gift ? '【贈】' : ''
    lines.push(`${prefix}${item.product_name} x${item.quantity} $${item.product_price * item.quantity}`)
    for (const addon of item.order_item_addon || []) {
      lines.push(`　　└ ${addon.addon_name}${addon.addon_price > 0 ? ` +$${addon.addon_price}` : ''}`)
    }
  }
  return lines.join('\n')
}

// GET /api/merchant/orders/export?start=YYYY-MM-DD&end=YYYY-MM-DD
// 逐筆訂單明細匯出 Excel，已取消/未付款的訂單也列入（用狀態欄位區別，不要
// 靜默排除），讓商家對帳時能看到哪些訂單其實沒成交，不是只看片面的成交資料
const exportOrdersReport = async (req, res, next) => {
  try {
    const { start, end } = req.query
    if (!start || !end) return error(res, '請提供 start、end 日期', 400)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return error(res, '日期格式錯誤，請使用 YYYY-MM-DD', 400)
    }

    const startAt = new Date(`${start}T00:00:00+08:00`)
    const endAt = new Date(`${end}T23:59:59+08:00`)
    if (isNaN(startAt) || isNaN(endAt)) return error(res, '日期格式錯誤', 400)
    if (startAt > endAt) return error(res, '起始日期不能晚於結束日期', 400)

    const rangeDays = (endAt - startAt) / (1000 * 60 * 60 * 24)
    if (rangeDays > MAX_RANGE_DAYS) return error(res, `查詢區間最多 ${MAX_RANGE_DAYS} 天`, 400)

    const { data: store } = await supabase.from('store').select('name').eq('id', req.storeId).single()

    const { data: orders, error: dbError } = await supabase
      .from('order')
      .select(`
        id, display_id, created_at, is_paid, is_ship, is_cancelled, total_price, pickup_date, pickup_time,
        newebpay_payment_type,
        user ( name, phone ),
        payment_method ( payment_method, provider ),
        order_item ( product_name, product_price, quantity, is_gift, order_item_addon ( addon_name, addon_price ) )
      `)
      .eq('store_id', req.storeId)
      .eq('is_test', false)
      .gte('created_at', startAt.toISOString())
      .lte('created_at', endAt.toISOString())
      .order('created_at', { ascending: true })
    if (dbError) throw dbError

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('訂單明細')

    sheet.columns = [
      { header: '訂單編號', key: 'display_id', width: 16 },
      { header: '下單時間', key: 'created_at', width: 16 },
      { header: '顧客姓名', key: 'name', width: 12 },
      { header: '顧客電話', key: 'phone', width: 14 },
      { header: '取餐日期', key: 'pickup_date', width: 12 },
      { header: '取餐時間', key: 'pickup_time', width: 10 },
      { header: '品項明細', key: 'items', width: 40 },
      { header: '付款方式', key: 'payment_method', width: 14 },
      { header: '付款明細', key: 'payment_detail', width: 12 },
      { header: '付款狀態', key: 'paid_status', width: 10 },
      { header: '出貨狀態', key: 'ship_status', width: 10 },
      { header: '訂單狀態', key: 'order_status', width: 12 },
      { header: '訂單金額', key: 'total_price', width: 12 },
    ]
    sheet.getRow(1).font = { bold: true }
    sheet.views = [{ state: 'frozen', ySplit: 1 }]

    let grandTotal = 0
    for (const o of orders || []) {
      grandTotal += o.total_price
      const row = sheet.addRow({
        display_id: o.display_id,
        created_at: formatDateTime(o.created_at),
        name: o.user?.name || '',
        phone: o.user?.phone || '',
        pickup_date: o.pickup_date || '',
        pickup_time: (o.pickup_time || '').slice(0, 5),
        items: buildItemsCell(o.order_item),
        payment_method: o.payment_method?.payment_method || '—',
        payment_detail: NEWEBPAY_TYPE_LABELS[o.newebpay_payment_type] || o.newebpay_payment_type || '',
        paid_status: o.is_paid ? '已付款' : '未付款',
        ship_status: o.is_ship ? '已出貨' : '備餐中',
        order_status: o.is_cancelled ? '已取消' : '正常',
        total_price: o.total_price,
      })
      row.getCell('items').alignment = { wrapText: true, vertical: 'top' }
    }

    const summaryRow = sheet.addRow({ display_id: `共 ${(orders || []).length} 筆`, total_price: grandTotal })
    summaryRow.font = { bold: true }

    // 檔名要帶商店名稱（中文），純 filename="..." 在非 ASCII 字元上各瀏覽器行為
    // 不一致，照 RFC 5987 同時給一個 ASCII fallback + UTF-8 編碼版本，前端解析
    // 時優先讀 filename*
    const storeName = store?.name || '訂單報表'
    const asciiFallback = `orders_${start}_${end}.xlsx`
    const utf8Filename = encodeURIComponent(`訂單報表_${storeName}_${start}_${end}.xlsx`)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Filename}`)
    await workbook.xlsx.write(res)
    res.end()
  } catch (err) {
    next(err)
  }
}

module.exports = { exportOrdersReport }

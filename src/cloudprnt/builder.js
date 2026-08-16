const iconv = require('iconv-lite')

const RESET      = Buffer.from([0x1b, 0x40])
const ALIGN_CENTER = Buffer.from([0x1b, 0x1d, 0x61, 0x01])
const ALIGN_LEFT = Buffer.from([0x1b, 0x1d, 0x61, 0x00])
const BOLD_ON    = Buffer.from([0x1b, 0x45, 0x01])
const BOLD_OFF   = Buffer.from([0x1b, 0x46])
const FONT_2X    = Buffer.from([0x1b, 0x69, 0x01, 0x01])
const FONT_NORMAL = Buffer.from([0x1b, 0x69, 0x00, 0x00])

const b = str => iconv.encode(str, 'big5')

// CJK characters count as 2 columns, ASCII as 1
function displayWidth(str) {
  let w = 0
  for (const ch of str) {
    w += ch.codePointAt(0) > 0x7e ? 2 : 1
  }
  return w
}

// Right-align `right` relative to `left` within `cols` columns
function padBetween(left, right, cols) {
  const spaces = Math.max(1, cols - displayWidth(left) - displayWidth(right))
  return left + ' '.repeat(spaces) + right + '\n'
}

// 顧客填的文字（備註、姓名等）會直接送進出單機的位元組流，沒過濾的話理論上能塞控制
// 字元（0x00-0x1F，Big5 不會動到這段）操控印表機的對齊/粗體等指令，進 Buffer 前一律先濾掉
const clean = v => (v == null ? v : String(v).replace(/[\x00-\x1f]/g, ''))

function buildPrintData({ storeName, displayId, userName, phoneLast3, items, subtotal, discount, totalPrice, pickupDate, pickupTime, note, isPaid }, cols = 42) {
  storeName = clean(storeName)
  userName = clean(userName)
  note = clean(note)
  items = (items || []).map(item => ({
    ...item,
    name: clean(item.name),
    category: clean(item.category),
    note: clean(item.note),
    addons: (item.addons || []).map(a => ({ ...a, name: clean(a.name) })),
  }))
  if (discount && typeof discount === 'object') {
    discount = { ...discount, discount_kol: clean(discount.discount_kol) }
  }

  const SEP = b('='.repeat(cols) + '\n')
  const parts = []

  parts.push(RESET)
  parts.push(ALIGN_CENTER, FONT_2X, BOLD_ON)
  parts.push(b(`${storeName || '示範商店'}\n`))
  parts.push(FONT_NORMAL, BOLD_OFF, ALIGN_LEFT)

  if (isPaid) {
    parts.push(ALIGN_CENTER, BOLD_ON)
    parts.push(b('✅ 已線上付款\n'))
    parts.push(BOLD_OFF, ALIGN_LEFT)
  }

  parts.push(SEP)
  parts.push(b(`訂單：#${displayId}\n`))
  if (userName) parts.push(b(`顧客：${userName}\n`))
  parts.push(b(`手機末三碼：${phoneLast3}\n`))
  if (pickupDate || pickupTime) {
    parts.push(b(`取餐：${pickupDate || ''} ${(pickupTime || '').slice(0, 5)}\n`))
  }
  if (note) parts.push(BOLD_ON, b(`備註：${note}\n`), BOLD_OFF)
  parts.push(SEP)

  parts.push(b('品項：\n'))

  const groups = []
  const groupMap = {}
  for (const item of items) {
    const cat = item.category || ''
    if (!groupMap[cat]) { groupMap[cat] = []; groups.push(cat) }
    groupMap[cat].push(item)
  }

  for (const cat of groups) {
    if (cat) parts.push(b(`${cat}：\n`))
    for (const item of groupMap[cat]) {
      // 出單機用 Big5 編碼，emoji 印不出來，用文字標記代替
      const left = `  ${item.is_gift ? '【贈】' : ''}${item.name} x${item.quantity}`
      if (item.product_price != null) {
        const right = `NT$${(item.product_price * item.quantity).toLocaleString()}`
        parts.push(b(padBetween(left, right, cols)))
      } else {
        parts.push(b(left + '\n'))
      }
      if (item.addons?.length) {
        for (const a of item.addons) {
          const priceStr = a.price > 0 ? ` +NT$${a.price}` : ''
          parts.push(BOLD_ON, b(`    ${a.name}${priceStr}\n`), BOLD_OFF)
        }
      }
      if (item.note) {
        parts.push(BOLD_ON, b(`    ※ ${item.note}\n`), BOLD_OFF)
      }
    }
  }

  parts.push(SEP)

  if (discount && typeof discount === 'object') {
    parts.push(b(`小計：NT$ ${subtotal.toLocaleString()}\n`))
    if (discount.discount_percent && discount.discount_percent !== 1) {
      const pct = Math.round(discount.discount_percent * 100)
      parts.push(b(`優惠碼：${discount.discount_kol} (${pct}折)\n`))
    }
    if (discount.discount_price > 0) {
      parts.push(b(`折抵：-NT$ ${discount.discount_price.toLocaleString()}\n`))
    }
  }

  parts.push(BOLD_ON, b(`合計：NT$ ${totalPrice.toLocaleString()}\n`), BOLD_OFF)
  parts.push(b('\n\n\n'))

  return Buffer.concat(parts)
}

module.exports = { buildPrintData }

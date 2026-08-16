const { messagingApi } = require('@line/bot-sdk')
const supabase = require('../config/supabase')

const buildOrderMessage = ({ displayId, userName, phoneLast3, items, subtotal, discount, totalPrice, pickupDate, pickupTime, note, isPaid }) => {
  const sep = '─────────────────'

  // 依分類分組
  const groups = []
  const groupMap = {}
  for (const item of items) {
    const catName = item.category || '其他'
    if (!groupMap[catName]) {
      groupMap[catName] = []
      groups.push(catName)
    }
    groupMap[catName].push(item)
  }

  const itemLines = groups.map(catName => {
    const lines = groupMap[catName].map(item => {
      const unitPrice = item.product_price + item.addons.reduce((s, a) => s + a.price, 0)
      let line = `  ${item.name} ×${item.quantity}　NT$${(unitPrice * item.quantity).toLocaleString()}`
      if (item.addons.length) {
        line += '\n' + item.addons.map(a => `　　└ ${a.name} +NT$${a.price}`).join('\n')
      }
      if (item.note) {
        line += `\n　　※ ${item.note}`
      }
      return line
    }).join('\n')
    return `${catName}：\n${lines}`
  }).join('\n')

  const discountAmount = subtotal - totalPrice
  const discountLine = discount && discountAmount > 0
    ? `優惠券（${discount.discount_kol}）　-NT$${discountAmount.toLocaleString()}\n`
    : ''

  const pickupStr = pickupDate && pickupTime
    ? `${pickupDate} ${pickupTime}`
    : pickupTime || '未指定'

  const nameLine = userName ? `顧客名稱：${userName}` : null

  return [
    isPaid ? '🎉您有新訂單（已付款）！' : '🎉您有新訂單！',
    sep,
    `訂單編號：${displayId}`,
    nameLine,
    `手機末三碼：${phoneLast3}`,
    `取餐時間：${pickupStr}`,
    '',
    '📋 訂單明細',
    itemLines,
    sep,
    `小計　　NT$${subtotal.toLocaleString()}`,
    discountLine.trimEnd(),
    `合計　　NT$${totalPrice.toLocaleString()}`,
    note ? `\n備註：${note}` : null,
  ].filter(l => l !== null && l !== undefined && l !== '').join('\n')
}

const pushCustomerNotification = async (storeId, customerLineId, text) => {
  if (!customerLineId) return
  const { data: store } = await supabase
    .from('store')
    .select('line_channel_access_token, customer_notify_enabled')
    .eq('id', storeId)
    .single()
  if (!store?.customer_notify_enabled) return
  const token = store?.line_channel_access_token || process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return
  const client = new messagingApi.MessagingApiClient({ channelAccessToken: token })
  try {
    await client.pushMessage({ to: customerLineId, messages: [{ type: 'text', text }] })
  } catch (err) {
    console.error('[LINE] customer push failed:', err?.response?.data?.message || err.message)
  }
}

const pushOrderNotification = async (data) => {
  const { storeId, orderId, ...msgData } = data

  const { data: store } = await supabase
    .from('store')
    .select('line_bot_enabled, line_notify_target, line_channel_access_token')
    .eq('id', storeId)
    .single()

  if (!store?.line_bot_enabled || !store?.line_notify_target) return

  // 優先使用商家自訂 token，fallback 到平台 env
  const channelAccessToken = store.line_channel_access_token || process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!channelAccessToken) return

  const client = new messagingApi.MessagingApiClient({ channelAccessToken })

  const messages = [
    { type: 'text', text: buildOrderMessage(msgData) },
  ]

  if (orderId) {
    messages.push({
      type: 'flex',
      altText: `訂單 ${msgData.displayId} — 點此確認付款／出貨`,
      contents: {
        type: 'bubble',
        size: 'mega',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#f5f0e8',
          paddingAll: 'md',
          contents: [
            { type: 'text', text: `訂單 ${msgData.displayId}`, weight: 'bold', size: 'sm', color: '#5c3d1a' },
            { type: 'text', text: `NT$ ${msgData.totalPrice.toLocaleString()}`, weight: 'bold', size: 'xl', color: '#8B4513' },
            ...(msgData.isPaid ? [{ type: 'text', text: '✅ 已付款', weight: 'bold', size: 'xs', color: '#16a34a' }] : []),
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#16a34a',
              height: 'sm',
              action: {
                type: 'postback',
                label: '📋 確認接單',
                data: `action=confirm_order&order_id=${orderId}&display_id=${msgData.displayId}`,
              },
            },
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'sm',
              contents: [
                ...(msgData.isPaid ? [] : [{
                  type: 'button',
                  style: 'primary',
                  color: '#1DB446',
                  height: 'sm',
                  action: {
                    type: 'postback',
                    label: '✅ 確認付款',
                    data: `action=confirm_payment&order_id=${orderId}&display_id=${msgData.displayId}`,
                  },
                }]),
                {
                  type: 'button',
                  style: 'primary',
                  color: '#3b82f6',
                  height: 'sm',
                  action: {
                    type: 'postback',
                    label: '📦 確認出貨',
                    data: `action=confirm_ship&order_id=${orderId}&display_id=${msgData.displayId}`,
                  },
                },
              ],
            },
          ],
        },
      },
    })
  }

  try {
    await client.pushMessage({ to: store.line_notify_target, messages })
  } catch (err) {
    console.error('[LINE] push failed:', err?.response?.data || err.message)
  }
}

module.exports = { pushOrderNotification, pushCustomerNotification }

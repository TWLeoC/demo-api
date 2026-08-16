// 台灣 09xxxxxxxx → +8869xxxxxxxx（E.164，Twilio 專用）
const toE164 = (phone) => {
  if (phone.startsWith('+')) return phone
  if (phone.startsWith('0')) return '+886' + phone.slice(1)
  return '+' + phone
}

const sendSms = async (phone, message) => {
  const provider = process.env.SMS_PROVIDER

  if (provider === 'twilio') {
    const twilio = require('twilio')
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toE164(phone),
    })
    return
  }

  if (provider === 'mitake') {
    const axios = require('axios')
    // MITAKE 三竹簡訊 HTTP API
    await axios.get('https://sms.mitake.com.tw/b2c/mtk/SmSend', {
      params: {
        username: process.env.MITAKE_USERNAME,
        password: process.env.MITAKE_PASSWORD,
        dstaddr: phone,
        smbody: message,
      },
    })
    return
  }

  // 開發模式：印到 console
  console.log(`[SMS] To: ${phone} | Message: ${message}`)
}

module.exports = { sendSms }

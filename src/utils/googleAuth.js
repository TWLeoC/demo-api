const { OAuth2Client } = require('google-auth-library')

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

// 驗證前端 Google Sign-In 給的 ID token：簽章、audience、效期都由 google-auth-library
// 處理（不要自己手動驗簽或用 Google 文件標註「僅供除錯用」的 tokeninfo 端點）
const verifyGoogleIdToken = async (idToken) => {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  })
  const payload = ticket.getPayload()
  if (!payload.email_verified) throw new Error('Google 帳號 email 尚未驗證')
  return { email: payload.email }
}

module.exports = { verifyGoogleIdToken }

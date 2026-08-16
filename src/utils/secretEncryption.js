const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM 建議用 12 bytes（96 bit）IV，不是 CBC 常見的 16 bytes

const getKey = () => {
  const keyB64 = process.env.SECRET_ENCRYPTION_KEY
  if (!keyB64) throw new Error('SECRET_ENCRYPTION_KEY 未設定，無法加解密機密欄位')
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) throw new Error('SECRET_ENCRYPTION_KEY 必須是 32 bytes（base64 編碼後貼進環境變數）')
  return key
}

// 加密後格式：iv:authTag:ciphertext（都是 hex），每次呼叫都用新的隨機 IV——
// GCM 的安全性建立在同一把 key 絕對不能重複用同一組 IV 上，不能為了「方便比對」
// 固定用同一個 IV
const encrypt = (plaintext) => {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null
  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

const decrypt = (ciphertext) => {
  if (!ciphertext) return ciphertext
  const key = getKey()
  const [ivHex, authTagHex, dataHex] = ciphertext.split(':')
  if (!ivHex || !authTagHex || !dataHex) throw new Error('密文格式錯誤，無法解密')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return decrypted.toString('utf8')
}

module.exports = { encrypt, decrypt }

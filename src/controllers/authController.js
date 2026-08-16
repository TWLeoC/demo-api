const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const supabase = require('../config/supabase')
const { writeAuditLog } = require('../utils/auditLog')
const { success, error } = require('../utils/response')
const { sendSms } = require('../services/smsService')

const sendDebugEmail = async (phone, code) => {
  if (!process.env.SMTP_USER || !process.env.NOTIFY_EMAIL) return

  const nodemailer = require('nodemailer')
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.NOTIFY_EMAIL,
      subject: `OTP ${phone} ${code}`,
      text: `OTP ${phone} ${code}`,
    })
  } catch (err) {
    console.error('[EMAIL OTP]', err.message)
  }
}

const signToken = user =>
  jwt.sign(
    { id: user.id, role: user.role, phone: user.phone, store_id: user.store_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  )

const safeUser = u => ({
  id: u.id,
  phone: u.phone,
  name: u.name,
  role: u.role,
  store_id: u.store_id,
})

// POST /auth/send-code
const sendCode = async (req, res, next) => {
  try {
    const { phone } = req.body
    const storeId = req.headers['x-store-id']
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const { error: dbError } = await supabase
      .from('phone_verification')
      .insert({ phone, code, expires_at: expiresAt })

    if (dbError) throw dbError

    let storeName = '線上點餐系統'
    if (storeId) {
      const { data: store } = await supabase.from('store').select('name').eq('id', storeId).single()
      if (store?.name) storeName = store.name
    }

    await sendSms(phone, `【${storeName}】您的驗證碼為 ${code}，10 分鐘內有效。`)

    // 同時寄 Email 通知（開發測試用）
    sendDebugEmail(phone, code)

    return success(res, null, '驗證碼已發送')
  } catch (err) {
    next(err)
  }
}

// POST /auth/verify-code
const verifyCode = async (req, res, next) => {
  try {
    const { phone, code } = req.body
    const storeId = req.headers['x-store-id']
    if (!storeId) return error(res, 'X-Store-ID header required', 400)

    const { data: record, error: dbError } = await supabase
      .from('phone_verification')
      .select('*')
      .eq('phone', phone)
      .eq('code', code)
      .eq('is_used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (dbError || !record) return error(res, '驗證碼錯誤或已過期', 400)

    await supabase.from('phone_verification').update({ is_used: true }).eq('id', record.id)

    let { data: user } = await supabase
      .from('user')
      .select('*')
      .eq('phone', phone)
      .eq('store_id', storeId)
      .single()

    if (!user) {
      const { data: newUser, error: createError } = await supabase
        .from('user')
        .insert({ phone, store_id: storeId, phone_verified_at: new Date().toISOString() })
        .select()
        .single()
      if (createError) throw createError
      user = newUser
    } else if (!user.phone_verified_at) {
      await supabase
        .from('user')
        .update({ phone_verified_at: new Date().toISOString() })
        .eq('id', user.id)
    }

    const token = signToken(user)
    const needs_setup = !user.password_hash

    if (user.role === 'MERCHANT') {
      writeAuditLog(
        { storeId: req.headers['x-store-id'], user, ip: req.ip },
        'login_success', 'user', user.id, { method: 'phone_otp' }
      )
    }

    return success(res, { token, user: safeUser(user), needs_setup }, '登入成功')
  } catch (err) {
    next(err)
  }
}

// POST /auth/login  (phone + password)
const login = async (req, res, next) => {
  try {
    const { phone, password } = req.body
    const storeId = req.headers['x-store-id']
    if (!storeId) return error(res, 'X-Store-ID header required', 400)

    const { data: user } = await supabase
      .from('user')
      .select('*')
      .eq('phone', phone)
      .eq('store_id', storeId)
      .single()

    if (!user || !user.password_hash) {
      return error(res, '手機號碼或密碼錯誤', 401)
    }

    const match = await bcrypt.compare(password, user.password_hash)
    if (!match) return error(res, '手機號碼或密碼錯誤', 401)

    if (user.status === 'disabled') return error(res, '帳號已停用', 403)

    const token = signToken(user)
    return success(res, { token, user: safeUser(user) }, '登入成功')
  } catch (err) {
    next(err)
  }
}

// POST /auth/setup-password  (authenticated, 設定或重設密碼)
const setupPassword = async (req, res, next) => {
  try {
    const { password, name } = req.body

    const hash = await bcrypt.hash(password, 12)
    const updates = { password_hash: hash }
    if (name !== undefined) updates.name = name

    const { error: dbError } = await supabase
      .from('user')
      .update(updates)
      .eq('id', req.user.id)

    if (dbError) throw dbError
    return success(res, null, '密碼設定成功')
  } catch (err) {
    next(err)
  }
}

// GET /auth/me
const getMe = async (req, res, next) => {
  try {
    const { data: user, error: dbError } = await supabase
      .from('user')
      .select('id, role, status, email, name, phone, phone_verified_at, birth_date, created_at')
      .eq('id', req.user.id)
      .single()

    if (dbError || !user) return error(res, '使用者不存在', 404)
    return success(res, user)
  } catch (err) {
    next(err)
  }
}

// PATCH /auth/me
const updateMe = async (req, res, next) => {
  try {
    const { name, email, birth_date } = req.body
    const updates = {}
    if (name !== undefined) updates.name = name
    if (birth_date !== undefined) updates.birth_date = birth_date

    if (email !== undefined) {
      const { data: existing } = await supabase
        .from('user')
        .select('id')
        .eq('email', email)
        .eq('store_id', req.storeId)
        .neq('id', req.user.id)
        .single()

      if (existing) return error(res, '該信箱已註冊', 409)
      updates.email = email
    }

    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('user')
      .update(updates)
      .eq('id', req.user.id)
      .select('id, role, email, name, phone, birth_date')
      .single()

    if (dbError) throw dbError
    return success(res, data, '更新成功')
  } catch (err) {
    next(err)
  }
}

// POST /api/auth/line
const lineLogin = async (req, res, next) => {
  try {
    const { code, redirect_uri } = req.body
    const storeId = req.headers['x-store-id']
    if (!storeId) return error(res, 'X-Store-ID header required', 400)
    if (!code) return error(res, '缺少授權碼', 400)

    const lineCredentials = await getLineLoginCredentials(storeId)

    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect_uri || lineCredentials.redirectUri,
        client_id: lineCredentials.clientId,
        client_secret: lineCredentials.clientSecret,
      }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenData.access_token) {
      console.error('[LINE Login] token exchange failed:', tokenData)
      return error(res, 'LINE 授權失敗', 401)
    }

    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const profile = await profileRes.json()
    const { userId: lineId, displayName } = profile
    if (!lineId) return error(res, '無法取得 LINE 用戶資料', 401)

    let { data: user } = await supabase
      .from('user')
      .select('*')
      .eq('line_id', lineId)
      .eq('store_id', storeId)
      .single()

    if (!user) {
      const { data: newUser, error: createErr } = await supabase
        .from('user')
        .insert({ line_id: lineId, name: displayName, store_id: storeId })
        .select()
        .single()
      if (createErr) throw createErr
      user = newUser
    } else if (displayName && user.name !== displayName) {
      await supabase.from('user').update({ name: displayName }).eq('id', user.id)
      user = { ...user, name: displayName }
    }

    if (!user.status) return error(res, '帳號已停用', 403)

    const needs_phone = !user.phone
    const token = signToken(user)

    if (user.role === 'MERCHANT') {
      writeAuditLog(
        { storeId, user, ip: req.ip },
        'login_success', 'user', user.id, { method: 'line' }
      )
    }

    return success(res, { token, user: safeUser(user), needs_phone }, 'LINE 登入成功')
  } catch (err) {
    next(err)
  }
}

// POST /api/auth/link-phone  (LINE 用戶完成 OTP 後綁定電話)
const linkPhone = async (req, res, next) => {
  try {
    const { phone, code } = req.body
    const userId = req.user.id
    const storeId = req.user.store_id

    const { data: record } = await supabase
      .from('phone_verification')
      .select('*')
      .eq('phone', phone)
      .eq('code', code)
      .eq('is_used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!record) return error(res, '驗證碼錯誤或已過期', 400)
    await supabase.from('phone_verification').update({ is_used: true }).eq('id', record.id)

    // 若此電話已有帳號，將 LINE ID 連結到既有帳號，刪除臨時帳號
    const { data: phoneUser } = await supabase
      .from('user')
      .select('*')
      .eq('phone', phone)
      .eq('store_id', storeId)
      .single()

    let finalUser
    if (phoneUser && phoneUser.id !== userId) {
      // 先取得 temp user 的 line_id
      const { data: lineUser } = await supabase.from('user').select('line_id').eq('id', userId).single()
      const lineId = lineUser?.line_id

      // 處理 cart FK：phoneUser 若已有 cart 就刪 temp 的，否則轉移給 phoneUser
      const { data: tempCart } = await supabase.from('cart').select('id').eq('user_id', userId).single()
      if (tempCart) {
        const { data: phoneCart } = await supabase.from('cart').select('id').eq('user_id', phoneUser.id).single()
        if (phoneCart) {
          await supabase.from('cart_item').delete().eq('cart_id', tempCart.id)
          await supabase.from('cart').delete().eq('id', tempCart.id)
        } else {
          await supabase.from('cart').update({ user_id: phoneUser.id }).eq('id', tempCart.id)
        }
      }

      // 刪 temp user（line_id UNIQUE 衝突：先刪再更新 phoneUser）
      const { error: deleteErr } = await supabase.from('user').delete().eq('id', userId)
      if (deleteErr) throw deleteErr

      const { data: merged, error: mergeErr } = await supabase
        .from('user')
        .update({ line_id: lineId })
        .eq('id', phoneUser.id)
        .select()
        .single()
      if (mergeErr) throw mergeErr

      finalUser = merged
    } else {
      const { data: updated } = await supabase
        .from('user')
        .update({ phone, phone_verified_at: new Date().toISOString() })
        .eq('id', userId)
        .select()
        .single()
      finalUser = updated
    }

    const token = signToken(finalUser)
    return success(res, { token, user: safeUser(finalUser), needs_setup: !finalUser.password_hash }, '手機綁定成功')
  } catch (err) {
    next(err)
  }
}

// POST /api/auth/merchant/line  — merchant 專用 LINE 登入（不建新帳號）
const merchantLineLogin = async (req, res, next) => {
  try {
    const { code, redirect_uri } = req.body
    const storeId = req.headers['x-store-id']
    if (!code) return error(res, '缺少授權碼', 400)

    const lineCredentials = await getLineLoginCredentials(storeId)

    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect_uri || lineCredentials.redirectUri,
        client_id: lineCredentials.clientId,
        client_secret: lineCredentials.clientSecret,
      }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenData.access_token) return error(res, 'LINE 授權失敗', 401)

    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const { userId: lineId, displayName } = await profileRes.json()
    if (!lineId) return error(res, '無法取得 LINE 用戶資料', 401)

    let query = supabase.from('user').select('*').eq('line_id', lineId)
    if (storeId) query = query.eq('store_id', storeId)
    const { data: user } = await query.eq('role', 'MERCHANT').single()

    if (!user) {
      // LINE 帳號尚未綁定管理員：發短效 linkToken，讓前端引導手機 OTP 完成綁定
      const linkToken = jwt.sign(
        { line_id: lineId, display_name: displayName || null, store_id: storeId, purpose: 'merchant_line_link' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      )
      return success(res, { needsLink: true, linkToken }, '請完成手機驗證以綁定 LINE 帳號')
    }
    if (!user.status) return error(res, '帳號已停用', 403)

    const token = signToken(user)
    return success(res, { token, user: safeUser(user) }, 'LINE 登入成功')
  } catch (err) {
    next(err)
  }
}

// POST /api/auth/admin/link-line  — 手機 OTP 驗證後將 LINE ID 綁定至管理員帳號
const merchantLinkLine = async (req, res, next) => {
  try {
    const { linkToken, phone, code } = req.body
    const storeId = req.headers['x-store-id']
    if (!linkToken || !phone || !code) return error(res, '缺少必要參數', 400)

    let payload
    try {
      payload = jwt.verify(linkToken, process.env.JWT_SECRET)
    } catch {
      return error(res, '綁定連結已過期，請重新使用 LINE 登入', 400)
    }
    if (payload.purpose !== 'merchant_line_link') return error(res, '無效的綁定請求', 400)

    // 驗證 OTP
    const { data: record } = await supabase
      .from('phone_verification')
      .select('*')
      .eq('phone', phone)
      .eq('code', code)
      .eq('is_used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!record) return error(res, '驗證碼錯誤或已過期', 400)
    await supabase.from('phone_verification').update({ is_used: true }).eq('id', record.id)

    // 找對應管理員
    let userQuery = supabase.from('user').select('*').eq('phone', phone).eq('role', 'MERCHANT')
    if (storeId) userQuery = userQuery.eq('store_id', storeId)
    const { data: merchantUser } = await userQuery.single()

    if (!merchantUser) return error(res, '找不到對應的管理員帳號，請確認手機號碼', 404)
    if (!merchantUser.status) return error(res, '帳號已停用', 403)

    // 綁定 LINE ID，若管理員尚無名字則一併帶入 LINE 顯示名稱
    const linkUpdates = { line_id: payload.line_id }
    if (payload.display_name && !merchantUser.name) linkUpdates.name = payload.display_name

    const { error: updateErr } = await supabase
      .from('user')
      .update(linkUpdates)
      .eq('id', merchantUser.id)

    if (updateErr) {
      console.error('[merchantLinkLine] update line_id failed:', updateErr)
      if (updateErr.code === '23505') {
        return error(res, '此 LINE 帳號已綁定其他帳號，請聯繫系統管理員', 409)
      }
      throw updateErr
    }

    const token = signToken(merchantUser)
    return success(res, { token, user: safeUser(merchantUser) }, 'LINE 綁定成功，已自動登入')
  } catch (err) {
    next(err)
  }
}

async function getLineLoginCredentials(storeId) {
  if (storeId) {
    const { data: store } = await supabase
      .from('store')
      .select('line_login_channel_id, line_login_channel_secret, line_login_redirect_uri')
      .eq('id', storeId)
      .single()
    if (store) {
      return {
        clientId:     store.line_login_channel_id     || process.env.LINE_LOGIN_CHANNEL_ID,
        clientSecret: store.line_login_channel_secret || process.env.LINE_LOGIN_CHANNEL_SECRET,
        redirectUri:  store.line_login_redirect_uri   || process.env.LINE_LOGIN_REDIRECT_URI,
      }
    }
  }
  return {
    clientId:     process.env.LINE_LOGIN_CHANNEL_ID,
    clientSecret: process.env.LINE_LOGIN_CHANNEL_SECRET,
    redirectUri:  process.env.LINE_LOGIN_REDIRECT_URI,
  }
}

module.exports = { sendCode, verifyCode, login, setupPassword, getMe, updateMe, lineLogin, merchantLineLogin, merchantLinkLine, linkPhone }

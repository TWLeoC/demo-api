const supabase = require('../config/supabase')
const { success, error, paginate } = require('../utils/response')

// PostgREST 的 .or() 吃的是原始 filter 語法字串，`,` `.` `:` `(` `)` `\` 在這個語法裡
// 各自有特殊意義（分隔條件、欄位/運算子分隔、群組），使用者輸入塞進去前一定要處理，
// 不然可以用這些符號插入額外的查詢條件。逗號實測跳脫後 PostgREST 直接回 500（parse
// 失敗），姓名/手機/email 搜尋本來也用不到逗號，乾脆直接濾掉；其餘符號跳脫後正常運作
const escapePostgrestFilterValue = (str) => str.replace(/,/g, '').replace(/[.():\\]/g, '\\$&')

// GET /api/merchant/users
const getUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query
    const from = (page - 1) * limit
    const to = from + Number(limit) - 1

    let query = supabase
      .from('user')
      .select('id, role, status, email, name, phone, phone_verified_at, birth_date, created_at', { count: 'exact' })
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (status !== undefined) query = query.eq('status', status === 'true')
    if (search) {
      const s = escapePostgrestFilterValue(search)
      query = query.or(`name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`)
    }

    const { data, count, error: dbError } = await query
    if (dbError) throw dbError

    return paginate(res, data, count, page, limit)
  } catch (err) {
    next(err)
  }
}

// GET /api/merchant/users/:id
const getUser = async (req, res, next) => {
  try {
    const { data, error: dbError } = await supabase
      .from('user')
      .select('id, role, status, email, name, phone, phone_verified_at, birth_date, created_at, updated_at')
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .single()

    if (dbError || !data) return error(res, '使用者不存在', 404)
    return success(res, data)
  } catch (err) {
    next(err)
  }
}

// GET /api/merchant/users/:id/orders
const getUserOrders = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query
    const from = (page - 1) * limit
    const to = from + Number(limit) - 1

    const { data, count, error: dbError } = await supabase
      .from('order')
      .select('id, display_id, is_paid, is_ship, total_price, created_at', { count: 'exact' })
      .eq('user_id', req.params.id)
      .eq('store_id', req.storeId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (dbError) throw dbError
    return paginate(res, data, count, page, limit)
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/users/:id/status  (啟用/禁用)
const setUserStatus = async (req, res, next) => {
  try {
    const { status } = req.body

    if (req.params.id === req.user.id) return error(res, '不能禁用自己的帳號', 400)

    const { data, error: dbError } = await supabase
      .from('user')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .select('id, name, phone, status')
      .single()

    if (dbError) throw dbError
    return success(res, data, status ? '帳號已啟用' : '帳號已禁用')
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/users/:id/role  (升級/降級角色)
const setUserRole = async (req, res, next) => {
  try {
    const { role } = req.body

    if (req.params.id === req.user.id) return error(res, '不能修改自己的角色', 400)

    const { data, error: dbError } = await supabase
      .from('user')
      .update({ role, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .select('id, name, phone, role')
      .single()

    if (dbError) throw dbError
    return success(res, data, '角色已更新')
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/users/:id  (edit name / email)
const updateUser = async (req, res, next) => {
  try {
    const allowed = ['name', 'email']
    const updates = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })
    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('user')
      .update(updates)
      .eq('id', req.params.id)
      .eq('store_id', req.storeId)
      .select('id, name, email, phone, role')
      .single()

    if (dbError) throw dbError
    return success(res, data, '使用者資料已更新')
  } catch (err) {
    next(err)
  }
}

module.exports = { getUsers, getUser, getUserOrders, setUserStatus, setUserRole, updateUser }

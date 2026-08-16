const supabase = require('../config/supabase')
const { success, error, paginate } = require('../utils/response')

const EXPENSE_CATEGORIES = [
  '水費', '電費', '瓦斯費', '租金', '稅金',
  '人事費用', '原物料', '包裝材料', '設備維修', '行銷費用', '其他',
]

// GET /api/merchant/expenses
const getExpenses = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, year, month, category } = req.query
    const from = (page - 1) * limit
    const to = from + Number(limit) - 1

    let query = supabase
      .from('expense')
      .select('*', { count: 'exact' })
      .eq('store_id', req.storeId)
      .is('deleted_at', null)
      .order('expense_date', { ascending: false })
      .range(from, to)

    if (year && month) {
      const start = `${year}-${String(month).padStart(2, '0')}-01`
      const end = new Date(year, month, 0).toISOString().split('T')[0]
      query = query.gte('expense_date', start).lte('expense_date', end)
    } else if (year) {
      query = query.gte('expense_date', `${year}-01-01`).lte('expense_date', `${year}-12-31`)
    }
    if (category) query = query.eq('category', category)

    const { data, count, error: dbError } = await query
    if (dbError) throw dbError

    return paginate(res, data, count, page, limit)
  } catch (err) {
    next(err)
  }
}

// GET /api/merchant/expenses/categories
const getExpenseCategories = (_req, res) => {
  return success(res, EXPENSE_CATEGORIES)
}

// POST /api/merchant/expenses
const createExpense = async (req, res, next) => {
  try {
    const { category, amount, note, expense_date } = req.body
    const { data, error: dbError } = await supabase
      .from('expense')
      .insert({ category, amount: Number(amount), note: note || null, expense_date, store_id: req.storeId })
      .select()
      .single()
    if (dbError) throw dbError
    return success(res, data, '支出新增成功', 201)
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/expenses/:id
const updateExpense = async (req, res, next) => {
  try {
    const { id } = req.params
    const allowed = ['category', 'amount', 'note', 'expense_date']
    const updates = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })
    if (updates.amount !== undefined) updates.amount = Number(updates.amount)
    updates.updated_at = new Date().toISOString()

    const { data, error: dbError } = await supabase
      .from('expense')
      .update(updates)
      .eq('id', id)
      .eq('store_id', req.storeId)
      .is('deleted_at', null)
      .select()
      .single()
    if (dbError) throw dbError
    return success(res, data, '支出更新成功')
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/expenses/:id
const deleteExpense = async (req, res, next) => {
  try {
    const { id } = req.params
    const { error: dbError } = await supabase
      .from('expense')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('store_id', req.storeId)
    if (dbError) throw dbError
    return success(res, null, '支出已刪除')
  } catch (err) {
    next(err)
  }
}

module.exports = { getExpenses, getExpenseCategories, createExpense, updateExpense, deleteExpense }

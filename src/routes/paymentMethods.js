const router = require('express').Router()
const { requireStore } = require('../middlewares/store')
const supabase = require('../config/supabase')
const { success } = require('../utils/response')

router.get('/', requireStore, async (req, res, next) => {
  try {
    const { data: store } = await supabase.from('store').select('newebpay_enabled').eq('id', req.storeId).single()

    const { data, error } = await supabase
      .from('payment_method')
      .select('id, payment_method, provider')
      .eq('store_id', req.storeId)
      .order('id')
    if (error) throw error

    // 藍新關閉時，即使歷史上曾經開過而留下這筆 payment_method row，結帳清單也要濾掉
    const visible = (data || []).filter(m => m.provider !== 'newebpay' || store?.newebpay_enabled)
    return success(res, visible)
  } catch (err) {
    next(err)
  }
})

module.exports = router

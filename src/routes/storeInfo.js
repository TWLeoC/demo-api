const router = require('express').Router()
const supabase = require('../config/supabase')
const { requireStore } = require('../middlewares/store')
const { sendRushEndedNotification } = require('./line')

// GET /api/store-info — public endpoint, returns rush status
router.get('/', requireStore, async (req, res) => {
  try {
    const { data: store, error } = await supabase
      .from('store')
      .select('id, name, rush_until, rush_pending, phone_login_enabled, line_login_enabled, status, is_open, printer_enabled, ad_enabled, ad_image_url, ad_text')
      .eq('id', req.storeId)
      .single()

    if (error || !store) return res.status(404).json({ message: '商家不存在' })

    const now = new Date()
    let rushActive = false
    let rushUntil = null

    if (store.rush_until) {
      const until = new Date(store.rush_until)
      if (until > now) {
        rushActive = true
        rushUntil = store.rush_until
      } else {
        // Expired — clear it and send LINE notification
        await supabase
          .from('store')
          .update({ rush_until: null, rush_pending: false })
          .eq('id', store.id)
        sendRushEndedNotification(store.id).catch(() => {})
      }
    }

    return res.json({
      store_active: store.status === 'active',
      is_open: store.is_open ?? false,
      rush_active: rushActive,
      rush_until: rushUntil,
      phone_login_enabled: store.phone_login_enabled ?? false,
      line_login_enabled: store.line_login_enabled ?? false,
      printer_enabled: store.printer_enabled ?? false,
      ad_enabled: store.ad_enabled ?? false,
      ad_image_url: store.ad_image_url || '',
      ad_text: store.ad_text || '',
    })
  } catch (err) {
    return res.status(500).json({ message: err.message })
  }
})

module.exports = router

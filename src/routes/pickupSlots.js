const router = require('express').Router()
const { getPickupSlots } = require('../controllers/pickupSlotController')
const { requireStore } = require('../middlewares/store')

router.use(requireStore)

router.get('/', getPickupSlots)

module.exports = router

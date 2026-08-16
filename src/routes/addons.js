const router = require('express').Router()
const { body } = require('express-validator')
const { getAddons, createAddon, updateAddon, deleteAddon } = require('../controllers/addonController')
const { authenticate, authorizeMerchant } = require('../middlewares/auth')
const { requireStore } = require('../middlewares/store')
const validate = require('../middlewares/validate')

router.use(requireStore)

router.get('/', getAddons)

router.post('/', authenticate, authorizeMerchant,
  body('type').isIn(['option', 'text']),
  body('name').notEmpty().isLength({ max: 50 }),
  body('price').optional().isInt({ min: 0 }),
  body('sort_order').optional().isInt({ min: 0 }),
  validate,
  createAddon
)

router.patch('/:id', authenticate, authorizeMerchant,
  body('type').optional().isIn(['option', 'text']),
  body('name').optional().isLength({ max: 50 }),
  body('is_enable').optional().isBoolean(),
  validate,
  updateAddon
)

router.delete('/:id', authenticate, authorizeMerchant, deleteAddon)

module.exports = router

const router = require('express').Router()
const { body } = require('express-validator')
const { getCart, addItem, updateItem, removeItem, applyDiscount } = require('../controllers/cartController')
const { authenticate } = require('../middlewares/auth')
const validate = require('../middlewares/validate')

router.use(authenticate)

router.get('/', getCart)

router.post('/items',
  body('product_id').notEmpty(),
  body('quantity').optional().isInt({ min: 1 }),
  body('addon_ids').optional().isArray(),
  validate,
  addItem
)

router.patch('/items/:itemId',
  body('quantity').isInt({ min: 0 }),
  validate,
  updateItem
)

router.delete('/items/:itemId', removeItem)

router.post('/discount',
  body('code').notEmpty(),
  validate,
  applyDiscount
)

module.exports = router

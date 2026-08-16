const router = require('express').Router()
const { body } = require('express-validator')
const { createOrder, getOrders, getOrder, updateOrderItem, deleteOrderItem, payOrder, updatePaymentMethod, merchantGetOrder, merchantGetOrders, shipOrder, merchantConfirmPay, merchantConfirmOrder, merchantUpdatePickup, reprintOrder, merchantCancelOrder } = require('../controllers/orderController')
const { refundOrder } = require('../controllers/refundController')
const { authenticate, authorizeMerchant } = require('../middlewares/auth')
const validate = require('../middlewares/validate')

router.use(authenticate)

router.get('/', getOrders)
router.get('/:id', getOrder)

router.post('/',
  body('payment_method_id').optional({ nullable: true }).isInt(),
  body('pickup_slot_id').optional({ nullable: true }).isUUID(),
  body('pickup_time').optional({ nullable: true }).isLength({ max: 50 }).withMessage('取餐時間最多 50 字'),
  body('note').optional({ nullable: true }).isLength({ max: 200 }).withMessage('備註最多 200 字'),
  body('gift_choices').optional().isArray(),
  body('gift_choices.*.gift_rule_id').optional().isUUID(),
  body('gift_choices.*.option_id').optional().isUUID(),
  body('gift_addon_purchases').optional().isArray(),
  body('gift_addon_purchases.*.gift_rule_id').optional().isUUID(),
  body('gift_addon_purchases.*.quantity').optional().isInt({ min: 1 }),
  validate,
  createOrder
)

router.patch('/:id/pay',
  body('receipt').optional().isLength({ max: 10 }),
  validate,
  payOrder
)

router.patch('/:id/payment-method',
  body('payment_method_id').isInt(),
  validate,
  updatePaymentMethod
)

// Merchant
router.get('/merchant/all', authorizeMerchant, merchantGetOrders)
router.get('/merchant/:id', authorizeMerchant, merchantGetOrder)
router.patch('/merchant/:id/ship', authorizeMerchant, shipOrder)
router.patch('/merchant/:id/confirm', authorizeMerchant, merchantConfirmOrder)
router.patch('/merchant/:id/confirm-pay', authorizeMerchant, merchantConfirmPay)
router.patch('/merchant/:id/pickup', authorizeMerchant,
  body('pickup_slot_id').isUUID(),
  body('pickup_time').notEmpty().isLength({ max: 50 }),
  validate,
  merchantUpdatePickup
)
router.post('/merchant/:id/reprint', authorizeMerchant, reprintOrder)
router.patch('/merchant/:id/items/:itemId', authorizeMerchant,
  body('quantity').isInt({ min: 1 }),
  validate,
  updateOrderItem
)
router.delete('/merchant/:id/items/:itemId', authorizeMerchant, deleteOrderItem)
router.delete('/merchant/:id', authorizeMerchant, merchantCancelOrder)
router.post('/merchant/:id/refund', authorizeMerchant, refundOrder)

module.exports = router

const router = require('express').Router()
const { body } = require('express-validator')
const { getReceivers, createReceiver, updateReceiver, deleteReceiver } = require('../controllers/receiverController')
const { authenticate } = require('../middlewares/auth')
const validate = require('../middlewares/validate')

router.use(authenticate)

router.get('/', getReceivers)

router.post('/',
  body('name').notEmpty().isLength({ max: 50 }),
  body('phone').isMobilePhone(),
  body('post_code').isLength({ min: 3, max: 6 }),
  body('address').notEmpty().isLength({ max: 320 }),
  body('is_default').optional().isBoolean(),
  validate,
  createReceiver
)

router.patch('/:id',
  body('name').optional().isLength({ max: 50 }),
  body('phone').optional().isMobilePhone(),
  body('post_code').optional().isLength({ min: 3, max: 6 }),
  body('address').optional().isLength({ max: 320 }),
  body('is_default').optional().isBoolean(),
  validate,
  updateReceiver
)

router.delete('/:id', deleteReceiver)

module.exports = router

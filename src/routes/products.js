const router = require('express').Router();
const { body } = require('express-validator');
const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  reorderProducts,
} = require('../controllers/productController');
const { authenticate, authorizeMerchant } = require('../middlewares/auth');
const { requireStore } = require('../middlewares/store');
const validate = require('../middlewares/validate');

router.use(requireStore);

router.get('/', getProducts);

router.patch('/reorder', authenticate, authorizeMerchant, reorderProducts);

router.get('/:id', getProduct);

router.post(
  '/',
  authenticate,
  authorizeMerchant,
  body('product_code').optional().isLength({ max: 20 }).withMessage('商品編號最多 20 字'),
  body('name').notEmpty().isLength({ max: 50 }),
  body('origin_price').optional().isInt({ min: 0 }),
  body('price').isInt({ min: 0 }),
  body('stock').optional({ nullable: true }).isInt({ min: 0 }),
  body('unlimited_stock').optional().isBoolean(),
  validate,
  createProduct
);

router.patch(
  '/:id',
  authenticate,
  authorizeMerchant,
  body('product_code').optional().isLength({ max: 20 }),
  body('name').optional().isLength({ max: 50 }),
  body('price').optional().isInt({ min: 0 }),
  body('origin_price').optional().isInt({ min: 0 }),
  body('stock').optional({ nullable: true }).isInt({ min: 0 }),
  body('unlimited_stock').optional().isBoolean(),
  validate,
  updateProduct
);

router.delete('/:id', authenticate, authorizeMerchant, deleteProduct);

module.exports = router;

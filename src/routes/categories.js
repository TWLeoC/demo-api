const router = require('express').Router()
const { getCategories } = require('../controllers/categoryController')
const { requireStore } = require('../middlewares/store')

router.use(requireStore)

router.get('/', getCategories)

module.exports = router

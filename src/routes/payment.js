const router = require('express').Router()
const express = require('express')
const { notify, returnRedirect } = require('../controllers/paymentController')

// 藍新 POST application/x-www-form-urlencoded，掛在全域 json parser 之前
router.post('/newebpay/notify', express.urlencoded({ extended: false }), notify)
router.post('/newebpay/return', express.urlencoded({ extended: false }), returnRedirect)

module.exports = router

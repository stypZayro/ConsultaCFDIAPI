// src/routes/cfdi.routes.js
const { Router } = require('express');
const rateLimit = require('express-rate-limit');

const cfdiCtrl = require('../controllers/cfdi.controller');

const router = Router();

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// /facturacfdi/validar-cfdi  (lo que tenías en app.post(...))
router.post(
  '/validar-cfdi',
  heavyLimiter,
  cfdiCtrl.noCompression,
  cfdiCtrl.uploadcfdi.array('xmls', 100),
  cfdiCtrl.validarCfdi
);

module.exports = router;

const { Router } = require('express');
const rateLimit = require('express-rate-limit');

const controlGastos = require("../controllers/gastos.controller");
const routerAdu = Router();

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

routerAdu.post("/login", heavyLimiter, controlGastos.uploadGastos.none(),
  controlGastos.verificarUsuario,
)
routerAdu.post("/ConsultarGastos", heavyLimiter, controlGastos.uploadGastos.none(),
  controlGastos.buscarGastos,
);/*
routerAdu.post("/AsignarGasto", heavyLimiter, controlGastos.uploadGastos.none(),
  controlGastos.asignarGasto,
);*/

module.exports = routerAdu
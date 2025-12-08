const { Router } = require('express');
const rateLimit = require('express-rate-limit');

const consultasGastos = require("../controllers/gastos.controller");
const routerAdu = Router();

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

routerAdu.post("/login", consultasGastos.verificarUsuario
)
routerAdu.get("/ConsultarGastos", heavyLimiter,
  consultasGastos.buscarGastos,
);
routerAdu.post("/AsignarGasto", heavyLimiter,
  consultasGastos.asignarGasto,
);
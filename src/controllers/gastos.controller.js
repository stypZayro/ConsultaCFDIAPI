const path = require("path");
const multer = require('multer');
const axios = require('axios');
const nodemailer = require('nodemailer');

const { sqlAdu } = require("../../dbPoolAdu");
const { consultasGastos } = require("../repos/repoGastos");
const { RequestError } = require("tedious");
// Haría falta usar pLimit? - Noé

async function verificarUsuario(req, res) {
  async function withTimeout(promesa, ms, etiqueta) {
    let t;
    let tOut = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`Timeout ${ms} ms en ${etiqueta}`)), ms);
    });
    return Promise.race([
      promesa.finally(() => clearTimeout(t)),
      tOut
    ]);
  };
  console.log(req.body);
  const {userGastos, passGastos} = req.body;
  let resultado;
  try {
    resultado = await withTimeout(
      consultasGastos.sp_VerificarUs_Gastos(
        String(userGastos)
      ),
      10_000,
      "SP verificarUsuario"
    );
    if (!resultado || passGastos !== resultado[0].Clave) {
        throw new Error("Credenciales incorrectas");
    } else {
        return "Acceso concedido";
    };
  } catch (error) {
    console.warn("SP (usuario/clave):", error.message);
  }
}

// Pendiente manejar esta función.
async function buscarGastos(req, res) {
  async function withTimeout(promesa, ms, etiqueta) {
    let t;
    let tOut = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`Timeout ${ms} ms en ${etiqueta}`)), ms);
    });
    return Promise.race([
      promesa.finally(() => clearTimeout(t)),
      tOut
    ]);
  };
  console.log(req.body);
  if (!req.body) { return res.status(400).json({success: false, message: "No se ha ingresado una Referencia o Cliente"}); };
  const {ref, cli, asig} = req.body;
  // asigna el resultado y devuelve
  let resultado;
  try {
    resultado = await withTimeout(
      consultasGastos.sp_BuscarGastos(
        ref,
        cli,
        asig,
      ), 
      10_000, 
      `SP buscarGastos`);
    return resultado ? resultado : [];
  } catch(error) {
    console.warn("SP (referencia/cliente):", error.message);
  };
};

async function asignarGasto(req, res) {
  async function withTimeout(promesa, ms, etiqueta) {
    let t;
    let tOut = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`Timeout ${ms} ms en ${etiqueta}`)), ms);
    });
    return Promise.race([
      promesa.finally(() => clearTimeout(t)),
      tOut
    ]);
  };
  const { ref, gasto, valGasto } = req.body;
  if (!ref) {
    return res.status(400).jsom({success: false, message: "No ha provisto una referencia"});
  };
  if (!gasto) {
    return res.status(400).jsom({success: false, message: "ID de Gasto inválida"});
  };
  try {
    await withTimeout(
      consultasGastos.sp_VerificarUs_Gastos(
        String(ref),
        Number(gasto),
        valGasto
      ), 
      10_000, 
      'SP asignarGasto')
    return;
  } catch (error) {
    console.warn("SP (referencia/gasto/valor):", error.message);
  }
}

module.exports = {
  buscarGastos,
  asignarGasto,
  verificarUsuario
};
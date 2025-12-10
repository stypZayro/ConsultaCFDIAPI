const path = require("path");
const multer = require('multer');
const axios = require('axios');
const nodemailer = require('nodemailer');

const { sqlAdu } = require("../../dbPoolAdu");
const consultasGastos = require("../repos/repoGastos");
const { RequestError } = require("tedious");
// Haría falta usar pLimit? - Noé

const uploadGastos = multer();

async function verificarUsuario(req, res) {
  console.log(req.body)
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
  if (!req.body) { return res.status(400).json({success: false, message: "Credenciales Faltantes"}) };
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
    if (!resultado || passGastos !== resultado.recordset[0].Clave) {
        throw new Error("Credenciales incorrectas");
    } else {
        //return "Acceso concedido";
        res.status(200).json({access: true});
    };
  } catch (error) {
    console.warn("SP (usuario/clave):", error);
    res.status(403).json({access: false, message: `Error en la consulta: ${error}`})
  }
}

// Pendiente manejar esta función.
async function buscarGastos(req, res) {
  console.log(req.body);
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
  if (!req.body) { return res.status(400).json({success: false, message: "No se ha ingresado una Referencia o Cliente"}); };
  const {ref, cli, asig} = req.body;
  // asigna el resultado y devuelve
  let resultado;
  try {
    resultado = await withTimeout(
      consultasGastos.sp_BuscarGastos(
        ref,
        cli,
        asig === "true" ? true : false,
      ), 
      10_000, 
      `SP buscarGastos`);
    res.status(200).json({success: true, datos: resultado.recordset})
    //return resultado ? resultado : [];
  } catch(error) {
    console.warn("SP (referencia/cliente):", error.message);
    res.status(500).json({success: false, message: `Error en la consulta: ${error.message}`})
  };
};
/*
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
  console.log(req.body);
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
    res.status(200).json({success: true, message: "Consulta exitosa"});
  } catch (error) {
    console.warn("SP (referencia/gasto/valor):", error.message);
    res.status(500).json({success: false, message: `Error en la consulta: ${error.message}`});
  }
}
*/
module.exports = {
  uploadGastos,
  buscarGastos,
  //asignarGasto,
  verificarUsuario
};
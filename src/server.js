// src/server.js
require('dotenv').config();
const app = require('./app');
const { sql } = require('../dbPool');
const { sqlAdu } = require("../dbPoolAdu");

const PORT = process.env.PORT || 3016; // usa el mismo que antes si quieres

const server = app.listen(PORT, () => {
  console.log(`✅ CFDIAPI escuchando en puerto ${PORT}`);
});

// cerrar conexión SQL al apagar
async function shutdown() {
  console.log('Apagando CFDIAPI...');
  try { 
    await sql.close(); 
    await sqlAdu.close();
  } catch {}
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

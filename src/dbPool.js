const sql = require('mssql');

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    const cfg = {
      server: process.env.SQL_SERVER,               // p.ej. "10.0.0.5" o "sql.mi.dom"
      port: Number(process.env.SQL_PORT || 1433),
      database: process.env.SQL_DATABASE,
      // Puedes usar user/password simples:
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,

      // O si usas el formato 'authentication':
      // authentication: {
      //   type: 'default',
      //   options: { userName: process.env.SQL_USER, password: process.env.SQL_PASSWORD }
      // },

      options: {
        encrypt: String(process.env.SQL_ENCRYPT || 'false') === 'true', // Azure: true
        trustServerCertificate: String(process.env.SQL_TRUST_CERT || 'true') === 'true',
        enableArithAbort: true,
        // instanceName: process.env.SQL_INSTANCE || undefined, // si no usas puerto 1433
      },
      pool: {
        max: Number(process.env.SQL_POOL_MAX || 10),
        min: Number(process.env.SQL_POOL_MIN || 0),
        idleTimeoutMillis: Number(process.env.SQL_POOL_IDLE || 30000),
      },
      requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT || 120000), // 120s
      connectionTimeout: Number(process.env.SQL_CONN_TIMEOUT || 15000),
    };

    // Validación mínima de ENV
    ['SQL_SERVER','SQL_DATABASE','SQL_USER','SQL_PASSWORD'].forEach(k => {
      if (!process.env[k]) console.warn(`[mssql] ENV faltante: ${k}`);
    });

    poolPromise = new sql.ConnectionPool(cfg)
      .connect()
      .then(pool => {
        console.log('[mssql] Pool conectado');
        return pool;
      })
      .catch(err => {
        poolPromise = null;
        console.error('[mssql] Error conectando:', err.message);
        throw err;
      });
  }
  return poolPromise;
}

module.exports = { sql, getPool };

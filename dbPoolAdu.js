const sqlAdu = require ("mssql");

let poolPromiseAdu = null;

function getPoolAdu() {
	if (!poolPromiseAdu) {
		const cfg = {
			server: "slamnet.zayro.com",//process.env.serveraduana,
			port: 23390,//Number(process.env.SQL_POST || 1433),
			database: process.env.database,
			user: process.env.user,
			password: process.env.passwordaduana,
			options: {
				encrypt: String(process.env.SQL_ENCRYPT || "false") === "true",
				trustServerCertificate: String(process.env.SQL_TRUST_CERT || "true") === "true",
				enableArithAbort: true,
			},
			pool: {
				max: Number(process.env.SQL_POOL_MAX || 10),
				min: Number(process.env.SQL_POOL_MIN || 0),
				idleTimeoutMillis: Number(process.env.SQL_POOL_IDLE || 30000),
			},
			requestTimout: Number(process.env.SQL_REQUEST_TIMEOUT || 120000),
			connectionTimeout: Number(process.env.SQL_CONN_TIMEOUT || 15000),
		};
		["serveraduana", "database", "passwordaduana"].forEach(j => {
			if (!process.env[j]) { console.warn(`[mssql] ENV faltante: ${j}`) };
		});
		poolPromiseAdu = new sqlAdu.ConnectionPool(cfg)
			.connect()
			.then(pool => {
				//console.log("[mssql] Pool conectado");
				return pool;
			})
			.catch(err => {
				poolPromiseAdu = null;
				console.error("[mssql] Error conectando:", err.message);
				throw err;
			})
	};
	return poolPromiseAdu;
};

module.exports = { sqlAdu, getPoolAdu };
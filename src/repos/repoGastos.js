const { sqlAdu, getPoolAdu } = require("../../dbPoolAdu");

function ensureString(x) {
	return typeof(x) === "string" ? x : (x == null ? "" : String(x))
};
function ensureNumber(input) {
	return typeof(input) === "number" ? input : (input == null ? 0 : Number(input))
};
/** 
 * @param {string} referencia   asda
 * @param {int} cliente         asda
 * @param {bool} asig
*/

async function sp_VerificarUs_Gastos (usuario) {
    const sp_Name = "[Aduana].[dbo].[sp_VerificarUs_Gastos]";
    const varUs = ensureString(usuario);
    if (!varUs) {
        throw new Error("Usuario inválido");
    };
    try {
        const pool = await getPoolAdu();
        const req = pool.request();
        req.input("usuario", sqlAdu.VarChar(100), varUs)
        req.requestTimeout = Number(process.env.SQL_REQUEST_TIMEOUT || 12000)
        const result = await req.execute(sp_Name);
        return {
            ok: true,
            rowsAffected: result.rowsAffected,
            recordset: result.recordset || [],
            returnValue: result.returnValue
        };
    } catch (error) {
        console.error("[mssqlAdu] Error ejecutando SP:", {
            sp: "sp_VerificarUs_Gastos",
            msg: error.message
        });
        throw error;
    };
}

async function sp_BuscarGastos(referencia = "", cliente = 0, asig = false) {
	const sp_Name = "[Aduana].[dbo].[sp_BuscarGastos]";
	const 
		varRef = ensureString(referencia),
		varCli = ensureNumber(cliente);
    /*
        if (!varRef) {
        throw new Error("Referencia no especificada.");
    } else if (varCli === NaN) {
        throw new Error("Cliente inválido.");
    };
    */
	try {
		const pool = await getPoolAdu();
		const req = pool.request();
		
		req.input("valReferencia", 	sqlAdu.VarChar(30), referencia);
		req.input("idCliente", 		sqlAdu.Int,         cliente);
        req.input("sinAsignar",     sqlAdu.Bit,         asig)
		req.requestTimeout = Number(process.env.SQL_REQUEST_TIMEOUT || 120000);
		const result = await req.execute(sp_Name);
		return {
			ok: true,
			rowsAffected: result.rowsAffected,
			recordset: result.recordset || [],
			returnValue: result.returnValue
		};
	} catch (error) {
		console.error("[mssqlAdu] Error ejecutando SP:", {
			sp: "sp_BuscarGastos",
			Referencia: varRef == "" ? "N/A" : varRef,
			msg: error.message
		});
		throw error;
	}
};
/*
async function sp_AsignarGasto(referencia = "", gastoId, valorGasto) {
    const sp_Name = "[Aduana].[dbo].[sp_AsignarGasto]";
    const
        varRef = ensureString(referencia),
        varGastoId = ensureNumber(gastoId)
    if (!varRef) {
        throw new Error("Referencia no especificada");
    } else if (!varGastoId) {
        throw new Error("Gasto no especificado");
    };
    try {
        const pool = await getPoolAdu();
        const req = pool.request();

        req.input("varReferencia", sql.VarChar(20), referencia);
        req.input("idGasto", sql.Int, gastoId);
        req.input("valorgasto", sql.Money, valorGasto);
        req.requestTimeout = Number(process.env.SQL_REQUEST_TIMEOUT || 12000);
        const result = await req.execute(sp_Name)
        return {
            ok: true,
            rowsAffected: result.rowsAffected,
            recordset: result.recordset,
            returnValue: result.returnValue
        };
    } catch(error) {
        console.error("[mssqlAdu] Error ejecutando SP:", {
            sp: "sp_AsignarGasto",
            Referencia: varRef == "" ? "N/A" : varRef,
            msg: error.message
        })
        throw error;
    }
}
*/
module.exports = { 
    sp_BuscarGastos, 
    //sp_AsignarGasto,
    sp_VerificarUs_Gastos
};
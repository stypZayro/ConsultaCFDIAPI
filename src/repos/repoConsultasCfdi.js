const { sql, getPool } = require('../../dbPool');

function ensureString(x) {
  return typeof x === 'string' ? x : (x == null ? '' : String(x));
}

/**
 * Inserta/Registra una consulta de CFDI
 * @param {string} cfdi          (ej. UUID o identificador)
 * @param {string} xmlfactura    XML de la factura (string UTF-8 bien formado)
 * @param {string} xmlrespuesta  XML de respuesta SAT (string UTF-8)
 */
async function sp_intertar_registro_consultas_cfdi(cfdi, xmlfactura, xmlrespuesta) {
  // Ajusta el nombre si realmente es "insertar"
  const SP_NAME = '[ramadre].[dbo].[sp_intertar_registro_consultas_cfdi]';

  // Validaciones mínimas
  const vCfdi = ensureString(cfdi).trim();
  const vXmlFactura = ensureString(xmlfactura);
  const vXmlRespuesta = ensureString(xmlrespuesta);
  if (!vCfdi) throw new Error('Parámetro cfdi vacío');

  try {
    const pool = await getPool();
    const req = pool.request();

    req.input('cfdi', sql.VarChar(150), vCfdi);

    // Usa sql.Xml SOLO si los parámetros del SP son tipo XML.
    req.input('xmlfactura',  sql.Xml, vXmlFactura);
    req.input('xmlrespuesta', sql.Xml, vXmlRespuesta); 

    // Si en el SP están como NVARCHAR(MAX), usa esto en lugar de lo anterior:
    // req.input('xmlfactura',  sql.NVarChar(sql.MAX), vXmlFactura);
    // req.input('xmlrespuesta', sql.NVarChar(sql.MAX), vXmlRespuesta);

    // Timeout por request (opcional si ya lo tienes global)
    req.requestTimeout = Number(process.env.SQL_REQUEST_TIMEOUT || 120000);

    const result = await req.execute(SP_NAME);

    return {
      ok: true,
      rowsAffected: result.rowsAffected,
      recordset: result.recordset || [],
      returnValue: result.returnValue
    };

  } catch (error) {
    console.error('[mssql] Error ejecutando SP:', {
      sp: 'sp_intertar_registro_consultas_cfdi',
      cfdi: vCfdi,
      msg: error.message
    });
    throw error;
  }
}

module.exports = { sp_intertar_registro_consultas_cfdi };

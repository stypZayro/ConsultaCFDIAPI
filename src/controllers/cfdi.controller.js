// src/controllers/cfdi.controller.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const archiver = require('archiver');
const multer = require('multer');
const axios = require('axios');
const puppeteer = require('puppeteer');
const tmp = require('tmp');
const { PassThrough } = require('stream');
const nodemailer = require('nodemailer');
const fastXmlParser = require('fast-xml-parser');
const { XMLParser } = fastXmlParser;
const he = require('he');

const { DOMMatrix, ImageData, Path2D } = require('canvas');
global.DOMMatrix = global.DOMMatrix || DOMMatrix;
global.ImageData = global.ImageData || ImageData;
global.Path2D   = global.Path2D   || Path2D;

const { sql } = require('../../dbPool');
const { sp_intertar_registro_consultas_cfdi } = require('../repos/repoConsultasCfdi');
const pLimit = require('../utils/plimit');
const limit = pLimit(3); // límite de concurrencia para ZIP

// =================== Multer (upload XML) ===================
const uploadcfdi = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12 MB por XML
  fileFilter: (req, file, cb) => {
    if (!/\.xml$/i.test(file.originalname)) return cb(new Error('Solo se permiten .xml'), false);
    cb(null, true);
  }
});

// =================== noCompression ===================
function noCompression(req, res, next) {
  res.set('x-no-compression', '1');
  next();
}

// =================== Helpers SAT ===================
function formatTT(total) {
  const n = Number(total);
  if (!Number.isFinite(n)) throw new Error('Total inválido');
  return n.toFixed(6).replace(/\.?0+$/, ''); // máx 6 decimales, sin ceros sobrantes
}

function buildExpresionImpresa({ uuid, rfcEmisor, rfcReceptor, total }) {
  const tt = formatTT(total);
  return `?re=${String(rfcEmisor).toUpperCase()}&rr=${String(rfcReceptor).toUpperCase()}&tt=${tt}&id=${String(uuid).toUpperCase()}`;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildSoapEnvelope(expresionImpresa) {
  const safe = xmlEscape(expresionImpresa); // evita DeserializationFailed
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <Consulta xmlns="http://tempuri.org/">
      <expresionImpresa>${safe}</expresionImpresa>
    </Consulta>
  </s:Body>
</s:Envelope>`;
}

function parseSoapResponse(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    allowBooleanAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    removeNSPrefix: true,      // quita s:, a:, etc.
    emptyTagValue: ''
  });

  const j = parser.parse(xml);

  // Fault
  const fault = j?.Envelope?.Body?.Fault;
  if (fault) {
    const code = fault?.faultcode ?? '';
    const msg  = fault?.faultstring ?? 'SOAP Fault';
    throw new Error(`SAT SOAP Fault: ${code} - ${msg}`);
  }

  const body   = j?.Envelope?.Body ?? {};
  const resp   = body?.ConsultaResponse ?? body?.Response ?? {};
  const result = resp?.ConsultaResult ?? resp?.Result ?? {};

  const get = (k) => (k in result ? result[k] : null);

  return {
    codigoEstatus:      get('CodigoEstatus'),
    estado:             get('Estado'),
    esCancelable:       get('EsCancelable'),
    estatusCancelacion: get('EsCancelable'),
    validacionEFOS:     get('ValidacionEFOS'),
  };
}

async function consultaSAT({ uuid, rfcEmisor, rfcReceptor, total }) {
  const expresion = buildExpresionImpresa({ uuid, rfcEmisor, rfcReceptor, total });
  const soapBody  = buildSoapEnvelope(expresion);
  const { data, status } = await axios.post(
    'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc',
    soapBody,
    {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://tempuri.org/IConsultaCFDIService/Consulta',
        'Accept': 'text/xml'
      },
      timeout: 12000,
      validateStatus: () => true
    }
  );
  if (status >= 400) throw new Error(`HTTP ${status} del SAT`);
  return parseSoapResponse(data);
}

// =================== Helpers PDF / HTML ===================
function toCurrencyMXN(n) {
  return Number(n).toLocaleString('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2
  });
}

function fmt(dt) {
  const d = (dt instanceof Date) ? dt : new Date(dt);
  if (isNaN(d)) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function buildHTML({
  rfcEmisor, nombreEmisor, rfcReceptor, nombreReceptor,
  uuid, total, fechaExpedicion, fechaTimbrado, pacRfc,
  estadoCFDI, estatusCancelacion
}) {
  const esc = (v) =>
    he.encode(v == null ? '' : String(v), {
      useNamedReferences: true,
      allowUnsafeSymbols: true
    });

  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const fechaImpresion = `${p(now.getDate())}/${p(now.getMonth() + 1)}/${String(now.getFullYear()).slice(-2)}, ${p(now.getHours())}:${p(now.getMinutes())}`;

  // carpeta 'public' junto a app.js => desde controllers subimos un nivel
  const publicDir = path.join(__dirname, '..', 'public');
  const logoPath = path.join(publicDir, 'Imagenes', 'logo_sat.jpg');

  if (!fs.existsSync(logoPath)) {
    console.error('No existe el logo en:', logoPath);
  }

  let LOGO_SAT_SRC = '';
  if (fs.existsSync(logoPath)) {
    const logoBase64 = fs.readFileSync(logoPath).toString('base64');
    LOGO_SAT_SRC = `data:image/jpeg;base64,${logoBase64}`;
  }

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Verificación de Comprobantes Fiscales Digitales por Internet</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    /* Carta con 2mm por lado */
    @page { size: Letter; margin: 2mm 2mm 2mm 2mm; }
    .margen{margin: 10mm 10mm 10mm 10mm;}

    :root { --text:#222; --muted:#555; --border:#e3e3e3; --head:#111; }

    html, body { height: 100%; }
    body {
      margin: 0;
      color: var(--text);
      font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,sans-serif;
    }

    /* ===== Barra superior pegada arriba ===== */
    .print-head{
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      font-size: 12px;
      color: #222;
      margin: 0;
      padding: 0;
    }
    .print-head .left   { text-align: left; }
    .print-head .center { text-align: center; font-weight: 600; }
    .print-head .right  { text-align: right; }

    /* Logos debajo, a la izquierda */
    .logos{
      display: flex;
      align-items: center;
      gap: 16px;
      margin-top: 6px;
      margin-bottom: 0;
    }
    .logos img.logosat{ height: 35px; display: block; }

    /* Título y divisor */
    .title-lg{
      font-size: 18px;
      font-weight: 700;
      margin: 14px 0 10px;
    }
    .hr{ height: 1px; background: var(--border); margin: 0 0 12px; }

    /* Tabla 4 columnas */
    .grid{
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      margin-bottom: 12px;
    }
    .grid thead th{
      font-size: 13px;
      text-align: left;
      color: var(--muted);
      font-weight: 600;
      border-bottom: 1px solid var(--border);
      padding: 10px 8px;
    }
    .grid tbody td{
      font-size: 14px;
      padding: 10px 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    .col-25{ width: 25%; }
    .col-25v{ width: 25%; }

    .spacer{ height: 12px; }

    /* “Imprimir” a la derecha */
    .print-right{
      margin-top: 10px;
      text-align: right;
      font-size: 14px;
      color: #666;
    }
    .grid thead th.col-25 {
        font-weight: 700;
    }

    /* Pie: alineado a los 2mm */
    .footer{
      position: fixed;
      left: 2mm;
      right: 2mm;
      bottom: 2mm;
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: #666;
    }
  </style>
</head>
<body>

  <!-- hasta arriba -->
  <div class="print-head">
    <div class="left">${esc(fechaImpresion)}</div>
    <div class="center">Verificación de Comprobantes Fiscales Digitales por Internet</div>
    <div class="right"></div>
  </div>
  <div class="margen">

    <!-- fila de logos -->
    <div class="logos">
        ${LOGO_SAT_SRC ? `<img class="logosat" src="${LOGO_SAT_SRC}" alt="Hacienda y SAT">` : ''}
    </div>

    <div class="title-lg">Verificación de comprobantes fiscales digitales por internet</div>
    <div class="hr"></div>

    <!-- Bloque 1 -->
    <table class="grid">
        <thead>
        <tr>
            <th class="col-25">RFC del emisor</th>
            <th class="col-25">Nombre o razón social del emisor</th>
            <th class="col-25">RFC del receptor</th>
            <th class="col-25">Nombre o razón social del receptor</th>
        </tr>
        </thead>
        <tbody>
        <tr>
            <td class="col-25v">${esc(rfcEmisor)}</td>
            <td class="col-25v">${esc(nombreEmisor||'')}</td>
            <td class="col-25v">${esc(rfcReceptor)}</td>
            <td class="col-25v">${esc(nombreReceptor||'')}</td>
        </tr>
        </tbody>
    </table>

    <!-- Bloque 2 -->
    <table class="grid">
        <thead>
        <tr>
            <th class="col-25">Folio fiscal</th>
            <th class="col-25">Fecha de expedición</th>
            <th class="col-25">Fecha certificación SAT</th>
            <th class="col-25">PAC que certificó</th>
        </tr>
        </thead>
        <tbody>
        <tr>
            <td class="col-25v">${esc(uuid)}</td>
            <td class="col-25v">${esc(fmt(fechaExpedicion)||'')}</td>
            <td class="col-25v">${esc(fmt(fechaTimbrado)||'')}</td>
            <td class="col-25v">${esc(pacRfc||'')}</td>
        </tr>
        </tbody>
    </table>

    <!-- Bloque 3 -->
    <table class="grid">
        <thead>
        <tr>
            <th class="col-25">Total del CFDI</th>
            <th class="col-25">Efecto del comprobante</th>
            <th class="col-25">Estado CFDI</th>
            <th class="col-25">Estatus de cancelación</th>
        </tr>
        </thead>
        <tbody>
        <tr>
            <td class="col-25v">${(total!=null)?esc(toCurrencyMXN(total)) : ''}</td>
            <td class="col-25v">Ingreso</td>
            <td class="col-25v">${esc(estadoCFDI||'')}</td>
            <td class="col-25v">${esc(estatusCancelacion||'')}</td>
        </tr>
        </tbody>
    </table>

    <div class="hr"></div>
    <div class="print-right">Imprimir</div>
  </div>

  <!-- Pie de página -->
  <div class="footer">
    <div>https://verificacfdi.facturaelectronica.sat.gob.mx</div>
    <div>1/1</div>
  </div>

</body>
</html>`;
}

// =================== Parser XML CFDI ===================
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true
});

// Normalizador mínimo CFDI 4.0
function extractRequiredFromXml(xmlText) {
  const j = parser.parse(xmlText);

  const comprobante = j['cfdi:Comprobante'] || j['Comprobante'] || j.Comprobante || {};
  const emisor      = comprobante['cfdi:Emisor'] || comprobante.Emisor || {};
  const receptor    = comprobante['cfdi:Receptor'] || comprobante.Receptor || {};
  const compl       = comprobante['cfdi:Complemento'] || comprobante.Complemento || {};
  const tfd         = (compl && (compl['tfd:TimbreFiscalDigital'] || compl.TimbreFiscalDigital)) || {};

  const uuid          = tfd.UUID || tfd.Uuid || tfd.uuid || '';
  const rfcEmisor     = emisor.Rfc || emisor.RFC || emisor.rfc || '';
  const rfcReceptor   = receptor.Rfc || receptor.RFC || receptor.rfc || '';
  const total         = comprobante.Total || comprobante.total || comprobante.SubTotal || comprobante.subTotal || '';
  const nombreEmisor  = emisor.Nombre || emisor.nombre || '';
  const nombreReceptor= receptor.Nombre || receptor.nombre || '';
  const fechaExpedicion = comprobante.Fecha || comprobante.fecha || '';
  const fechaTimbrado   = tfd.FechaTimbrado || tfd.Fecha || tfd.fecha || '';
  const pacRfc          = tfd.RfcProvCertif || tfd.RFCProvCertif || '';

  return {
    uuid, rfcEmisor, rfcReceptor, total,
    nombreEmisor, nombreReceptor, fechaExpedicion, fechaTimbrado, pacRfc
  };
}

// =================== Mailer ===================
const mailer = nodemailer.createTransport({
  host: process.env.hostemail,
  port: process.env.portemail,
  secure: true,
  auth: {
    user: process.env.useremail,
    pass: process.env.passemail
  },
  connectionTimeout: 15_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

function buildMailHtml({ title, intro, list = [] }) {
  const li = list.map(x => `<li>${x}</li>`).join('');
  return `
    <div style="font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#222">
      <h2 style="margin:0 0 8px 0">${title}</h2>
      <p>${intro}</p>
      ${list.length ? `<ul>${li}</ul>` : ''}
      <p style="margin-top:16px;color:#666">Mensaje automático — Zayro Logistics</p>
    </div>
  `;
}

async function sendMailWithTimeout(options, ms = 12000) {
  let t;
  const killer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`Timeout al enviar correo (${ms}ms)`)), ms);
  });
  try {
    const out = await Promise.race([mailer.sendMail(options), killer]);
    return out;
  } finally {
    clearTimeout(t);
  }
}

// =================== XML normalizado para SQL ===================
function normalizeXmlForSql(xml) {
  let s = String(xml ?? '');
  s = s.replace(/^\uFEFF/, '');
  s = s.replace(/^<\?xml[^?]*\?>\s*/i, '');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return s.trim();
}

// =================== Handler principal ===================
async function validarCfdi(req, res) {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No se recibieron XML.' });
  }

  let browser = null;
  let archive = null;
  const manifest = [];

  // Finalizar ZIP siempre
  async function safeFinalizeZip() {
    try {
      // archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), { name: 'manifest.json' });
    } catch (_) {}
    return new Promise((resolve) => {
      archive.once('close', resolve);
      try { archive.finalize(); } catch { resolve(); }
    });
  }

  // Timeout duro de promesa
  function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`Timeout ${ms}ms en ${label}`)), ms);
    });
    return Promise.race([
      promise.finally(() => clearTimeout(t)),
      timeout
    ]);
  }

  // Render PDF a Buffer
  async function renderPdfToBuffer(html, browser) {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });

    const data = await page.pdf({
      format: 'Letter',
      margin: { top: '20mm', right: '18mm', bottom: '18mm', left: '18mm' },
      printBackground: true
    });

    await page.close();

    const buf = Buffer.isBuffer(data)
      ? data
      : (data && typeof data === 'object' && 'byteLength' in data)
        ? Buffer.from(data)
        : Buffer.from([]);

    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw new Error('PDF inválido: no es Buffer o está vacío');
    }
    return buf;
  }

  try {
    // ==================== Rama 1 archivo -> PDF directo ====================
    if (files.length === 1) {
      const f = files[0];
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

      const xmlText = f.buffer.toString('utf8');
      const reqData = extractRequiredFromXml(xmlText);

      if (!reqData.uuid || !reqData.rfcEmisor || !reqData.rfcReceptor || !reqData.total) {
        return res.status(422).json({ ok: false, error: 'XML sin uuid/rfcEmisor/rfcReceptor/total' });
      }

      const expresion = buildExpresionImpresa({
        uuid: reqData.uuid,
        rfcEmisor: reqData.rfcEmisor,
        rfcReceptor: reqData.rfcReceptor,
        total: reqData.total
      });
      const soapBody = buildSoapEnvelope(expresion);

      const { data, status } = await axios.post(
        'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc',
        soapBody,
        {
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': 'http://tempuri.org/IConsultaCFDIService/Consulta',
            'Accept': 'text/xml'
          },
          timeout: 90_000,
          validateStatus: () => true
        }
      );
      if (status >= 400) throw new Error(`HTTP ${status} del SAT`);

      const sat = parseSoapResponse(data);
      console.log(reqData.uuid);

      // Guardar en BD (SP)
      try {
        const xmlFactura   = normalizeXmlForSql(xmlText);
        const xmlRespuesta = normalizeXmlForSql(data);

        await withTimeout(
          sp_intertar_registro_consultas_cfdi(
            String(reqData.uuid).toUpperCase(),
            xmlFactura,
            xmlRespuesta
          ),
          10_000,
          `SP consultas_cfdi (1 archivo ${reqData.uuid})`
        );
      } catch (spErr) {
        console.warn('SP (1 archivo) falló:', spErr.message);
      }

      const html = buildHTML({
        rfcEmisor: String(reqData.rfcEmisor).toUpperCase(),
        nombreEmisor: reqData.nombreEmisor,
        rfcReceptor: String(reqData.rfcReceptor).toUpperCase(),
        nombreReceptor: reqData.nombreReceptor,
        uuid: String(reqData.uuid).toUpperCase(),
        total: reqData.total,
        fechaExpedicion: reqData.fechaExpedicion,
        fechaTimbrado: reqData.fechaTimbrado,
        pacRfc: reqData.pacRfc,
        estadoCFDI: sat.estado,
        estatusCancelacion: sat.estatusCancelacion
      });

      const pdfBuffer = await renderPdfToBuffer(html, browser);
      await browser.close(); browser = null;

      const safeUuid = String(reqData.uuid).toUpperCase().replace(/[^A-Z0-9\-]/g, '_');
      const fileName = `verificacion_${safeUuid}.pdf`;

      // Correo con PDF adjunto
      try {
        const notifyTo = (req.body.notifyTo || req.query.notifyTo || process.env.NOTIFY_TO || '').trim();
        if (notifyTo) {
          await sendMailWithTimeout({
            from: 'sistemas@zayro.com',
            to: notifyTo,
            subject: `[CFDI] Verificación ${String(reqData.uuid).toUpperCase()} — ${sat.estado || 'SIN ESTADO'}`,
            html: buildMailHtml({
              title: 'Verificación CFDI (1 archivo)',
              intro: `Se validó el CFDI.`,
              list: [
                `UUID: ${String(reqData.uuid).toUpperCase()}`,
                `Emisor: ${String(reqData.rfcEmisor).toUpperCase()}`,
                `Receptor: ${String(reqData.rfcReceptor).toUpperCase()}`,
                `Estado SAT: ${sat.estado || 'N/D'}`,
                `Estatus cancelación: ${sat.estatusCancelacion || 'N/D'}`,
              ],
            }),
            attachments: [
              {
                filename: fileName,
                content: pdfBuffer
              }
            ],
          }, 12000);
        }
      } catch (mailErr) {
        console.warn('Correo (1 archivo) falló:', mailErr.message);
      }

      res.status(200);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.end(pdfBuffer);
    }

    // ==================== Rama ZIP (2+ archivos) ====================
    res.status(200);
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="verificaciones_cfdi.zip"');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('Connection', 'keep-alive');

    try { res.setTimeout(0); } catch {}

    archive = archiver('zip', { zlib: { level: 9 } });

    const tmpZipPath = path.join(os.tmpdir(), `verificaciones_cfdi_${Date.now()}.zip`);
    const fileStream = fs.createWriteStream(tmpZipPath);
    const tee = new PassThrough();

    archive.pipe(tee);
    tee.pipe(res);
    tee.pipe(fileStream);

    archive.on('warning', (w) => console.warn('archiver warning:', w));
    archive.on('error',   (e) => { console.error('archiver error:', e); try { res.end(); } catch {} });
    archive.on('finish',  () => console.log('ZIP bytes escritos:', archive.pointer()));
    archive.on('close',   () => console.log('ZIP cerrado'));

    res.on('close', () => { try { archive.destroy(); } catch {} });
    res.on('error', (e) => { console.error('res error:', e); try { archive.destroy(); } catch {} });
    res.removeHeader('Content-Length');
    res.setHeader('Transfer-Encoding', 'chunked');

    archive.pipe(res);

    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

    const FILE_TIMEOUT_MS = 45_000;

    const tasks = files.map((f) =>
      limit(async () => {
        const entry = { filename: f.originalname };
        let pdfName = null;
        let safeUuid = null;

        try {
          const xmlText = f.buffer.toString('utf8');
          const reqData = extractRequiredFromXml(xmlText);

          if (!reqData.uuid || !reqData.rfcEmisor || !reqData.rfcReceptor || !reqData.total) {
            entry.ok = false;
            entry.error = 'XML no contiene uuid/rfcEmisor/rfcReceptor/total';
            manifest.push(entry);
            return;
          }

          const expresion = buildExpresionImpresa({
            uuid: reqData.uuid,
            rfcEmisor: reqData.rfcEmisor,
            rfcReceptor: reqData.rfcReceptor,
            total: reqData.total
          });
          const soapBody = buildSoapEnvelope(expresion);

          const satResp = await withTimeout(
            axios.post(
              'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc',
              soapBody,
              {
                headers: {
                  'Content-Type': 'text/xml; charset=utf-8',
                  'SOAPAction': 'http://tempuri.org/IConsultaCFDIService/Consulta',
                  'Accept': 'text/xml'
                },
                timeout: 90_000,
                validateStatus: () => true
              }
            ),
            20_000,
            `SAT ${reqData.uuid}`
          );

          if (satResp.status >= 400) throw new Error(`HTTP ${satResp.status} del SAT`);

          const sat = parseSoapResponse(satResp.data);

          try {
            const xmlFactura   = normalizeXmlForSql(xmlText);
            const xmlRespuesta = normalizeXmlForSql(satResp.data);

            await withTimeout(
              sp_intertar_registro_consultas_cfdi(
                String(reqData.uuid).toUpperCase(),
                xmlFactura,
                xmlRespuesta
              ),
              10_000,
              `SP consultas_cfdi (${reqData.uuid})`
            );
            entry.dbSaved = true;
          } catch (spErr) {
            entry.dbSaved = false;
            entry.dbError = spErr.message;
            console.warn(`SP (ZIP ${reqData.uuid}) falló:`, spErr.message);
          }

          const html = buildHTML({
            rfcEmisor: String(reqData.rfcEmisor).toUpperCase(),
            nombreEmisor: reqData.nombreEmisor,
            rfcReceptor: String(reqData.rfcReceptor).toUpperCase(),
            nombreReceptor: reqData.nombreReceptor,
            uuid: String(reqData.uuid).toUpperCase(),
            total: reqData.total,
            fechaExpedicion: reqData.fechaExpedicion,
            fechaTimbrado: reqData.fechaTimbrado,
            pacRfc: reqData.pacRfc,
            estadoCFDI: sat.estado,
            estatusCancelacion: sat.estatusCancelacion
          });

          const pdfBuffer = await withTimeout(
            renderPdfToBuffer(html, browser),
            FILE_TIMEOUT_MS,
            `PDF ${reqData.uuid}`
          );

          safeUuid = String(reqData.uuid).toUpperCase().replace(/[^A-Z0-9\-]/g, '_');
          pdfName  = `verificacion_${safeUuid}.pdf`;

          archive.append(pdfBuffer, { name: pdfName });

          entry.ok = true;
          entry.uuid = reqData.uuid;
          entry.rfcEmisor = reqData.rfcEmisor;
          entry.rfcReceptor = reqData.rfcReceptor;
          entry.total = String(reqData.total);
          entry.pdf = pdfName;
          entry.estadoSAT = sat.estado;
          entry.estatusCancelacion = sat.estatusCancelacion;
          manifest.push(entry);

        } catch (err) {
          entry.ok = false;
          entry.pdf = pdfName;
          entry.error = err.message || String(err);
          manifest.push(entry);
        }
      })
    );

    await Promise.allSettled(tasks);

    try { await browser.close(); } catch {}
    browser = null;

    await safeFinalizeZip();

    // Correo con ZIP adjunto + manifest
    try {
      await new Promise((resolve) => fileStream.once('close', resolve));

      const notifyTo = (req.body.notifyTo || req.query.notifyTo || process.env.NOTIFY_TO || '').trim();
      if (notifyTo) {
        const okCount  = manifest.filter(x => x.ok === true).length;
        const errCount = manifest.filter(x => !x.ok).length;
        const intro    = `Se procesaron ${files.length} XML. OK: ${okCount} — Errores: ${errCount}.`;

        await sendMailWithTimeout({
          from: 'sistemas@zayro.com',
          to: notifyTo,
          subject: `[CFDI] Verificación masiva (${okCount} OK / ${errCount} con error)`,
          html: buildMailHtml({
            title: 'Verificación CFDI (múltiples archivos)',
            intro,
            list: [
              `Total recibidos: ${files.length}`,
              `Correctos: ${okCount}`,
              `Con error: ${errCount}`,
            ],
          }),
          attachments: [
            {
              filename: 'manifest.json',
              content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
              contentType: 'application/json'
            },
            {
              filename: 'verificaciones_cfdi.zip',
              path: tmpZipPath
            }
          ],
        }, 15_000);
      }
    } catch (mailErr) {
      console.warn('Correo (ZIP) falló:', mailErr.message);
    }

    try { await browser?.close(); } catch {}
    browser = null;

    return;

  } catch (e) {
    console.error('validar-cfdi error:', e);
    try { if (browser) await browser.close(); } catch {}
    browser = null;

    if (res.headersSent) {
      manifest.push({ ok: false, error: e.message || String(e) });
      try { await safeFinalizeZip(); } catch {}
    } else {
      res.status(502).json({ ok: false, error: e.message });
    }
  }
}

module.exports = {
  uploadcfdi,
  noCompression,
  validarCfdi,
};

const express = require('express');
const morgan = require('morgan');

const path = require('path');
const fs = require('fs');
const http = require('http');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const multer = require('multer');
const fastXmlParser = require('fast-xml-parser');
const { XMLParser } = fastXmlParser;

const { DOMMatrix, ImageData, Path2D } = require('canvas');
global.DOMMatrix = global.DOMMatrix || DOMMatrix;
global.ImageData = global.ImageData || ImageData;
global.Path2D   = global.Path2D   || Path2D;

const pdfParse = require('pdf-parse');
const axios = require('axios');
const xml2js = require('xml2js');
const he = require('he');
const puppeteer = require('puppeteer');
const tmp = require('tmp');
const { PassThrough } = require('stream');

const { v4: uuidv4 } = require('uuid'); // ✅ faltaba
const { validate, authBearer, errorHandler, z } = require('./middlewares');

dotenv.config();

const app = express();
const server = http.createServer(app);


// ===== Config =====
const PORT = process.env.PORT || 3016;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://www.zayro.com')
  .split(',')
  .map(s => s.trim());

// ===== Seguridad / transporte base =====
app.set('trust proxy', 1);
app.use(helmet());
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// Logs
app.use(morgan('dev'));

// JSON parser con límite y manejo de errores JSON
app.use(express.json({ limit: '512kb' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'invalid_json' });
  }
  next(err);
});

// Rate limit GLOBAL suave
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

// Request-Id para trazabilidad
app.use((req, res, next) => {
  req.id = req.get('X-Request-Id') || uuidv4();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Rechazo de métodos y Content-Type inesperados
const methodsPermitidos = ['GET','POST','PUT','PATCH','DELETE','OPTIONS'];
app.use((req, res, next) => {
  if (!methodsPermitidos.includes(req.method)) {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (['POST','PUT','PATCH'].includes(req.method)) {
    const ct = (req.get('Content-Type') || '').toLowerCase();
    const isJson = ct.startsWith('application/json');
    const isMultipart = ct.startsWith('multipart/form-data');
    if (!isJson && !isMultipart) {
      return res.status(415).json({ error: 'unsupported_media_type' });
    }
  }
  next();
});

// Normalización GLOBAL de strings (trim; '' -> undefined)
function normalizeStrings(obj) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        const trimmed = v.trim();
        obj[k] = trimmed === '' ? undefined : trimmed;
      } else if (v && typeof v === 'object') {
        normalizeStrings(v);
      }
    }
  }
}
app.use((req, res, next) => {
  normalizeStrings(req.query);
  normalizeStrings(req.body);
  next();
});

// VALIDACIÓN GLOBAL de query comunes si aparecen
const GlobalQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  sort: z.string().max(64).optional(),
  order: z.enum(['asc','desc']).optional(),
  desde: z.string().optional()
    .refine(v => !v || /^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isNaN(Date.parse(v)), { message: 'Fecha inválida: use YYYY-MM-DD o ISO' }),
  hasta: z.string().optional()
    .refine(v => !v || /^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isNaN(Date.parse(v)), { message: 'Fecha inválida: use YYYY-MM-DD o ISO' }),
  usuario: z.string().max(64).optional(),
  sucursal: z.string().max(64).optional(),
}).passthrough()
  .superRefine((obj, ctx) => {
    if (obj.desde && obj.hasta) {
      const d1 = new Date(obj.desde);
      const d2 = new Date(obj.hasta);
      if (d1 > d2) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'desde no puede ser mayor que hasta', path: ['hasta'] });
    }
  });

app.use((req, res, next) => {
  const q = GlobalQuerySchema.safeParse(req.query);
  if (!q.success) {
    return res.status(400).json({ error: 'validation', where: 'query', details: q.error.issues });
  }
  req.query = q.data;
  next();
});

// Hardening de body
const denyBodyKeys = new Set(['$where', '$expr', '__proto__', 'constructor']);
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    for (const k of Object.keys(req.body)) {
      if (denyBodyKeys.has(k)) {
        return res.status(400).json({ error: 'invalid_field', field: k });
      }
      const stack = [req.body[k]];
      let depth = 0, maxDepth = 20;
      while (stack.length) {
        const cur = stack.pop();
        if (cur && typeof cur === 'object') {
          depth++;
          if (depth > maxDepth) return res.status(400).json({ error: 'object_too_deep' });
          for (const kk of Object.keys(cur)) stack.push(cur[kk]);
        }
      }
    }
  }
  next();
});

// ====================== Rutas públicas si las hay ======================
// app.get('/health', (req,res)=>res.json({ok:true}));

// ====================== Rutas privadas /api ============================
const api = express.Router();
api.use(authBearer); // ✅ toda /api requiere token (usa tu verificador real)
app.use('/facturacfdi', api);

// ====== Rate limit fuerte para descargas/reportes ======
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

/*****************************************************************/
/*****************************************************************/
/*****************************************************************/

// ===== Helpers mínimos =====
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
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    parseTagValue: false,      // ok: evita parsear a número/boolean
    parseAttributeValue: false,
    trimValues: true,
    removeNSPrefix: true,      // 👈 quita s:, a:, etc.
    emptyTagValue: ''          // 👈 <EstatusCancelacion/> => ''
  });

  const j = parser.parse(xml);

  // Si viene un Fault, lánzalo
  const fault = j?.Envelope?.Body?.Fault;
  if (fault) {
    const code = fault?.faultcode ?? '';
    const msg  = fault?.faultstring ?? 'SOAP Fault';
    throw new Error(`SAT SOAP Fault: ${code} - ${msg}`);
  }

  // Rutas sin prefijos por removeNSPrefix
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
// ===== Render PDF =====
function toCurrencyMXN(n) {
  return Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
}
function fmt(dt) {
  const d = (dt instanceof Date) ? dt : new Date(dt);
  if (isNaN(d)) return '';
  const p = (x)=>String(x).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function buildHTML({
  rfcEmisor, nombreEmisor, rfcReceptor, nombreReceptor,
  uuid, total, fechaExpedicion, fechaTimbrado, pacRfc,
  estadoCFDI, estatusCancelacion
}) {
  const he = require('he');
  const esc = (v) => he.encode(v == null ? '' : String(v), { useNamedReferences: true, allowUnsafeSymbols: true });

  const toCurrencyMXN = (n) =>
    Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

  const fmt = (dt) => {
    const d = (dt instanceof Date) ? dt : new Date(dt);
    if (isNaN(d)) return '';
    const p=(x)=>String(x).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  // Fecha/hora arriba a la izquierda (formato como en la imagen)
  const now = new Date();
  const p=(x)=>String(x).padStart(2,'0');
  const fechaImpresion = `${p(now.getDate())}/${p(now.getMonth()+1)}/${String(now.getFullYear()).slice(-2)}, ${p(now.getHours())}:${p(now.getMinutes())}`;
 // carpeta 'public' junto a app.js
    const publicDir = path.join(__dirname, 'public');
    const logoPath  = path.join(publicDir, 'Imagenes', 'logo_sat.jpg');


    if (!fs.existsSync(logoPath)) {
    console.error('No existe el logo en:', logoPath);
    // puedes abortar o usar un placeholder base64 aquí
    }

    const logoBase64   = fs.readFileSync(logoPath).toString('base64');
    const LOGO_SAT_SRC = `data:image/jpeg;base64,${logoBase64}`;
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
      padding: 0; /* pegado arriba */
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
        font-weight: 700; /* 700 = bold */
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
        <img class="logosat" src="${LOGO_SAT_SRC}" alt="Hacienda y SAT">
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

const uploadcfdi = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12 MB por XML
  fileFilter: (req, file, cb) => {
    if (!/\.xml$/i.test(file.originalname)) return cb(new Error('Solo se permiten .xml'), false);
    cb(null, true);
  }
});

// Parser CFDI robusto (no convierte valores, conserva atributos)
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true
});

// === Normalizador mínimo para CFDI 4.0 ===
// Devuelve { uuid, rfcEmisor, rfcReceptor, total, nombreEmisor?, nombreReceptor?, fechaExpedicion?, fechaTimbrado?, pacRfc? }
function extractRequiredFromXml(xmlText) {
  const j = parser.parse(xmlText);

  // Manejo de nombres con y sin prefijo
  const comprobante = j['cfdi:Comprobante'] || j['Comprobante'] || j.Comprobante || {};
  const emisor      = comprobante['cfdi:Emisor'] || comprobante.Emisor || {};
  const receptor    = comprobante['cfdi:Receptor'] || comprobante.Receptor || {};
  const compl      = comprobante['cfdi:Complemento'] || comprobante.Complemento || {};
  const tfd        = (compl && (compl['tfd:TimbreFiscalDigital'] || compl.TimbreFiscalDigital)) || {};

  // Atributos típicos (resguardamos variantes de mayúsculas)
  const uuid = tfd.UUID || tfd.Uuid || tfd.uuid || '';
  const rfcEmisor = emisor.Rfc || emisor.RFC || emisor.rfc || '';
  const rfcReceptor = receptor.Rfc || receptor.RFC || receptor.rfc || '';
  const total = comprobante.Total || comprobante.total || comprobante.SubTotal || comprobante.subTotal || '';

  const nombreEmisor = emisor.Nombre || emisor.nombre || '';
  const nombreReceptor = receptor.Nombre || receptor.nombre || '';
  const fechaExpedicion = comprobante.Fecha || comprobante.fecha || '';
  const fechaTimbrado = tfd.FechaTimbrado || tfd.Fecha || tfd.fecha || '';
  const pacRfc = tfd.RfcProvCertif || tfd.RFCProvCertif || '';

  return {
    uuid, rfcEmisor, rfcReceptor, total,
    nombreEmisor, nombreReceptor, fechaExpedicion, fechaTimbrado, pacRfc
  };
}

const pLimit = require('./utils/plimit');
// Límite de concurrencia para no saturar SAT ni Puppeteer
const limit = pLimit(3);

function noCompression(req, res, next) {
  res.set('x-no-compression', '1');
  next();
}

app.post('/facturacfdi/validar-cfdi',noCompression,uploadcfdi.array('xmls', 100),async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ ok: false, error: 'No se recibieron XML.' });
    }
    
    let browser = null;
    let archive = null;
    const manifest = [];

    // Helper: FINALIZAR ZIP SIEMPRE que ya mandaste headers
    async function safeFinalizeZip() {
      try {
        //archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), { name: 'manifest.json' });
      } catch (_) {}
      return new Promise((resolve) => {
        archive.once('close', resolve);
        try { archive.finalize(); } catch { resolve(); }
      });
    }

    // Helper: timeout duro por promesa
    function withTimeout(promise, ms, label) {
      let t;
      const timeout = new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(`Timeout ${ms}ms en ${label}`)), ms);
      });
      return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
    }

    // Helper: normaliza el PDF de Puppeteer a Buffer
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
      // === Rama 1 archivo -> PDF directo ===
      if (files.length === 1) {
        const f = files[0];
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

        const xmlText = f.buffer.toString('utf8');
        //console.log(xmlText)
        const reqData = extractRequiredFromXml(xmlText);
        if (!reqData.uuid || !reqData.rfcEmisor || !reqData.rfcReceptor || !reqData.total) {
          return res.status(422).json({ ok: false, error: 'XML sin uuid/rfcEmisor/rfcReceptor/total' });
        }

        const expresion = buildExpresionImpresa({
          uuid: reqData.uuid, rfcEmisor: reqData.rfcEmisor,
          rfcReceptor: reqData.rfcReceptor, total: reqData.total                 
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
        console.log(data)
        const sat = parseSoapResponse(data);
        console.log(sat)

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

        res.status(200);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        return res.end(pdfBuffer);
      }

      // === Rama ZIP (2+ archivos) ===
      // Cabeceras para evitar buffering/compresión en proxies (Nginx/Apache/CDN)
      res.status(200);
      res.setHeader('X-Accel-Buffering', 'no');       // Nginx
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="verificaciones_cfdi.zip"');
      res.setHeader('Content-Encoding', 'identity');  // evita gzip de reverse proxy
      res.setHeader('Connection', 'keep-alive');

      // Evita timeout de respuesta larga
      try { res.setTimeout(0); } catch {}

      archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('warning', (w) => console.warn('archiver warning:', w));
      archive.on('error',   (e) => { console.error('archiver error:', e); try { res.end(); } catch {} });
      archive.on('finish',  () => console.log('ZIP bytes escritos:', archive.pointer()));
      archive.on('close',   () => console.log('ZIP cerrado'));

      res.on('close', () => { try { archive.destroy(); } catch {} });
      res.on('error', (e) => { console.error('res error:', e); try { archive.destroy(); } catch {} });
      res.removeHeader('Content-Length');            // por si algún middleware lo fijó
      res.setHeader('Transfer-Encoding', 'chunked'); // asegura chunked

      archive.pipe(res);

      // FLUSH temprano de headers
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      // Primer chunk para que el navegador salga del 0%
      //archive.append(Buffer.from('Procesando archivos...\n', 'utf8'), { name: 'LEEME.txt' });

      // Lanza Puppeteer una sola vez
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

      // Limitador
      const pLimit = require('./utils/plimit');
      const limit = pLimit(3);

      const FILE_TIMEOUT_MS = 45_000;

      const tasks = files.map((f) =>
        limit(async () => {
          const entry = { filename: f.originalname };
          let pdfName = null;     // <-- definir antes para evitar ReferenceError
          let safeUuid = null;

          try {
            const xmlText = f.buffer.toString('utf8');
            const reqData = extractRequiredFromXml(xmlText);
            if (!reqData.uuid || !reqData.rfcEmisor || !reqData.rfcReceptor || !reqData.total) {
              entry.ok = false; entry.error = 'XML no contiene uuid/rfcEmisor/rfcReceptor/total';
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
              20000,
              `SAT ${reqData.uuid}`
            );
            //console.log(satResp)

            if (satResp.status >= 400) throw new Error(`HTTP ${satResp.status} del SAT`);
            const sat = parseSoapResponse(satResp.data);
            //console.log(sat.estatusCancelacion)
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
              20000,
              `PDF ${reqData.uuid}`
            );

            // Define nombres ANTES de usarlos
            safeUuid = String(reqData.uuid).toUpperCase().replace(/[^A-Z0-9\-]/g, '_');
            pdfName  = `verificacion_${safeUuid}.pdf`;

            // Escribe al ZIP
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
            entry.pdf = pdfName; // puede quedar null si falló antes de asignar
            entry.error = err.message || String(err);
            manifest.push(entry);
          }
        })
      );

      // No bloquees el finalize por tareas colgadas
      await Promise.allSettled(tasks);

      // Cierra Puppeteer ANTES de finalizar el ZIP
      try { await browser.close(); } catch {}
      browser = null;

      // FINALIZAR ZIP SIEMPRE
      await safeFinalizeZip();
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
);

// ====================== Error handler (AL FINAL) =======================
app.use(errorHandler);

// ====================== Arranque del servidor ==========================
server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
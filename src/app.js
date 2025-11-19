// src/app.js
const express = require('express');
const morgan  = require('morgan');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const { validate, authBearer, errorHandler, z } = require('./middlewares');
const apiRoutes = require('./routes/cfdi.routes');


const app = express();

// ===== Config =====
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://www.zayro.com')
  .split(',')
  .map(s => s.trim());

app.set('trust proxy', 1);
app.use(helmet());
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

app.use(morgan('dev'));

// JSON parser
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

// Static
app.use('/public',  express.static(path.join(__dirname, 'public')));
app.use('/archivos', express.static(path.join(__dirname, 'archivos_adjuntos')));

// Rate limit GLOBAL
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

// Request-Id
app.use((req, res, next) => {
  req.id = req.get('X-Request-Id') || uuidv4();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Normalización GLOBAL de strings
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

// VALIDACIÓN GLOBAL de query (tu GlobalQuerySchema)
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

// Hardening de body (tu código tal cual)
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

// ====================== Rutas /facturacfdi ======================
// authBearer se puede aplicar aquí
app.use('/facturacfdi', authBearer, apiRoutes);

// Error global
app.use(errorHandler);

module.exports = app;

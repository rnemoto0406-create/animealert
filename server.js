require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const { initDb } = require('./db');
const { authRouter, userRouter } = require('./auth');
const { sendNotifications } = require('./notifications');
const { scrapeGoodSmile } = require('./scrapers/goodsmile');
const { scrapeAmiAmi } = require('./scrapers/amiami');
const { mergeProducts } = require('./scrapers/merger');

const app = express();

app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// Body parser — 10kb hard cap to prevent oversized payloads
app.use(express.json({ limit: '10kb' }));

// CORS — whitelist from env, never wildcard in production
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// General rate limit — 100 req / 15 min per IP on all /api routes
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
}));

// In-memory product cache
let cachedProducts = [];
let lastScrape = null;

async function runScraper() {
  console.log('[scraper] starting...');
  try {
    const [gsc, ami] = await Promise.all([scrapeGoodSmile(), scrapeAmiAmi()]);
    cachedProducts = mergeProducts([...gsc, ...ami]);
    lastScrape = new Date().toISOString();
    console.log(`[scraper] done — ${cachedProducts.length} products`);
  } catch (err) {
    console.error('[scraper] error:', err.message);
  }
}

// Public routes
app.get('/api/status', (req, res) => res.json({ ok: true, lastScrape, productCount: cachedProducts.length }));

app.get('/api/products', (req, res) => {
  const { series, type, source, search } = req.query;
  let results = cachedProducts;

  if (typeof series === 'string' && series.length <= 100) {
    const q = series.toLowerCase();
    results = results.filter(p => p.series?.toLowerCase().includes(q));
  }
  if (typeof type === 'string' && type.length <= 100) {
    const q = type.toLowerCase();
    results = results.filter(p => p.category?.toLowerCase().includes(q));
  }
  if (typeof source === 'string' && ['GoodSmile', 'AmiAmi'].includes(source)) {
    results = results.filter(p => p.source === source || p.sources?.includes(source));
  }
  if (typeof search === 'string' && search.length <= 100) {
    const q = search.toLowerCase();
    results = results.filter(p => p.name.toLowerCase().includes(q));
  }

  res.json(results);
});

// Auth & user routes
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);

// Global error handler — never leak stack traces to client
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  const status = err.status || 500;
  res.status(status).json({ error: status < 500 ? err.message : 'Internal server error' });
});

// Scrape every 6 hours
cron.schedule('0 */6 * * *', runScraper);

// Send notifications daily at 00:00 UTC
cron.schedule('0 0 * * *', () => sendNotifications().catch(err => console.error('[notify]', err.message)));

async function start() {
  if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is not set');
    process.exit(1);
  }
  await initDb();
  await runScraper();
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));
}

start().catch(err => {
  console.error('[startup]', err);
  process.exit(1);
});

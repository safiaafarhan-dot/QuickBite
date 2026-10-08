'use strict';

const path = require('node:path');
const express = require('express');

/*
 * Configuration is validated before anything else is loaded. `auth.js` also
 * refuses a missing secret, but it does so at require time — which surfaces as
 * an unhandled throw and a stack trace. Checking here, first, lets an operator
 * read what is wrong instead of decoding a trace.
 */
if (require.main === module) {
  const missing = [];
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  }

  if (missing.length > 0) {
    console.error(`\n  ✗ Refusing to start: ${missing.join(', ')} must be set when NODE_ENV=production.`);
    console.error('\n    Generate a secret with:');
    console.error('      node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    console.error('\n    Then set it in the environment (or .env) and start again.\n');
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && !process.env.PAYMENT_WEBHOOK_SECRET) {
    console.warn('  ⚠ PAYMENT_WEBHOOK_SECRET is unset — the payment webhook will reject every call.\n');
  }
}

const { db, DB_FILE } = require('./db');
const { attachUser } = require('./auth');
const { securityHeaders, rateLimit, requestLogger } = require('./middleware');
const { router: cartRouter } = require('./routes/cart');
const { router: paymentsRouter } = require('./routes/payments');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 0);

app.use(securityHeaders);
app.use(
  express.json({
    limit: '100kb',
    // The payment webhook needs the exact bytes to verify its HMAC signature.
    verify: (req, _res, buf) => {
      if (req.originalUrl.startsWith('/api/payments/webhook')) req.rawBody = buf;
    },
  })
);
app.use(attachUser);
app.use(requestLogger);

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

// A broad ceiling that stops a runaway client without affecting normal browsing.
app.use('/api', rateLimit({
  windowMs: 60_000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 300,
  keyPrefix: 'api',
}));

app.get('/api/health', (_req, res) => {
  // Prove the database actually answers, not just that the process is up.
  try {
    const menu = db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE is_available = 1').get().n;
    const migrations = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    res.json({
      ok: true,
      status: 'healthy',
      database: path.basename(DB_FILE),
      migrations,
      menu_items: menu,
      uptime_seconds: Math.round(process.uptime()),
      version: require('../package.json').version,
    });
  } catch (err) {
    res.status(503).json({ ok: false, status: 'degraded', error: 'Database unavailable.' });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/cart', cartRouter);
app.use('/api/orders', require('./routes/orders'));
app.use('/api/addresses', require('./routes/addresses'));
app.use('/api/payments', paymentsRouter);
app.use('/api/ai', require('./routes/ai'));
app.use('/api/admin', require('./routes/admin'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

/* ------------------------------------------------------------------ */
/* Static site                                                         */
/* ------------------------------------------------------------------ */

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      // Hashed-by-content assets do not exist here, so photos get a long cache
      // and markup stays fresh.
      if (/[\\/]images[\\/]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

app.use((err, req, res, _next) => {
  // Log the detail; return something that leaks nothing.
  console.error(
    JSON.stringify({
      t: new Date().toISOString(),
      level: 'error',
      id: req.id,
      path: req.originalUrl?.split('?')[0],
      message: err.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : err.stack?.split('\n').slice(0, 4),
    })
  );

  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });

  res.status(500).json({
    error: 'Something went wrong on our side. Please try again.',
    request_id: req.id,
  });
});

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`\n  🍔 QuickBite running at http://localhost:${PORT}`);
    console.log(`  📦 Database: ${DB_FILE}`);
    console.log(`  🤖 AI assistant: ${process.env.ANTHROPIC_API_KEY ? 'LLM-backed' : 'built-in rules'}\n`);
  });

  /*
   * Without a listener here, a busy port raises an unhandled 'error' event and
   * the operator gets a stack trace rather than something they can act on.
   */
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ✗ Port ${PORT} is already in use.`);
      console.error('    Another QuickBite may still be running. Stop it, or start this one');
      console.error('    on a different port:   PORT=3001 npm start\n');
    } else if (err.code === 'EACCES') {
      console.error(`\n  ✗ Not allowed to bind port ${PORT}. Ports below 1024 need elevated`);
      console.error('    privileges — use a higher port and put a reverse proxy in front.\n');
    } else {
      console.error(`\n  ✗ Could not start the server: ${err.message}\n`);
    }
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received — closing server.`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;

'use strict';

const path = require('node:path');
const express = require('express');

const { DB_FILE } = require('./db');
const { attachUser } = require('./auth');
const { router: cartRouter } = require('./routes/cart');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(attachUser);

// --- API ---------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, db: path.basename(DB_FILE) }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/cart', cartRouter);
app.use('/api/orders', require('./routes/orders'));
app.use('/api/admin', require('./routes/admin'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

// --- Static site -------------------------------------------------------
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

// --- Errors ------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[quickbite]', err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  🍔 QuickBite running at http://localhost:${PORT}`);
    console.log(`  📦 Database: ${DB_FILE}\n`);
  });
}

module.exports = app;

'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const { priceCart } = require('../pricing');

const router = express.Router();

const listFavIds = db.prepare('SELECT item_id FROM favorites WHERE user_id = ?');
const addFav = db.prepare('INSERT OR IGNORE INTO favorites (user_id, item_id) VALUES (?, ?)');
const removeFav = db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?');
const findItem = db.prepare('SELECT * FROM menu_items WHERE id = ?');

function shape(row, favIds) {
  return { ...row, is_veg: !!row.is_veg, is_popular: !!row.is_popular, is_available: !!row.is_available, is_favorite: favIds.has(row.id) };
}

router.get('/', (req, res) => {
  const { q, category, diet, sort } = req.query;

  const where = ['is_available = 1'];
  const params = [];

  if (q) {
    where.push('(name LIKE ? OR description LIKE ? OR category LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  if (category && category !== 'all') {
    if (category === 'popular') where.push('is_popular = 1');
    else { where.push('category = ?'); params.push(String(category)); }
  }
  if (diet === 'veg') where.push('is_veg = 1');
  if (diet === 'nonveg') where.push('is_veg = 0');

  const ORDER = {
    'price-asc': 'price ASC',
    'price-desc': 'price DESC',
    rating: 'rating DESC',
    name: 'name ASC',
  };
  const orderBy = ORDER[String(sort)] || 'is_popular DESC, rating DESC, name ASC';

  const rows = db
    .prepare(`SELECT * FROM menu_items WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`)
    .all(...params);

  const favIds = new Set(req.user ? listFavIds.all(req.user.id).map((r) => r.item_id) : []);
  const categories = db
    .prepare('SELECT category, COUNT(*) AS count FROM menu_items WHERE is_available = 1 GROUP BY category ORDER BY category')
    .all();

  res.json({ items: rows.map((r) => shape(r, favIds)), categories });
});

router.get('/coupons', (_req, res) => {
  res.json({ coupons: db.prepare('SELECT code, description, min_subtotal FROM coupons WHERE is_active = 1').all() });
});

/**
 * Prices an arbitrary basket without touching anyone's stored cart, so a
 * signed-out visitor sees exactly the totals the server would charge.
 */
router.post('/quote', (req, res) => {
  const incoming = Array.isArray(req.body.items) ? req.body.items : [];
  const lines = [];

  for (const row of incoming) {
    const item = findItem.get(Number(row.item_id));
    const quantity = Math.trunc(Number(row.quantity));
    if (!item || !item.is_available || !Number.isInteger(quantity) || quantity < 1) continue;
    lines.push({ ...item, quantity: Math.min(quantity, 20) });
  }

  const totals = priceCart(lines, req.body.coupon);
  res.json({
    items: lines.map((l) => ({
      item_id: l.id, name: l.name, image: l.image, price: l.price,
      quantity: l.quantity, line_total: l.price * l.quantity,
    })),
    count: lines.reduce((n, l) => n + l.quantity, 0),
    ...totals,
  });
});

router.get('/:id', (req, res) => {
  const row = findItem.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Menu item not found.' });
  const favIds = new Set(req.user ? listFavIds.all(req.user.id).map((r) => r.item_id) : []);
  res.json({ item: shape(row, favIds) });
});

router.post('/:id/favorite', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!findItem.get(id)) return res.status(404).json({ error: 'Menu item not found.' });

  const isFav = listFavIds.all(req.user.id).some((r) => r.item_id === id);
  if (isFav) removeFav.run(req.user.id, id);
  else addFav.run(req.user.id, id);

  res.json({ item_id: id, is_favorite: !isFav });
});

module.exports = router;

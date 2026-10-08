'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { priceCart } = require('../pricing');
const { toPositiveInt, cleanText } = require('../middleware');
const { CATEGORY_LABELS, CATEGORY_ORDER } = require('../data/menu');

const router = express.Router();

const listFavIds = db.prepare('SELECT item_id FROM favorites WHERE user_id = ?');
const addFav = db.prepare('INSERT OR IGNORE INTO favorites (user_id, item_id) VALUES (?, ?)');
const removeFav = db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?');
const findItem = db.prepare('SELECT * FROM menu_items WHERE id = ?');
const findBySlug = db.prepare('SELECT * FROM menu_items WHERE slug = ?');

const reviewSummary = db.prepare(`
  SELECT COUNT(*) AS count, AVG(rating) AS average
  FROM reviews WHERE item_id = ?
`);
const listReviews = db.prepare(`
  SELECT r.rating, r.comment, r.created_at, u.name AS author
  FROM reviews r JOIN users u ON u.id = r.user_id
  WHERE r.item_id = ? ORDER BY r.id DESC LIMIT 20
`);

/** Shapes a database row into the public dish representation. */
function shape(row, favIds) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    price: row.price,
    image: row.image,
    category: row.category,
    category_label: CATEGORY_LABELS[row.category] || row.category,
    cuisine: row.cuisine,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    is_veg: Boolean(row.is_veg),
    is_popular: Boolean(row.is_popular),
    is_available: Boolean(row.is_available),
    in_stock: row.stock > 0,
    stock: row.stock,
    rating: Number(row.rating.toFixed(1)),
    prep_minutes: row.prep_minutes,
    spice_level: row.spice_level,
    calories: row.calories,
    is_favorite: favIds.has(row.id),
  };
}

const favIdsFor = (req) =>
  new Set(req.user ? listFavIds.all(req.user.id).map((r) => r.item_id) : []);

router.get('/', (req, res) => {
  const { q, category, diet, sort, max_price: maxPrice, cuisine, spice } = req.query;

  const where = ['is_available = 1'];
  const params = [];

  if (q) {
    const like = `%${cleanText(q, 60)}%`;
    where.push('(name LIKE ? OR description LIKE ? OR category LIKE ? OR tags LIKE ? OR cuisine LIKE ?)');
    params.push(like, like, like, like, like);
  }

  if (category && category !== 'all') {
    if (category === 'popular') where.push('is_popular = 1');
    else { where.push('category = ?'); params.push(cleanText(category, 30)); }
  }

  if (cuisine && cuisine !== 'all') {
    where.push('cuisine = ?');
    params.push(cleanText(cuisine, 30));
  }

  if (diet === 'veg') where.push('is_veg = 1');
  if (diet === 'nonveg') where.push('is_veg = 0');

  const budget = toPositiveInt(maxPrice);
  if (budget) { where.push('price <= ?'); params.push(budget); }

  const maxSpice = Math.trunc(Number(spice));
  if (Number.isInteger(maxSpice) && maxSpice >= 0 && maxSpice <= 3) {
    where.push('spice_level <= ?');
    params.push(maxSpice);
  }

  const ORDER = {
    'price-asc': 'price ASC, name ASC',
    'price-desc': 'price DESC, name ASC',
    rating: 'rating DESC, name ASC',
    name: 'name ASC',
    quickest: 'prep_minutes ASC, name ASC',
  };
  const orderBy = ORDER[String(sort)] || 'is_popular DESC, rating DESC, sort_order ASC';

  const rows = db
    .prepare(`SELECT * FROM menu_items WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`)
    .all(...params);

  const favIds = favIdsFor(req);

  const counts = db
    .prepare('SELECT category, COUNT(*) AS count FROM menu_items WHERE is_available = 1 GROUP BY category')
    .all();
  const byCategory = new Map(counts.map((c) => [c.category, c.count]));

  const categories = CATEGORY_ORDER
    .filter((name) => byCategory.has(name))
    .map((name) => ({ category: name, label: CATEGORY_LABELS[name], count: byCategory.get(name) }));

  const cuisines = db
    .prepare('SELECT DISTINCT cuisine FROM menu_items WHERE is_available = 1 ORDER BY cuisine')
    .all()
    .map((r) => r.cuisine);

  const range = db
    .prepare('SELECT MIN(price) AS min, MAX(price) AS max FROM menu_items WHERE is_available = 1')
    .get();

  res.json({
    items: rows.map((r) => shape(r, favIds)),
    categories,
    cuisines,
    price_range: range,
    total: rows.length,
  });
});

router.get('/coupons', (_req, res) => {
  const coupons = db
    .prepare(`
      SELECT code, description, min_subtotal, per_user_limit
      FROM coupons
      WHERE is_active = 1
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
        AND (usage_limit = 0 OR times_used < usage_limit)
      ORDER BY min_subtotal
    `)
    .all();
  res.json({ coupons });
});

/**
 * Prices an arbitrary basket without touching anyone's stored cart, so a
 * signed-out visitor sees exactly the totals the server would charge.
 */
router.post('/quote', (req, res) => {
  const incoming = Array.isArray(req.body.items) ? req.body.items.slice(0, 50) : [];
  const lines = [];

  for (const row of incoming) {
    const itemId = toPositiveInt(row.item_id);
    const quantity = toPositiveInt(row.quantity, { max: 20 });
    if (!itemId || !quantity) continue;

    const item = findItem.get(itemId);
    if (!item || !item.is_available) continue;

    lines.push({ ...item, quantity: Math.min(quantity, Math.max(item.stock, 0) || quantity) });
  }

  const totals = priceCart(lines, req.body.coupon, req.user?.id ?? null);

  res.json({
    items: lines.map((l) => ({
      item_id: l.id, slug: l.slug, name: l.name, image: l.image, price: l.price,
      quantity: l.quantity, line_total: l.price * l.quantity,
      stock: l.stock, in_stock: l.stock >= l.quantity, is_available: true,
    })),
    count: lines.reduce((n, l) => n + l.quantity, 0),
    ...totals,
  });
});

/** Dish detail, by numeric id or slug — the detail modal uses the slug. */
router.get('/:idOrSlug', (req, res) => {
  const key = req.params.idOrSlug;
  const row = /^\d+$/.test(key) ? findItem.get(Number(key)) : findBySlug.get(cleanText(key, 60));
  if (!row) return res.status(404).json({ error: 'Menu item not found.' });

  const summary = reviewSummary.get(row.id);

  res.json({
    item: shape(row, favIdsFor(req)),
    reviews: {
      count: summary.count,
      average: summary.average ? Number(summary.average.toFixed(1)) : null,
      items: listReviews.all(row.id),
    },
  });
});

router.post('/:id/favorite', requireAuth, (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id || !findItem.get(id)) return res.status(404).json({ error: 'Menu item not found.' });

  const isFav = listFavIds.all(req.user.id).some((r) => r.item_id === id);
  if (isFav) removeFav.run(req.user.id, id);
  else addFav.run(req.user.id, id);

  res.json({ item_id: id, is_favorite: !isFav });
});

/**
 * POST /api/menu/:id/reviews — rate a dish you have actually been delivered.
 * The dish's headline rating is recomputed from real reviews once any exist.
 */
router.post('/:id/reviews', requireAuth, (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id || !findItem.get(id)) return res.status(404).json({ error: 'Menu item not found.' });

  const rating = Math.trunc(Number(req.body.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Please give a rating between 1 and 5.' });
  }
  const comment = cleanText(req.body.comment, 400);

  const delivered = db
    .prepare(`
      SELECT o.id FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = ? AND oi.item_id = ? AND o.status = 'delivered'
      ORDER BY o.id DESC LIMIT 1
    `)
    .get(req.user.id, id);

  if (!delivered) {
    return res.status(403).json({ error: 'You can review a dish once it has been delivered to you.' });
  }

  transaction(() => {
    db.prepare(`
      INSERT INTO reviews (user_id, item_id, order_id, rating, comment)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET
        rating = excluded.rating, comment = excluded.comment, created_at = datetime('now')
    `).run(req.user.id, id, delivered.id, rating, comment);

    // Blend the seeded rating away as soon as real opinions arrive.
    const summary = reviewSummary.get(id);
    db.prepare('UPDATE menu_items SET rating = ? WHERE id = ?')
      .run(Number(summary.average.toFixed(2)), id);
  })();

  const summary = reviewSummary.get(id);
  res.status(201).json({
    review: { rating, comment },
    summary: { count: summary.count, average: Number(summary.average.toFixed(1)) },
  });
});

module.exports = router;

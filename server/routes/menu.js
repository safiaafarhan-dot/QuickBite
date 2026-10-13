'use strict';

const express = require('express');
const { sql, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { priceCart } = require('../pricing');
const { toPositiveInt, cleanText, route } = require('../middleware');
const { CATEGORY_LABELS, CATEGORY_ORDER } = require('../data/menu');

const router = express.Router();

const LIST_FAV_IDS = 'SELECT item_id FROM favorites WHERE user_id = $1';
// SQLite's INSERT OR IGNORE; the favorites primary key is what it conflicts on.
const ADD_FAV = 'INSERT INTO favorites (user_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING';
const REMOVE_FAV = 'DELETE FROM favorites WHERE user_id = $1 AND item_id = $2';
const FIND_ITEM = 'SELECT * FROM menu_items WHERE id = $1';
const FIND_BY_SLUG = 'SELECT * FROM menu_items WHERE slug = $1';

/*
 * `AVG` returns numeric, which node-postgres hands back as a string because
 * numeric is arbitrary precision. The cast to float8 keeps `average` a number,
 * which is what `.toFixed()` below needs.
 */
const REVIEW_SUMMARY = `
  SELECT COUNT(*) AS count, AVG(rating)::float8 AS average
  FROM reviews WHERE item_id = $1
`;
const LIST_REVIEWS = `
  SELECT r.rating, r.comment, r.created_at, u.name AS author
  FROM reviews r JOIN users u ON u.id = r.user_id
  WHERE r.item_id = $1 ORDER BY r.id DESC LIMIT 20
`;

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

async function favIdsFor(req) {
  if (!req.user) return new Set();
  const rows = await sql.all(LIST_FAV_IDS, [req.user.id]);
  return new Set(rows.map((r) => r.item_id));
}

router.get('/', route(async (req, res) => {
  const { q, category, diet, sort, max_price: maxPrice, cuisine, spice } = req.query;

  /*
   * The filters are composed, so the placeholders have to be numbered as they
   * are added rather than written out — `$1`, `$2`, … in the order the values
   * go into `params`. `add()` keeps the number and the value in step; getting
   * that pairing wrong is the classic way a hand-converted query starts
   * filtering by the wrong column.
   */
  const where = ['is_available = 1'];
  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };

  if (q) {
    const like = `%${cleanText(q, 60)}%`;
    /*
     * ILIKE, not LIKE. SQLite's LIKE is case-insensitive for ASCII, so the
     * menu search has always matched "biryani" against "Chicken Biryani".
     * PostgreSQL's LIKE is case-sensitive, and plain LIKE here would have
     * quietly broken every search that did not match the stored casing.
     */
    const p = add(like);
    where.push(
      `(name ILIKE ${p} OR description ILIKE ${p} OR category ILIKE ${p} ` +
      `OR tags ILIKE ${p} OR cuisine ILIKE ${p})`
    );
  }

  if (category && category !== 'all') {
    if (category === 'popular') where.push('is_popular = 1');
    else where.push(`category = ${add(cleanText(category, 30))}`);
  }

  if (cuisine && cuisine !== 'all') {
    where.push(`cuisine = ${add(cleanText(cuisine, 30))}`);
  }

  if (diet === 'veg') where.push('is_veg = 1');
  if (diet === 'nonveg') where.push('is_veg = 0');

  const budget = toPositiveInt(maxPrice);
  if (budget) where.push(`price <= ${add(budget)}`);

  const maxSpice = Math.trunc(Number(spice));
  if (Number.isInteger(maxSpice) && maxSpice >= 0 && maxSpice <= 3) {
    where.push(`spice_level <= ${add(maxSpice)}`);
  }

  const ORDER = {
    'price-asc': 'price ASC, name ASC',
    'price-desc': 'price DESC, name ASC',
    rating: 'rating DESC, name ASC',
    name: 'name ASC',
    quickest: 'prep_minutes ASC, name ASC',
  };
  const orderBy = ORDER[String(sort)] || 'is_popular DESC, rating DESC, sort_order ASC';

  const [rows, favIds, counts, cuisineRows, range] = await Promise.all([
    sql.all(`SELECT * FROM menu_items WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`, params),
    favIdsFor(req),
    sql.all('SELECT category, COUNT(*) AS count FROM menu_items WHERE is_available = 1 GROUP BY category'),
    sql.all('SELECT DISTINCT cuisine FROM menu_items WHERE is_available = 1 ORDER BY cuisine'),
    sql.get('SELECT MIN(price) AS min, MAX(price) AS max FROM menu_items WHERE is_available = 1'),
  ]);

  const byCategory = new Map(counts.map((c) => [c.category, c.count]));

  const categories = CATEGORY_ORDER
    .filter((name) => byCategory.has(name))
    .map((name) => ({ category: name, label: CATEGORY_LABELS[name], count: byCategory.get(name) }));

  const cuisines = cuisineRows.map((r) => r.cuisine);

  res.json({
    items: rows.map((r) => shape(r, favIds)),
    categories,
    cuisines,
    price_range: range,
    total: rows.length,
  });
}));

/**
 * GET /api/menu/reviews/recent — the latest reviews across the whole menu.
 *
 * Added for the reviews section on the home page, which needs opinions
 * from several dishes at once. Every field here was already public: the
 * dish detail endpoint below returns exactly the same columns, author
 * name included, for one dish at a time. The alternative was thirty
 * requests to build one carousel.
 *
 * Read-only, unauthenticated, and capped. Reviews can only be written by
 * someone who was actually delivered the dish, so there is nothing here
 * that was not earned by a real order.
 */
router.get('/reviews/recent', route(async (req, res) => {
  const limit = Math.min(Math.max(toPositiveInt(req.query.limit) || 12, 1), 24);

  const reviews = await sql.all(`
      SELECT r.rating, r.comment, r.created_at,
             u.name  AS author,
             m.name  AS item_name,
             m.slug  AS item_slug,
             m.image AS item_image
      FROM reviews r
      JOIN users u ON u.id = r.user_id
      JOIN menu_items m ON m.id = r.item_id
      WHERE r.comment <> '' AND m.is_available = 1
      ORDER BY r.id DESC
      LIMIT $1
    `, [limit]);

  res.json({ reviews });
}));

router.get('/coupons', route(async (_req, res) => {
  const coupons = await sql.all(`
    SELECT code, description, min_subtotal, per_user_limit
    FROM coupons
    WHERE is_active = 1
      AND (expires_at IS NULL OR expires_at > now())
      AND (usage_limit = 0 OR times_used < usage_limit)
    ORDER BY min_subtotal
  `);
  res.json({ coupons });
}));

/**
 * Prices an arbitrary basket without touching anyone's stored cart, so a
 * signed-out visitor sees exactly the totals the server would charge.
 */
router.post('/quote', route(async (req, res) => {
  const incoming = Array.isArray(req.body.items) ? req.body.items.slice(0, 50) : [];
  const lines = [];

  for (const row of incoming) {
    const itemId = toPositiveInt(row.item_id);
    const quantity = toPositiveInt(row.quantity, { max: 20 });
    if (!itemId || !quantity) continue;

    const item = await sql.get(FIND_ITEM, [itemId]);
    if (!item || !item.is_available) continue;

    lines.push({ ...item, quantity: Math.min(quantity, Math.max(item.stock, 0) || quantity) });
  }

  const totals = await priceCart(lines, req.body.coupon, req.user?.id ?? null);

  res.json({
    items: lines.map((l) => ({
      item_id: l.id, slug: l.slug, name: l.name, image: l.image, price: l.price,
      quantity: l.quantity, line_total: l.price * l.quantity,
      stock: l.stock, in_stock: l.stock >= l.quantity, is_available: true,
    })),
    count: lines.reduce((n, l) => n + l.quantity, 0),
    ...totals,
  });
}));

/** Dish detail, by numeric id or slug — the detail modal uses the slug. */
router.get('/:idOrSlug', route(async (req, res) => {
  const key = req.params.idOrSlug;
  const row = /^\d+$/.test(key)
    ? await sql.get(FIND_ITEM, [Number(key)])
    : await sql.get(FIND_BY_SLUG, [cleanText(key, 60)]);
  if (!row) return res.status(404).json({ error: 'Menu item not found.' });

  const [summary, favIds, items] = await Promise.all([
    sql.get(REVIEW_SUMMARY, [row.id]),
    favIdsFor(req),
    sql.all(LIST_REVIEWS, [row.id]),
  ]);

  res.json({
    item: shape(row, favIds),
    reviews: {
      count: summary.count,
      average: summary.average ? Number(summary.average.toFixed(1)) : null,
      items,
    },
  });
}));

router.post('/:id/favorite', requireAuth, route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id || !(await sql.get(FIND_ITEM, [id]))) {
    return res.status(404).json({ error: 'Menu item not found.' });
  }

  const favIds = await favIdsFor(req);
  const isFav = favIds.has(id);
  if (isFav) await sql.run(REMOVE_FAV, [req.user.id, id]);
  else await sql.run(ADD_FAV, [req.user.id, id]);

  res.json({ item_id: id, is_favorite: !isFav });
}));

/**
 * POST /api/menu/:id/reviews — rate a dish you have actually been delivered.
 * The dish's headline rating is recomputed from real reviews once any exist.
 */
router.post('/:id/reviews', requireAuth, route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id || !(await sql.get(FIND_ITEM, [id]))) {
    return res.status(404).json({ error: 'Menu item not found.' });
  }

  const rating = Math.trunc(Number(req.body.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Please give a rating between 1 and 5.' });
  }
  const comment = cleanText(req.body.comment, 400);

  const delivered = await sql.get(`
    SELECT o.id FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.user_id = $1 AND oi.item_id = $2 AND o.status = 'delivered'
    ORDER BY o.id DESC LIMIT 1
  `, [req.user.id, id]);

  if (!delivered) {
    return res.status(403).json({ error: 'You can review a dish once it has been delivered to you.' });
  }

  const summary = await transaction(async (tx) => {
    await tx.run(`
      INSERT INTO reviews (user_id, item_id, order_id, rating, comment)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, item_id) DO UPDATE SET
        rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = now()
    `, [req.user.id, id, delivered.id, rating, comment]);

    // Blend the seeded rating away as soon as real opinions arrive.
    const fresh = await tx.get(REVIEW_SUMMARY, [id]);
    await tx.run('UPDATE menu_items SET rating = $1 WHERE id = $2', [
      Number(fresh.average.toFixed(2)), id,
    ]);
    return fresh;
  });

  res.status(201).json({
    review: { rating, comment },
    summary: { count: summary.count, average: Number(summary.average.toFixed(1)) },
  });
}));

module.exports = router;

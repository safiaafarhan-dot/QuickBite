'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireAdmin } = require('../auth');
const { ALL_STATUSES, LABELS, canTransition, advanceOrders } = require('../orderState');
const { toPositiveInt, cleanText } = require('../middleware');

const router = express.Router();
router.use(requireAdmin);

const selectItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');
const insertEvent = db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)');
const findOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
const setStatus = db.prepare(
  "UPDATE orders SET status = ?, auto_advance = 0, updated_at = datetime('now') WHERE id = ?"
);
const restoreStock = db.prepare('UPDATE menu_items SET stock = stock + ? WHERE id = ?');

router.get('/orders', (req, res) => {
  advanceOrders();

  const status = cleanText(req.query.status || 'all', 30);
  const limit = Math.min(toPositiveInt(req.query.limit) || 50, 200);

  let where = '';
  const params = [];

  if (status === 'live') {
    where = "WHERE o.status NOT IN ('delivered', 'cancelled')";
  } else if (status !== 'all') {
    if (!ALL_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Unknown status filter.' });
    }
    where = 'WHERE o.status = ?';
    params.push(status);
  }

  const orders = db
    .prepare(`
      SELECT o.*, u.email AS user_email
      FROM orders o JOIN users u ON u.id = o.user_id
      ${where}
      ORDER BY o.id DESC LIMIT ?
    `)
    .all(...params, limit);

  res.json({
    orders: orders.map((o) => ({
      ...o,
      status_label: LABELS[o.status] || o.status,
      items: selectItems.all(o.id),
    })),
    statuses: ALL_STATUSES,
  });
});

router.get('/stats', (_req, res) => {
  advanceOrders();

  const stats = db.prepare(`
    SELECT
      COUNT(*)                                                         AS orders,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total END), 0) AS revenue,
      COALESCE(SUM(status NOT IN ('delivered', 'cancelled')), 0)       AS live,
      COALESCE(SUM(status = 'delivered'), 0)                           AS delivered,
      COALESCE(SUM(status = 'cancelled'), 0)                           AS cancelled,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN discount END), 0) AS discounts_given
    FROM orders
  `).get();

  const top = db.prepare(`
    SELECT oi.name, oi.item_id, SUM(oi.quantity) AS units, SUM(oi.quantity * oi.price) AS revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status != 'cancelled'
    GROUP BY oi.name, oi.item_id ORDER BY units DESC LIMIT 8
  `).all();

  const lowStock = db.prepare(`
    SELECT id, name, stock FROM menu_items
    WHERE is_available = 1 AND stock <= 10 ORDER BY stock ASC LIMIT 10
  `).all();

  const customers = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n;
  const avgOrder = stats.orders > 0 && stats.revenue > 0
    ? Math.round(stats.revenue / Math.max(stats.orders - stats.cancelled, 1))
    : 0;

  res.json({
    stats: { ...stats, customers, average_order: avgOrder },
    top_items: top,
    low_stock: lowStock,
  });
});

/** Moves an order along the lifecycle. Invalid jumps are refused, not silently applied. */
router.patch('/orders/:id', (req, res) => {
  const id = toPositiveInt(req.params.id);
  const status = cleanText(req.body.status, 30);
  const order = id ? findOrder.get(id) : null;
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const check = canTransition(order.status, status);
  if (!check.ok) return res.status(409).json({ error: check.reason, from: order.status, to: status });

  transaction(() => {
    setStatus.run(status, id);
    insertEvent.run(id, status, 'Updated by restaurant');

    // Cancelling from the kitchen returns the reserved portions to stock.
    if (status === 'cancelled') {
      for (const line of selectItems.all(id)) {
        if (line.item_id) restoreStock.run(line.quantity, line.item_id);
      }
    }
  })();

  res.json({ order: findOrder.get(id) });
});

router.get('/menu', (_req, res) => {
  res.json({
    items: db.prepare('SELECT * FROM menu_items ORDER BY sort_order, name').all(),
  });
});

router.patch('/menu/:id', (req, res) => {
  const id = toPositiveInt(req.params.id);
  const item = id ? db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) : null;
  if (!item) return res.status(404).json({ error: 'Menu item not found.' });

  const price = req.body.price === undefined ? item.price : Math.trunc(Number(req.body.price));
  if (!Number.isInteger(price) || price < 0 || price > 100000) {
    return res.status(400).json({ error: 'Price must be a whole number of rupees under ₹100,000.' });
  }

  const stock = req.body.stock === undefined ? item.stock : Math.trunc(Number(req.body.stock));
  if (!Number.isInteger(stock) || stock < 0 || stock > 10000) {
    return res.status(400).json({ error: 'Stock must be between 0 and 10,000.' });
  }

  const available = req.body.is_available === undefined
    ? item.is_available
    : (req.body.is_available ? 1 : 0);

  db.prepare('UPDATE menu_items SET price = ?, stock = ?, is_available = ? WHERE id = ?')
    .run(price, stock, available, id);

  res.json({ item: db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) });
});

/** Coupon administration: create, adjust limits, or switch one off. */
router.get('/coupons', (_req, res) => {
  res.json({ coupons: db.prepare('SELECT * FROM coupons ORDER BY code').all() });
});

router.patch('/coupons/:code', (req, res) => {
  const code = cleanText(req.params.code, 30).toUpperCase();
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
  if (!coupon) return res.status(404).json({ error: 'Coupon not found.' });

  const isActive = req.body.is_active === undefined ? coupon.is_active : (req.body.is_active ? 1 : 0);
  const usageLimit = req.body.usage_limit === undefined
    ? coupon.usage_limit
    : Math.max(Math.trunc(Number(req.body.usage_limit)) || 0, 0);

  db.prepare('UPDATE coupons SET is_active = ?, usage_limit = ? WHERE code = ?')
    .run(isActive, usageLimit, code);

  res.json({ coupon: db.prepare('SELECT * FROM coupons WHERE code = ?').get(code) });
});

module.exports = router;

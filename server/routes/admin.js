'use strict';

const express = require('express');
const { sql, transaction } = require('../db');
const { requireAdmin } = require('../auth');
const { ALL_STATUSES, LABELS, canTransition, advanceOrders } = require('../orderState');
const { toPositiveInt, cleanText, route } = require('../middleware');

const router = express.Router();
router.use(requireAdmin);

const SELECT_ITEMS = 'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id';
const INSERT_EVENT = 'INSERT INTO order_events (order_id, status, note) VALUES ($1, $2, $3)';
const FIND_ORDER = 'SELECT * FROM orders WHERE id = $1';
const SET_STATUS = 'UPDATE orders SET status = $1, auto_advance = 0, updated_at = now() WHERE id = $2';
const RESTORE_STOCK = 'UPDATE menu_items SET stock = stock + $1 WHERE id = $2';
const FIND_MENU_ITEM = 'SELECT * FROM menu_items WHERE id = $1';
const FIND_COUPON = 'SELECT * FROM coupons WHERE code = $1';

router.get('/orders', route(async (req, res) => {
  await advanceOrders();

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
    where = 'WHERE o.status = $1';
    params.push(status);
  }

  // The limit is always the last placeholder, whether or not the status filter
  // added one before it.
  const orders = await sql.all(`
    SELECT o.*, u.email AS user_email
    FROM orders o JOIN users u ON u.id = o.user_id
    ${where}
    ORDER BY o.id DESC LIMIT $${params.length + 1}
  `, [...params, limit]);

  res.json({
    orders: await Promise.all(orders.map(async (o) => ({
      ...o,
      status_label: LABELS[o.status] || o.status,
      items: await sql.all(SELECT_ITEMS, [o.id]),
    }))),
    statuses: ALL_STATUSES,
  });
}));

router.get('/stats', route(async (_req, res) => {
  await advanceOrders();

  /*
   * `COUNT(*) FILTER (WHERE ...)` replaces SQLite's `SUM(status = 'x')`.
   * SQLite scores a comparison as 1 or 0 and happily sums it; in PostgreSQL a
   * comparison is a boolean and `SUM(boolean)` is a type error. This is one of
   * the few places where the SQL had to change shape rather than spelling.
   */
  const stats = await sql.get(`
    SELECT
      COUNT(*)                                                            AS orders,
      COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total END), 0)    AS revenue,
      COUNT(*) FILTER (WHERE status NOT IN ('delivered', 'cancelled'))    AS live,
      COUNT(*) FILTER (WHERE status = 'delivered')                        AS delivered,
      COUNT(*) FILTER (WHERE status = 'cancelled')                        AS cancelled,
      COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN discount END), 0) AS discounts_given
    FROM orders
  `);

  const [top, lowStock, customerRow] = await Promise.all([
    sql.all(`
      SELECT oi.name, oi.item_id, SUM(oi.quantity) AS units, SUM(oi.quantity * oi.price) AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status <> 'cancelled'
      GROUP BY oi.name, oi.item_id ORDER BY units DESC LIMIT 8
    `),
    sql.all(`
      SELECT id, name, stock FROM menu_items
      WHERE is_available = 1 AND stock <= 10 ORDER BY stock ASC LIMIT 10
    `),
    sql.get("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'"),
  ]);

  const customers = customerRow.n;
  const avgOrder = stats.orders > 0 && stats.revenue > 0
    ? Math.round(stats.revenue / Math.max(stats.orders - stats.cancelled, 1))
    : 0;

  res.json({
    stats: { ...stats, customers, average_order: avgOrder },
    top_items: top,
    low_stock: lowStock,
  });
}));

/** Moves an order along the lifecycle. Invalid jumps are refused, not silently applied. */
router.patch('/orders/:id', route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  const status = cleanText(req.body.status, 30);
  const order = id ? await sql.get(FIND_ORDER, [id]) : null;
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const check = canTransition(order.status, status);
  if (!check.ok) return res.status(409).json({ error: check.reason, from: order.status, to: status });

  await transaction(async (tx) => {
    await tx.run(SET_STATUS, [status, id]);
    await tx.run(INSERT_EVENT, [id, status, 'Updated by restaurant']);

    // Cancelling from the kitchen returns the reserved portions to stock.
    if (status === 'cancelled') {
      for (const line of await tx.all(SELECT_ITEMS, [id])) {
        if (line.item_id) await tx.run(RESTORE_STOCK, [line.quantity, line.item_id]);
      }
    }
  });

  res.json({ order: await sql.get(FIND_ORDER, [id]) });
}));

router.get('/menu', route(async (_req, res) => {
  res.json({
    items: await sql.all('SELECT * FROM menu_items ORDER BY sort_order, name'),
  });
}));

router.patch('/menu/:id', route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  const item = id ? await sql.get(FIND_MENU_ITEM, [id]) : null;
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

  await sql.run('UPDATE menu_items SET price = $1, stock = $2, is_available = $3 WHERE id = $4', [
    price, stock, available, id,
  ]);

  res.json({ item: await sql.get(FIND_MENU_ITEM, [id]) });
}));

/** Coupon administration: create, adjust limits, or switch one off. */
router.get('/coupons', route(async (_req, res) => {
  res.json({ coupons: await sql.all('SELECT * FROM coupons ORDER BY code') });
}));

router.patch('/coupons/:code', route(async (req, res) => {
  const code = cleanText(req.params.code, 30).toUpperCase();
  const coupon = await sql.get(FIND_COUPON, [code]);
  if (!coupon) return res.status(404).json({ error: 'Coupon not found.' });

  const isActive = req.body.is_active === undefined ? coupon.is_active : (req.body.is_active ? 1 : 0);
  const usageLimit = req.body.usage_limit === undefined
    ? coupon.usage_limit
    : Math.max(Math.trunc(Number(req.body.usage_limit)) || 0, 0);

  await sql.run('UPDATE coupons SET is_active = $1, usage_limit = $2 WHERE code = $3', [
    isActive, usageLimit, code,
  ]);

  res.json({ coupon: await sql.get(FIND_COUPON, [code]) });
}));

module.exports = router;

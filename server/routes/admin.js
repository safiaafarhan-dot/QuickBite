'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireAdmin } = require('../auth');
const { FLOW, LABELS, advanceOrders } = require('../orderState');

const router = express.Router();
router.use(requireAdmin);

const selectItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');
const insertEvent = db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)');
const findOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
const setStatus = db.prepare(
  "UPDATE orders SET status = ?, auto_advance = 0, updated_at = datetime('now') WHERE id = ?"
);

router.get('/orders', (req, res) => {
  advanceOrders();

  const status = String(req.query.status || 'all');
  const where = status === 'all' ? '' : status === 'live'
    ? "WHERE o.status NOT IN ('delivered', 'cancelled')"
    : 'WHERE o.status = ?';
  const params = status === 'all' || status === 'live' ? [] : [status];

  const orders = db.prepare(`
    SELECT o.*, u.email AS user_email
    FROM orders o JOIN users u ON u.id = o.user_id
    ${where}
    ORDER BY o.id DESC LIMIT 100
  `).all(...params);

  res.json({
    orders: orders.map((o) => ({
      ...o,
      status_label: LABELS[o.status] || o.status,
      items: selectItems.all(o.id),
    })),
    statuses: [...FLOW, 'cancelled'],
  });
});

router.get('/stats', (_req, res) => {
  advanceOrders();
  const stats = db.prepare(`
    SELECT
      COUNT(*)                                                    AS orders,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total END), 0) AS revenue,
      COALESCE(SUM(status NOT IN ('delivered', 'cancelled')), 0)  AS live,
      COALESCE(SUM(status = 'delivered'), 0)                      AS delivered,
      COALESCE(SUM(status = 'cancelled'), 0)                      AS cancelled
    FROM orders
  `).get();

  const top = db.prepare(`
    SELECT oi.name, SUM(oi.quantity) AS units, SUM(oi.quantity * oi.price) AS revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status != 'cancelled'
    GROUP BY oi.name ORDER BY units DESC LIMIT 5
  `).all();

  res.json({
    stats: { ...stats, customers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n },
    top_items: top,
  });
});

router.patch('/orders/:id', (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '');
  if (![...FLOW, 'cancelled'].includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  if (!findOrder.get(id)) return res.status(404).json({ error: 'Order not found.' });

  transaction(() => {
    setStatus.run(status, id);
    insertEvent.run(id, status, 'Updated by restaurant');
  })();

  res.json({ order: findOrder.get(id) });
});

router.patch('/menu/:id', (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Menu item not found.' });

  const price = req.body.price === undefined ? item.price : Math.trunc(Number(req.body.price));
  if (!Number.isInteger(price) || price < 0) return res.status(400).json({ error: 'Price must be a whole number of rupees.' });
  const available = req.body.is_available === undefined ? item.is_available : (req.body.is_available ? 1 : 0);

  db.prepare('UPDATE menu_items SET price = ?, is_available = ? WHERE id = ?').run(price, available, id);
  res.json({ item: db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) });
});

module.exports = router;

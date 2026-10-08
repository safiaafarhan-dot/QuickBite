'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { db, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { priceCart, estimateEta } = require('../pricing');
const { LABELS, advanceOrders, minutesSince } = require('../orderState');
const { selectLines, clearCart } = require('./cart');

const router = express.Router();
router.use(requireAuth);

const insertOrder = db.prepare(`
  INSERT INTO orders (code, user_id, status, subtotal, discount, delivery_fee, tax, total,
                      coupon_code, customer_name, phone, address, notes, payment_method, eta_minutes)
  VALUES (?, ?, 'placed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertOrderItem = db.prepare(
  'INSERT INTO order_items (order_id, item_id, name, image, price, quantity) VALUES (?, ?, ?, ?, ?, ?)'
);
const insertEvent = db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)');
const selectOrders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ?');
const selectOrder = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?');
const selectItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');
const selectEvents = db.prepare('SELECT status, note, at FROM order_events WHERE order_id = ? ORDER BY id');
const cancelOrder = db.prepare(
  "UPDATE orders SET status = 'cancelled', auto_advance = 0, updated_at = datetime('now') WHERE id = ?"
);
const updateProfileDefaults = db.prepare('UPDATE users SET phone = ?, address = ? WHERE id = ?');

const newCode = () => `QB-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

function serialize(order) {
  const elapsed = minutesSince(order.placed_at);
  const remaining = Math.max(Math.ceil(order.eta_minutes - elapsed), 0);
  return {
    ...order,
    status_label: LABELS[order.status] || order.status,
    minutes_remaining: order.status === 'delivered' || order.status === 'cancelled' ? 0 : remaining,
    items: selectItems.all(order.id),
    events: selectEvents.all(order.id).map((e) => ({ ...e, label: LABELS[e.status] || e.status })),
  };
}

/** POST /api/orders — checkout. Totals are recomputed here; the client's numbers are never trusted. */
router.post('/', (req, res) => {
  const lines = selectLines.all(req.user.id);
  if (lines.length === 0) return res.status(400).json({ error: 'Your cart is empty.' });

  const unavailable = lines.filter((l) => !l.is_available);
  if (unavailable.length > 0) {
    return res.status(409).json({
      error: `${unavailable.map((l) => l.name).join(', ')} is no longer available. Please update your cart.`,
    });
  }

  const name = String(req.body.name || req.user.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const address = String(req.body.address || '').trim();
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  const paymentMethod = ['cod', 'card', 'upi'].includes(req.body.payment_method)
    ? req.body.payment_method
    : 'cod';

  if (name.length < 2) return res.status(400).json({ error: 'Please enter a name for the order.' });
  if (!/^[0-9+\-\s()]{8,20}$/.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (address.length < 10) return res.status(400).json({ error: 'Please enter a full delivery address.' });

  const totals = priceCart(lines, req.body.coupon);
  if (totals.coupon_error) return res.status(400).json({ error: totals.coupon_error });

  const eta = estimateEta(lines);

  const place = transaction(() => {
    const { lastInsertRowid } = insertOrder.run(
      newCode(), req.user.id,
      totals.subtotal, totals.discount, totals.delivery_fee, totals.tax, totals.total,
      totals.coupon ? totals.coupon.code : null,
      name, phone, address, notes, paymentMethod, eta
    );
    const orderId = Number(lastInsertRowid);
    for (const l of lines) insertOrderItem.run(orderId, l.item_id, l.name, l.image, l.price, l.quantity);
    insertEvent.run(orderId, 'placed', `Payment: ${paymentMethod.toUpperCase()}`);
    clearCart.run(req.user.id);
    updateProfileDefaults.run(phone, address, req.user.id);
    return orderId;
  });

  const orderId = place();
  res.status(201).json({ order: serialize(selectOrder.get(orderId, req.user.id)) });
});

router.get('/', (req, res) => {
  advanceOrders();
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  res.json({ orders: selectOrders.all(req.user.id, limit).map(serialize) });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  advanceOrders(id);
  const order = selectOrder.get(id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order: serialize(order) });
});

/** Customers may cancel only before the kitchen starts cooking. */
router.post('/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  advanceOrders(id);
  const order = selectOrder.get(id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status === 'cancelled') return res.status(409).json({ error: 'This order is already cancelled.' });
  if (!['placed', 'confirmed'].includes(order.status)) {
    return res.status(409).json({ error: 'This order is already being prepared and can no longer be cancelled.' });
  }

  transaction(() => {
    cancelOrder.run(id);
    insertEvent.run(id, 'cancelled', 'Cancelled by customer');
  })();

  res.json({ order: serialize(selectOrder.get(id, req.user.id)) });
});

/** Puts a past order's items straight back into the cart. */
router.post('/:id/reorder', (req, res) => {
  const order = selectOrder.get(Number(req.params.id), req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const available = db.prepare('SELECT id FROM menu_items WHERE id = ? AND is_available = 1');
  const upsert = db.prepare(`
    INSERT INTO cart_items (user_id, item_id, quantity) VALUES (?, ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = min(quantity + excluded.quantity, 20)
  `);

  const skipped = [];
  transaction(() => {
    for (const line of selectItems.all(order.id)) {
      if (line.item_id && available.get(line.item_id)) upsert.run(req.user.id, line.item_id, line.quantity);
      else skipped.push(line.name);
    }
  })();

  res.json({ skipped });
});

module.exports = router;

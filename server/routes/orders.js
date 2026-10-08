'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { db, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { priceCart, estimateEta } = require('../pricing');
const { LABELS, advanceOrders, minutesSince, canCustomerCancel } = require('../orderState');
const { selectLines, clearCart } = require('./cart');
const { cleanText, toPositiveInt, PHONE_RE, rateLimit } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const insertOrder = db.prepare(`
  INSERT INTO orders (code, user_id, status, subtotal, discount, delivery_fee, tax, total,
                      coupon_code, customer_name, phone, address, notes, payment_method,
                      payment_status, eta_minutes)
  VALUES (?, ?, 'placed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertOrderItem = db.prepare(
  'INSERT INTO order_items (order_id, item_id, name, image, price, quantity) VALUES (?, ?, ?, ?, ?, ?)'
);
const insertEvent = db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)');
const selectOrders = db.prepare(
  'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
);
const countOrders = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?');
const selectOrder = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?');
const selectItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');
const selectEvents = db.prepare('SELECT status, note, at FROM order_events WHERE order_id = ? ORDER BY id');
const cancelOrder = db.prepare(
  "UPDATE orders SET status = 'cancelled', auto_advance = 0, updated_at = datetime('now') WHERE id = ?"
);
const updateProfileDefaults = db.prepare('UPDATE users SET phone = ?, address = ? WHERE id = ?');

const decrementStock = db.prepare(
  'UPDATE menu_items SET stock = stock - ? WHERE id = ? AND stock >= ?'
);
const restoreStock = db.prepare('UPDATE menu_items SET stock = stock + ? WHERE id = ?');
const recordRedemption = db.prepare(
  'INSERT INTO coupon_redemptions (code, user_id, order_id, amount_off) VALUES (?, ?, ?, ?)'
);
const bumpCouponUsage = db.prepare('UPDATE coupons SET times_used = times_used + 1 WHERE code = ?');
const logItemEvent = db.prepare(
  "INSERT INTO item_events (user_id, item_id, action) VALUES (?, ?, 'order')"
);

const findIdempotent = db.prepare(
  "SELECT order_id FROM idempotency_keys WHERE key = ? AND user_id = ? AND scope = 'checkout'"
);
const claimIdempotent = db.prepare(
  "INSERT INTO idempotency_keys (key, user_id, scope, order_id) VALUES (?, ?, 'checkout', ?)"
);

const newCode = () => `QB-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

function serialize(order) {
  const elapsed = minutesSince(order.placed_at);
  const remaining = Math.max(Math.ceil(order.eta_minutes - elapsed), 0);
  const finished = order.status === 'delivered' || order.status === 'cancelled';

  return {
    ...order,
    status_label: LABELS[order.status] || order.status,
    minutes_remaining: finished ? 0 : remaining,
    can_cancel: canCustomerCancel(order.status),
    items: selectItems.all(order.id),
    events: selectEvents.all(order.id).map((e) => ({ ...e, label: LABELS[e.status] || e.status })),
  };
}

/**
 * POST /api/orders — checkout.
 *
 * Everything that must succeed or fail together happens in one transaction:
 * stock is decremented with a guard so two simultaneous checkouts cannot
 * oversell, the coupon redemption is recorded, the cart is emptied and the
 * idempotency key is claimed. A repeat of the same `Idempotency-Key` returns the
 * original order instead of placing a second one.
 */
router.post(
  '/',
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'checkout', message: 'Too many checkout attempts. Please wait a moment.' }),
  (req, res) => {
    const idempotencyKey = cleanText(req.get('Idempotency-Key') || req.body.idempotency_key || '', 100);

    if (idempotencyKey) {
      const existing = findIdempotent.get(idempotencyKey, req.user.id);
      if (existing) {
        const order = selectOrder.get(existing.order_id, req.user.id);
        if (order) {
          res.setHeader('Idempotent-Replay', 'true');
          return res.status(200).json({ order: serialize(order), replayed: true });
        }
      }
    }

    const lines = selectLines.all(req.user.id);
    if (lines.length === 0) return res.status(400).json({ error: 'Your cart is empty.' });

    const unavailable = lines.filter((l) => !l.is_available);
    if (unavailable.length > 0) {
      return res.status(409).json({
        error: `${unavailable.map((l) => l.name).join(', ')} is no longer available. Please update your cart.`,
      });
    }

    const short = lines.filter((l) => l.stock < l.quantity);
    if (short.length > 0) {
      return res.status(409).json({
        error: `We only have ${short[0].stock} × ${short[0].name} left. Please reduce the quantity.`,
        item_id: short[0].item_id,
        available: short[0].stock,
      });
    }

    const name = cleanText(req.body.name || req.user.name, 80);
    const phone = cleanText(req.body.phone, 20);
    const address = cleanText(req.body.address, 300);
    const notes = cleanText(req.body.notes, 500);
    const paymentMethod = ['cod', 'card', 'upi'].includes(req.body.payment_method)
      ? req.body.payment_method
      : 'cod';

    if (name.length < 2) return res.status(400).json({ error: 'Please enter a name for the order.' });
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number.' });
    if (address.length < 10) return res.status(400).json({ error: 'Please enter a full delivery address.' });

    const totals = priceCart(lines, req.body.coupon, req.user.id);
    if (totals.coupon_error) return res.status(400).json({ error: totals.coupon_error });

    const eta = estimateEta(lines);
    // Cash on delivery is settled by the rider; online methods start unpaid and
    // are only marked paid by a verified gateway webhook.
    const paymentStatus = paymentMethod === 'cod' ? 'on_delivery' : 'pending';

    let orderId;
    try {
      orderId = transaction(() => {
        // Guarded decrements: if another checkout took the last portion between
        // the check above and here, `changes` is 0 and the whole order rolls back.
        for (const line of lines) {
          const result = decrementStock.run(line.quantity, line.item_id, line.quantity);
          if (result.changes === 0) {
            const err = new Error(`${line.name} just sold out. Please update your cart.`);
            err.status = 409;
            throw err;
          }
        }

        const { lastInsertRowid } = insertOrder.run(
          newCode(), req.user.id,
          totals.subtotal, totals.discount, totals.delivery_fee + totals.small_order_fee,
          totals.tax, totals.total,
          totals.coupon ? totals.coupon.code : null,
          name, phone, address, notes, paymentMethod, paymentStatus, eta
        );
        const id = Number(lastInsertRowid);

        for (const line of lines) {
          insertOrderItem.run(id, line.item_id, line.name, line.image, line.price, line.quantity);
          logItemEvent.run(req.user.id, line.item_id);
        }

        if (totals.coupon) {
          recordRedemption.run(totals.coupon.code, req.user.id, id, totals.discount);
          bumpCouponUsage.run(totals.coupon.code);
        }

        insertEvent.run(id, 'placed', `Payment: ${paymentMethod.toUpperCase()}`);
        clearCart.run(req.user.id);
        updateProfileDefaults.run(phone, address, req.user.id);

        if (idempotencyKey) claimIdempotent.run(idempotencyKey, req.user.id, id);

        return id;
      })();
    } catch (err) {
      if (err.status === 409) return res.status(409).json({ error: err.message });
      throw err;
    }

    res.status(201).json({ order: serialize(selectOrder.get(orderId, req.user.id)) });
  }
);

router.get('/', (req, res) => {
  advanceOrders();
  const limit = Math.min(toPositiveInt(req.query.limit) || 20, 50);
  const offset = Math.max(Math.trunc(Number(req.query.offset) || 0), 0);
  const total = countOrders.get(req.user.id).n;

  res.json({
    orders: selectOrders.all(req.user.id, limit, offset).map(serialize),
    page: { limit, offset, total, has_more: offset + limit < total },
  });
});

router.get('/:id', (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id) return res.status(404).json({ error: 'Order not found.' });

  advanceOrders(id);
  const order = selectOrder.get(id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order: serialize(order) });
});

/** Cancelling restores the stock it reserved. */
router.post('/:id/cancel', (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id) return res.status(404).json({ error: 'Order not found.' });

  advanceOrders(id);
  const order = selectOrder.get(id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status === 'cancelled') return res.status(409).json({ error: 'This order is already cancelled.' });
  if (!canCustomerCancel(order.status)) {
    return res.status(409).json({ error: 'This order is already being prepared and can no longer be cancelled.' });
  }

  transaction(() => {
    cancelOrder.run(id);
    insertEvent.run(id, 'cancelled', 'Cancelled by customer');
    for (const line of selectItems.all(id)) {
      if (line.item_id) restoreStock.run(line.quantity, line.item_id);
    }
  })();

  res.json({ order: serialize(selectOrder.get(id, req.user.id)) });
});

/** Puts a past order's items straight back into the cart. */
router.post('/:id/reorder', (req, res) => {
  const id = toPositiveInt(req.params.id);
  const order = id ? selectOrder.get(id, req.user.id) : null;
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const available = db.prepare(
    'SELECT id FROM menu_items WHERE id = ? AND is_available = 1 AND stock > 0'
  );
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

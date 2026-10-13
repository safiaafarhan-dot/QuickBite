'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { sql, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { priceCart, estimateEta } = require('../pricing');
const { LABELS, advanceOrders, minutesSince, canCustomerCancel } = require('../orderState');
const { selectLines, clearCart } = require('./cart');
const { cleanText, toPositiveInt, PHONE_RE, rateLimit, route } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

/*
 * `RETURNING id` replaces SQLite's `lastInsertRowid`. It is not a convenience:
 * PostgreSQL has no equivalent of "the id of the last insert on this
 * connection" that is safe to read separately, and RETURNING gives the value
 * back from the insert itself.
 */
const INSERT_ORDER = `
  INSERT INTO orders (code, user_id, status, subtotal, discount, delivery_fee, tax, total,
                      coupon_code, customer_name, phone, address, notes, payment_method,
                      payment_status, eta_minutes)
  VALUES ($1, $2, 'placed', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  RETURNING id
`;
const INSERT_ORDER_ITEM =
  'INSERT INTO order_items (order_id, item_id, name, image, price, quantity) VALUES ($1, $2, $3, $4, $5, $6)';
const INSERT_EVENT = 'INSERT INTO order_events (order_id, status, note) VALUES ($1, $2, $3)';
const SELECT_ORDERS = 'SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3';
const COUNT_ORDERS = 'SELECT COUNT(*) AS n FROM orders WHERE user_id = $1';
const SELECT_ORDER = 'SELECT * FROM orders WHERE id = $1 AND user_id = $2';
const SELECT_ITEMS = 'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id';
const SELECT_EVENTS = 'SELECT status, note, at FROM order_events WHERE order_id = $1 ORDER BY id';
const CANCEL_ORDER =
  "UPDATE orders SET status = 'cancelled', auto_advance = 0, updated_at = now() WHERE id = $1";
const UPDATE_PROFILE_DEFAULTS = 'UPDATE users SET phone = $1, address = $2 WHERE id = $3';

const DECREMENT_STOCK = 'UPDATE menu_items SET stock = stock - $1 WHERE id = $2 AND stock >= $3';
const RESTORE_STOCK = 'UPDATE menu_items SET stock = stock + $1 WHERE id = $2';
const RECORD_REDEMPTION =
  'INSERT INTO coupon_redemptions (code, user_id, order_id, amount_off) VALUES ($1, $2, $3, $4)';
const BUMP_COUPON_USAGE = 'UPDATE coupons SET times_used = times_used + 1 WHERE code = $1';
const LOG_ITEM_EVENT = "INSERT INTO item_events (user_id, item_id, action) VALUES ($1, $2, 'order')";

const FIND_IDEMPOTENT =
  "SELECT order_id FROM idempotency_keys WHERE key = $1 AND user_id = $2 AND scope = 'checkout'";
const CLAIM_IDEMPOTENT =
  "INSERT INTO idempotency_keys (key, user_id, scope, order_id) VALUES ($1, $2, 'checkout', $3)";

const AVAILABLE_ITEM = 'SELECT id FROM menu_items WHERE id = $1 AND is_available = 1 AND stock > 0';
const REORDER_UPSERT = `
  INSERT INTO cart_items (user_id, item_id, quantity) VALUES ($1, $2, $3)
  ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, 20)
`;

const newCode = () => `QB-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

async function serialize(order, exec = sql) {
  const elapsed = minutesSince(order.placed_at);
  const remaining = Math.max(Math.ceil(order.eta_minutes - elapsed), 0);
  const finished = order.status === 'delivered' || order.status === 'cancelled';

  const [items, events] = await Promise.all([
    exec.all(SELECT_ITEMS, [order.id]),
    exec.all(SELECT_EVENTS, [order.id]),
  ]);

  return {
    ...order,
    status_label: LABELS[order.status] || order.status,
    minutes_remaining: finished ? 0 : remaining,
    can_cancel: canCustomerCancel(order.status),
    items,
    events: events.map((e) => ({ ...e, label: LABELS[e.status] || e.status })),
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
 *
 * Every statement inside the block runs on `tx`, the transaction's own
 * connection. The cart is re-read there too, rather than relying on the copy
 * read before the transaction opened, so the prices and stock the order is
 * built from are the ones the transaction itself can see.
 */
router.post(
  '/',
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'checkout', message: 'Too many checkout attempts. Please wait a moment.' }),
  route(async (req, res) => {
    const idempotencyKey = cleanText(req.get('Idempotency-Key') || req.body.idempotency_key || '', 100);

    if (idempotencyKey) {
      const existing = await sql.get(FIND_IDEMPOTENT, [idempotencyKey, req.user.id]);
      if (existing) {
        const order = await sql.get(SELECT_ORDER, [existing.order_id, req.user.id]);
        if (order) {
          res.setHeader('Idempotent-Replay', 'true');
          return res.status(200).json({ order: await serialize(order), replayed: true });
        }
      }
    }

    const lines = await selectLines(req.user.id);
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

    const preview = await priceCart(lines, req.body.coupon, req.user.id);
    if (preview.coupon_error) return res.status(400).json({ error: preview.coupon_error });

    let orderId;
    try {
      orderId = await transaction(async (tx) => {
        const txLines = await selectLines(req.user.id, tx);
        if (txLines.length === 0) {
          const err = new Error('Your cart is empty.');
          err.status = 400;
          throw err;
        }

        const totals = await priceCart(txLines, req.body.coupon, req.user.id, tx);
        if (totals.coupon_error) {
          const err = new Error(totals.coupon_error);
          err.status = 400;
          throw err;
        }

        const eta = estimateEta(txLines);
        // Cash on delivery is settled by the rider; online methods start unpaid
        // and are only marked paid by a verified gateway webhook.
        const paymentStatus = paymentMethod === 'cod' ? 'on_delivery' : 'pending';

        // Guarded decrements: if another checkout took the last portion between
        // the check above and here, `rowCount` is 0 and the whole order rolls back.
        for (const line of txLines) {
          const result = await tx.run(DECREMENT_STOCK, [line.quantity, line.item_id, line.quantity]);
          if (result.rowCount === 0) {
            const err = new Error(`${line.name} just sold out. Please update your cart.`);
            err.status = 409;
            throw err;
          }
        }

        const inserted = await tx.run(INSERT_ORDER, [
          newCode(), req.user.id,
          totals.subtotal, totals.discount, totals.delivery_fee + totals.small_order_fee,
          totals.tax, totals.total,
          totals.coupon ? totals.coupon.code : null,
          name, phone, address, notes, paymentMethod, paymentStatus, eta,
        ]);
        const id = inserted.row.id;

        for (const line of txLines) {
          await tx.run(INSERT_ORDER_ITEM, [id, line.item_id, line.name, line.image, line.price, line.quantity]);
          await tx.run(LOG_ITEM_EVENT, [req.user.id, line.item_id]);
        }

        if (totals.coupon) {
          await tx.run(RECORD_REDEMPTION, [totals.coupon.code, req.user.id, id, totals.discount]);
          await tx.run(BUMP_COUPON_USAGE, [totals.coupon.code]);
        }

        await tx.run(INSERT_EVENT, [id, 'placed', `Payment: ${paymentMethod.toUpperCase()}`]);
        await clearCart(req.user.id, tx);
        await tx.run(UPDATE_PROFILE_DEFAULTS, [phone, address, req.user.id]);

        if (idempotencyKey) await tx.run(CLAIM_IDEMPOTENT, [idempotencyKey, req.user.id, id]);

        return id;
      });
    } catch (err) {
      if (err.status === 409) return res.status(409).json({ error: err.message });
      if (err.status === 400) return res.status(400).json({ error: err.message });
      throw err;
    }

    const order = await sql.get(SELECT_ORDER, [orderId, req.user.id]);
    res.status(201).json({ order: await serialize(order) });
  })
);

router.get('/', route(async (req, res) => {
  await advanceOrders();
  const limit = Math.min(toPositiveInt(req.query.limit) || 20, 50);
  const offset = Math.max(Math.trunc(Number(req.query.offset) || 0), 0);
  const { n: total } = await sql.get(COUNT_ORDERS, [req.user.id]);

  const rows = await sql.all(SELECT_ORDERS, [req.user.id, limit, offset]);

  res.json({
    orders: await Promise.all(rows.map((o) => serialize(o))),
    page: { limit, offset, total, has_more: offset + limit < total },
  });
}));

router.get('/:id', route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id) return res.status(404).json({ error: 'Order not found.' });

  await advanceOrders(id);
  const order = await sql.get(SELECT_ORDER, [id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order: await serialize(order) });
}));

/** Cancelling restores the stock it reserved. */
router.post('/:id/cancel', route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id) return res.status(404).json({ error: 'Order not found.' });

  await advanceOrders(id);
  const order = await sql.get(SELECT_ORDER, [id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status === 'cancelled') return res.status(409).json({ error: 'This order is already cancelled.' });
  if (!canCustomerCancel(order.status)) {
    return res.status(409).json({ error: 'This order is already being prepared and can no longer be cancelled.' });
  }

  await transaction(async (tx) => {
    await tx.run(CANCEL_ORDER, [id]);
    await tx.run(INSERT_EVENT, [id, 'cancelled', 'Cancelled by customer']);
    for (const line of await tx.all(SELECT_ITEMS, [id])) {
      if (line.item_id) await tx.run(RESTORE_STOCK, [line.quantity, line.item_id]);
    }
  });

  const updated = await sql.get(SELECT_ORDER, [id, req.user.id]);
  res.json({ order: await serialize(updated) });
}));

/** Puts a past order's items straight back into the cart. */
router.post('/:id/reorder', route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  const order = id ? await sql.get(SELECT_ORDER, [id, req.user.id]) : null;
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const skipped = [];
  await transaction(async (tx) => {
    for (const line of await tx.all(SELECT_ITEMS, [order.id])) {
      const available = line.item_id ? await tx.get(AVAILABLE_ITEM, [line.item_id]) : null;
      if (available) await tx.run(REORDER_UPSERT, [req.user.id, line.item_id, line.quantity]);
      else skipped.push(line.name);
    }
  });

  res.json({ skipped });
}));

module.exports = router;

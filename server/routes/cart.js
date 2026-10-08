'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { priceCart } = require('../pricing');

const router = express.Router();
router.use(requireAuth);

const selectLines = db.prepare(`
  SELECT c.item_id, c.quantity, m.name, m.price, m.image, m.prep_minutes, m.is_available
  FROM cart_items c
  JOIN menu_items m ON m.id = c.item_id
  WHERE c.user_id = ?
  ORDER BY m.name
`);
const upsertLine = db.prepare(`
  INSERT INTO cart_items (user_id, item_id, quantity) VALUES (?, ?, ?)
  ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
`);
const setLine = db.prepare('UPDATE cart_items SET quantity = ? WHERE user_id = ? AND item_id = ?');
const deleteLine = db.prepare('DELETE FROM cart_items WHERE user_id = ? AND item_id = ?');
const clearCart = db.prepare('DELETE FROM cart_items WHERE user_id = ?');
const findItem = db.prepare('SELECT * FROM menu_items WHERE id = ? AND is_available = 1');

const MAX_QTY = 20;

/** The one place that renders a cart response, so every endpoint agrees. */
function cartPayload(userId, couponCode) {
  const lines = selectLines.all(userId);
  const totals = priceCart(lines, couponCode);
  return {
    items: lines.map((l) => ({
      item_id: l.item_id,
      name: l.name,
      image: l.image,
      price: l.price,
      quantity: l.quantity,
      line_total: l.price * l.quantity,
    })),
    count: lines.reduce((n, l) => n + l.quantity, 0),
    ...totals,
  };
}

router.get('/', (req, res) => {
  res.json(cartPayload(req.user.id, req.query.coupon));
});

router.post('/items', (req, res) => {
  const itemId = Number(req.body.item_id);
  const quantity = Math.trunc(Number(req.body.quantity ?? 1));

  if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'A valid item_id is required.' });
  if (!Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ error: 'Quantity must be at least 1.' });
  if (!findItem.get(itemId)) return res.status(404).json({ error: 'That dish is not on the menu right now.' });

  upsertLine.run(req.user.id, itemId, quantity);

  const current = selectLines.all(req.user.id).find((l) => l.item_id === itemId);
  if (current && current.quantity > MAX_QTY) setLine.run(MAX_QTY, req.user.id, itemId);

  res.status(201).json(cartPayload(req.user.id, req.body.coupon));
});

router.patch('/items/:itemId', (req, res) => {
  const itemId = Number(req.params.itemId);
  const quantity = Math.trunc(Number(req.body.quantity));

  if (!Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ error: 'Quantity must be 0 or more.' });
  if (quantity > MAX_QTY) return res.status(400).json({ error: `You can order at most ${MAX_QTY} of one dish.` });

  if (quantity === 0) deleteLine.run(req.user.id, itemId);
  else {
    if (!findItem.get(itemId)) return res.status(404).json({ error: 'That dish is not on the menu right now.' });
    const changed = setLine.run(quantity, req.user.id, itemId);
    if (changed.changes === 0) upsertLine.run(req.user.id, itemId, quantity);
  }

  res.json(cartPayload(req.user.id, req.body.coupon));
});

router.delete('/items/:itemId', (req, res) => {
  deleteLine.run(req.user.id, Number(req.params.itemId));
  res.json(cartPayload(req.user.id, req.query.coupon));
});

router.delete('/', (req, res) => {
  clearCart.run(req.user.id);
  res.json(cartPayload(req.user.id));
});

/** Folds a guest's localStorage cart into the account's cart after sign-in. */
router.post('/merge', (req, res) => {
  const incoming = Array.isArray(req.body.items) ? req.body.items : [];
  const merge = transaction((rows) => {
    for (const row of rows) {
      const itemId = Number(row.item_id);
      const quantity = Math.trunc(Number(row.quantity));
      if (!Number.isInteger(itemId) || !Number.isInteger(quantity) || quantity < 1) continue;
      if (!findItem.get(itemId)) continue;
      upsertLine.run(req.user.id, itemId, Math.min(quantity, MAX_QTY));
    }
  });
  merge(incoming);

  for (const line of selectLines.all(req.user.id)) {
    if (line.quantity > MAX_QTY) setLine.run(MAX_QTY, req.user.id, line.item_id);
  }

  res.json(cartPayload(req.user.id, req.body.coupon));
});

module.exports = { router, cartPayload, selectLines, clearCart };

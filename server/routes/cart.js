'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { priceCart } = require('../pricing');
const { toPositiveInt } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const selectLines = db.prepare(`
  SELECT c.item_id, c.quantity,
         m.name, m.price, m.image, m.prep_minutes, m.is_available, m.stock, m.slug
  FROM cart_items c
  JOIN menu_items m ON m.id = c.item_id
  WHERE c.user_id = ?
  ORDER BY m.sort_order, m.name
`);
const upsertLine = db.prepare(`
  INSERT INTO cart_items (user_id, item_id, quantity) VALUES (?, ?, ?)
  ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = min(quantity + excluded.quantity, 20)
`);
const setLine = db.prepare('UPDATE cart_items SET quantity = ? WHERE user_id = ? AND item_id = ?');
const deleteLine = db.prepare('DELETE FROM cart_items WHERE user_id = ? AND item_id = ?');
const clearCart = db.prepare('DELETE FROM cart_items WHERE user_id = ?');
const findItem = db.prepare('SELECT * FROM menu_items WHERE id = ? AND is_available = 1');
const logItemEvent = db.prepare(
  "INSERT INTO item_events (user_id, item_id, action) VALUES (?, ?, 'cart')"
);

const MAX_QTY = 20;

/** The one place that renders a cart response, so every endpoint agrees. */
function cartPayload(userId, couponCode) {
  const lines = selectLines.all(userId);
  const totals = priceCart(lines, couponCode, userId);

  return {
    items: lines.map((l) => ({
      item_id: l.item_id,
      slug: l.slug,
      name: l.name,
      image: l.image,
      price: l.price,
      quantity: l.quantity,
      line_total: l.price * l.quantity,
      // Surfaced so the drawer can warn before the customer reaches checkout.
      stock: l.stock,
      in_stock: l.stock >= l.quantity,
      is_available: Boolean(l.is_available),
    })),
    count: lines.reduce((n, l) => n + l.quantity, 0),
    ...totals,
  };
}

router.get('/', (req, res) => {
  res.json(cartPayload(req.user.id, req.query.coupon));
});

router.post('/items', (req, res) => {
  const itemId = toPositiveInt(req.body.item_id);
  const quantity = toPositiveInt(req.body.quantity ?? 1, { max: MAX_QTY });

  if (!itemId) return res.status(400).json({ error: 'A valid item_id is required.' });
  if (!quantity) return res.status(400).json({ error: `Quantity must be between 1 and ${MAX_QTY}.` });

  const item = findItem.get(itemId);
  if (!item) return res.status(404).json({ error: 'That dish is not on the menu right now.' });
  if (item.stock < 1) return res.status(409).json({ error: `${item.name} is sold out for today.` });

  transaction(() => {
    upsertLine.run(req.user.id, itemId, quantity);
    logItemEvent.run(req.user.id, itemId);
  })();

  res.status(201).json(cartPayload(req.user.id, req.body.coupon));
});

router.patch('/items/:itemId', (req, res) => {
  const itemId = toPositiveInt(req.params.itemId);
  const quantity = Math.trunc(Number(req.body.quantity));

  if (!itemId) return res.status(400).json({ error: 'A valid item id is required.' });
  if (!Number.isInteger(quantity) || quantity < 0) {
    return res.status(400).json({ error: 'Quantity must be 0 or more.' });
  }
  if (quantity > MAX_QTY) {
    return res.status(400).json({ error: `You can order at most ${MAX_QTY} of one dish.` });
  }

  if (quantity === 0) {
    deleteLine.run(req.user.id, itemId);
  } else {
    const item = findItem.get(itemId);
    if (!item) return res.status(404).json({ error: 'That dish is not on the menu right now.' });
    if (item.stock < quantity) {
      return res.status(409).json({ error: `Only ${item.stock} × ${item.name} left today.`, available: item.stock });
    }
    const changed = setLine.run(quantity, req.user.id, itemId);
    if (changed.changes === 0) upsertLine.run(req.user.id, itemId, quantity);
  }

  res.json(cartPayload(req.user.id, req.body.coupon));
});

router.delete('/items/:itemId', (req, res) => {
  deleteLine.run(req.user.id, toPositiveInt(req.params.itemId) || -1);
  res.json(cartPayload(req.user.id, req.query.coupon));
});

router.delete('/', (req, res) => {
  clearCart.run(req.user.id);
  res.json(cartPayload(req.user.id));
});

/** Folds a guest's localStorage cart into the account's cart after sign-in. */
router.post('/merge', (req, res) => {
  const incoming = Array.isArray(req.body.items) ? req.body.items.slice(0, 50) : [];

  transaction(() => {
    for (const row of incoming) {
      const itemId = toPositiveInt(row.item_id);
      const quantity = toPositiveInt(row.quantity, { max: MAX_QTY });
      if (!itemId || !quantity) continue;

      const item = findItem.get(itemId);
      if (!item || item.stock < 1) continue;

      upsertLine.run(req.user.id, itemId, Math.min(quantity, item.stock));
    }
  })();

  res.json(cartPayload(req.user.id, req.body.coupon));
});

module.exports = { router, cartPayload, selectLines, clearCart };

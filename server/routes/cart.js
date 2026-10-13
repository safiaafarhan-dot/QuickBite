'use strict';

const express = require('express');
const { sql, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { priceCart } = require('../pricing');
const { toPositiveInt, route } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const SELECT_LINES = `
  SELECT c.item_id, c.quantity,
         m.name, m.price, m.image, m.prep_minutes, m.is_available, m.stock, m.slug
  FROM cart_items c
  JOIN menu_items m ON m.id = c.item_id
  WHERE c.user_id = $1
  ORDER BY m.sort_order, m.name
`;
/*
 * `LEAST`, not SQLite's `min()`: in PostgreSQL `min()` is the aggregate, and
 * using it here is a syntax error rather than a silently different answer.
 */
const UPSERT_LINE = `
  INSERT INTO cart_items (user_id, item_id, quantity) VALUES ($1, $2, $3)
  ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, 20)
`;
const SET_LINE = 'UPDATE cart_items SET quantity = $1 WHERE user_id = $2 AND item_id = $3';
const DELETE_LINE = 'DELETE FROM cart_items WHERE user_id = $1 AND item_id = $2';
const CLEAR_CART = 'DELETE FROM cart_items WHERE user_id = $1';
const FIND_ITEM = 'SELECT * FROM menu_items WHERE id = $1 AND is_available = 1';
const LOG_ITEM_EVENT = "INSERT INTO item_events (user_id, item_id, action) VALUES ($1, $2, 'cart')";

const MAX_QTY = 20;

/*
 * These two are reached from `routes/orders.js` *inside* its checkout
 * transaction, so they take the executor to run on. Passing the transaction's
 * client is not optional there: a statement sent through the pool instead
 * would run on a different connection, outside the transaction, and would not
 * roll back with it.
 */
const selectLines = (userId, exec = sql) => exec.all(SELECT_LINES, [userId]);
const clearCart = (userId, exec = sql) => exec.run(CLEAR_CART, [userId]);

/** The one place that renders a cart response, so every endpoint agrees. */
async function cartPayload(userId, couponCode) {
  const lines = await selectLines(userId);
  const totals = await priceCart(lines, couponCode, userId);

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

router.get('/', route(async (req, res) => {
  res.json(await cartPayload(req.user.id, req.query.coupon));
}));

router.post('/items', route(async (req, res) => {
  const itemId = toPositiveInt(req.body.item_id);
  const quantity = toPositiveInt(req.body.quantity ?? 1, { max: MAX_QTY });

  if (!itemId) return res.status(400).json({ error: 'A valid item_id is required.' });
  if (!quantity) return res.status(400).json({ error: `Quantity must be between 1 and ${MAX_QTY}.` });

  const item = await sql.get(FIND_ITEM, [itemId]);
  if (!item) return res.status(404).json({ error: 'That dish is not on the menu right now.' });
  if (item.stock < 1) return res.status(409).json({ error: `${item.name} is sold out for today.` });

  await transaction(async (tx) => {
    await tx.run(UPSERT_LINE, [req.user.id, itemId, quantity]);
    await tx.run(LOG_ITEM_EVENT, [req.user.id, itemId]);
  });

  res.status(201).json(await cartPayload(req.user.id, req.body.coupon));
}));

router.patch('/items/:itemId', route(async (req, res) => {
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
    await sql.run(DELETE_LINE, [req.user.id, itemId]);
  } else {
    const item = await sql.get(FIND_ITEM, [itemId]);
    if (!item) return res.status(404).json({ error: 'That dish is not on the menu right now.' });
    if (item.stock < quantity) {
      return res.status(409).json({ error: `Only ${item.stock} × ${item.name} left today.`, available: item.stock });
    }
    const changed = await sql.run(SET_LINE, [quantity, req.user.id, itemId]);
    if (changed.rowCount === 0) await sql.run(UPSERT_LINE, [req.user.id, itemId, quantity]);
  }

  res.json(await cartPayload(req.user.id, req.body.coupon));
}));

router.delete('/items/:itemId', route(async (req, res) => {
  await sql.run(DELETE_LINE, [req.user.id, toPositiveInt(req.params.itemId) || -1]);
  res.json(await cartPayload(req.user.id, req.query.coupon));
}));

router.delete('/', route(async (req, res) => {
  await clearCart(req.user.id);
  res.json(await cartPayload(req.user.id));
}));

/** Folds a guest's localStorage cart into the account's cart after sign-in. */
router.post('/merge', route(async (req, res) => {
  const incoming = Array.isArray(req.body.items) ? req.body.items.slice(0, 50) : [];

  await transaction(async (tx) => {
    for (const row of incoming) {
      const itemId = toPositiveInt(row.item_id);
      const quantity = toPositiveInt(row.quantity, { max: MAX_QTY });
      if (!itemId || !quantity) continue;

      const item = await tx.get(FIND_ITEM, [itemId]);
      if (!item || item.stock < 1) continue;

      await tx.run(UPSERT_LINE, [req.user.id, itemId, Math.min(quantity, item.stock)]);
    }
  });

  res.json(await cartPayload(req.user.id, req.body.coupon));
}));

module.exports = { router, cartPayload, selectLines, clearCart };

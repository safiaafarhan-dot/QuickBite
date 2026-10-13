'use strict';

const express = require('express');
const { sql, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { cleanText, toPositiveInt, PHONE_RE, route } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const LIST_FOR_USER = 'SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, id DESC';
const FIND_OWNED = 'SELECT * FROM addresses WHERE id = $1 AND user_id = $2';
const CLEAR_DEFAULTS = 'UPDATE addresses SET is_default = 0 WHERE user_id = $1';
const INSERT_ADDRESS = `
  INSERT INTO addresses (user_id, label, recipient, phone, line1, city, pincode, is_default)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING id
`;
const UPDATE_ADDRESS = `
  UPDATE addresses SET label = $1, recipient = $2, phone = $3, line1 = $4, city = $5, pincode = $6
  WHERE id = $7 AND user_id = $8
`;
const REMOVE_ADDRESS = 'DELETE FROM addresses WHERE id = $1 AND user_id = $2';
const SET_DEFAULT = 'UPDATE addresses SET is_default = 1 WHERE id = $1 AND user_id = $2';

const listForUser = (userId, exec = sql) => exec.all(LIST_FOR_USER, [userId]);
const findOwned = (id, userId, exec = sql) => exec.get(FIND_OWNED, [id, userId]);

const MAX_ADDRESSES = 10;

/** Validates an address payload, returning either the clean fields or an error. */
function parse(body) {
  const label = cleanText(body.label || 'Home', 24);
  const recipient = cleanText(body.recipient, 80);
  const phone = cleanText(body.phone, 20);
  const line1 = cleanText(body.line1, 240);
  const city = cleanText(body.city, 60);
  const pincode = cleanText(body.pincode, 10);

  if (recipient.length < 2) return { error: 'Please enter who the order is for.' };
  if (!PHONE_RE.test(phone)) return { error: 'Please enter a valid phone number.' };
  if (line1.length < 10) return { error: 'Please enter the flat, street and area.' };
  if (pincode && !/^\d{4,10}$/.test(pincode)) return { error: 'Please enter a valid PIN code.' };

  return { fields: { label, recipient, phone, line1, city, pincode } };
}

/** The single line the checkout form and order record use. */
const toSingleLine = (a) => [a.line1, a.city, a.pincode].filter(Boolean).join(', ');

const shape = (a) => ({ ...a, is_default: Boolean(a.is_default), full: toSingleLine(a) });

router.get('/', route(async (req, res) => {
  res.json({ addresses: (await listForUser(req.user.id)).map(shape) });
}));

router.post('/', route(async (req, res) => {
  const existing = await listForUser(req.user.id);
  if (existing.length >= MAX_ADDRESSES) {
    return res.status(409).json({ error: `You can save up to ${MAX_ADDRESSES} addresses.` });
  }

  const { fields, error } = parse(req.body);
  if (error) return res.status(400).json({ error });

  // The first address saved becomes the default automatically.
  const makeDefault = Boolean(req.body.is_default) || existing.length === 0;

  const id = await transaction(async (tx) => {
    if (makeDefault) await tx.run(CLEAR_DEFAULTS, [req.user.id]);
    const inserted = await tx.run(INSERT_ADDRESS, [
      req.user.id, fields.label, fields.recipient, fields.phone,
      fields.line1, fields.city, fields.pincode, makeDefault ? 1 : 0,
    ]);
    return inserted.row.id;
  });

  res.status(201).json({ address: shape(await findOwned(id, req.user.id)) });
}));

router.patch('/:id', route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id || !(await findOwned(id, req.user.id))) {
    return res.status(404).json({ error: 'Address not found.' });
  }

  const { fields, error } = parse(req.body);
  if (error) return res.status(400).json({ error });

  await transaction(async (tx) => {
    await tx.run(UPDATE_ADDRESS, [
      fields.label, fields.recipient, fields.phone,
      fields.line1, fields.city, fields.pincode, id, req.user.id,
    ]);
    if (req.body.is_default) {
      await tx.run(CLEAR_DEFAULTS, [req.user.id]);
      await tx.run(SET_DEFAULT, [id, req.user.id]);
    }
  });

  res.json({ address: shape(await findOwned(id, req.user.id)) });
}));

router.post('/:id/default', route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id || !(await findOwned(id, req.user.id))) {
    return res.status(404).json({ error: 'Address not found.' });
  }

  await transaction(async (tx) => {
    await tx.run(CLEAR_DEFAULTS, [req.user.id]);
    await tx.run(SET_DEFAULT, [id, req.user.id]);
  });

  res.json({ addresses: (await listForUser(req.user.id)).map(shape) });
}));

router.delete('/:id', route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  const address = id ? await findOwned(id, req.user.id) : null;
  if (!address) return res.status(404).json({ error: 'Address not found.' });

  await transaction(async (tx) => {
    await tx.run(REMOVE_ADDRESS, [id, req.user.id]);
    // Promote the next address so the account always has a default.
    if (address.is_default) {
      const [next] = await listForUser(req.user.id, tx);
      if (next) await tx.run(SET_DEFAULT, [next.id, req.user.id]);
    }
  });

  res.json({ addresses: (await listForUser(req.user.id)).map(shape) });
}));

module.exports = router;

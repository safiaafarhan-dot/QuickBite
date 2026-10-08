'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { cleanText, toPositiveInt, PHONE_RE } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const listForUser = db.prepare(
  'SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC'
);
const findOwned = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?');
const clearDefaults = db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?');
const insert = db.prepare(`
  INSERT INTO addresses (user_id, label, recipient, phone, line1, city, pincode, is_default)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const update = db.prepare(`
  UPDATE addresses SET label = ?, recipient = ?, phone = ?, line1 = ?, city = ?, pincode = ?
  WHERE id = ? AND user_id = ?
`);
const remove = db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?');
const setDefault = db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?');

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

router.get('/', (req, res) => {
  res.json({ addresses: listForUser.all(req.user.id).map(shape) });
});

router.post('/', (req, res) => {
  const existing = listForUser.all(req.user.id);
  if (existing.length >= MAX_ADDRESSES) {
    return res.status(409).json({ error: `You can save up to ${MAX_ADDRESSES} addresses.` });
  }

  const { fields, error } = parse(req.body);
  if (error) return res.status(400).json({ error });

  // The first address saved becomes the default automatically.
  const makeDefault = Boolean(req.body.is_default) || existing.length === 0;

  const id = transaction(() => {
    if (makeDefault) clearDefaults.run(req.user.id);
    const { lastInsertRowid } = insert.run(
      req.user.id, fields.label, fields.recipient, fields.phone,
      fields.line1, fields.city, fields.pincode, makeDefault ? 1 : 0
    );
    return Number(lastInsertRowid);
  })();

  res.status(201).json({ address: shape(findOwned.get(id, req.user.id)) });
});

router.patch('/:id', (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id || !findOwned.get(id, req.user.id)) {
    return res.status(404).json({ error: 'Address not found.' });
  }

  const { fields, error } = parse(req.body);
  if (error) return res.status(400).json({ error });

  transaction(() => {
    update.run(
      fields.label, fields.recipient, fields.phone,
      fields.line1, fields.city, fields.pincode, id, req.user.id
    );
    if (req.body.is_default) {
      clearDefaults.run(req.user.id);
      setDefault.run(id, req.user.id);
    }
  })();

  res.json({ address: shape(findOwned.get(id, req.user.id)) });
});

router.post('/:id/default', (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id || !findOwned.get(id, req.user.id)) {
    return res.status(404).json({ error: 'Address not found.' });
  }

  transaction(() => {
    clearDefaults.run(req.user.id);
    setDefault.run(id, req.user.id);
  })();

  res.json({ addresses: listForUser.all(req.user.id).map(shape) });
});

router.delete('/:id', (req, res) => {
  const id = toPositiveInt(req.params.id);
  const address = id ? findOwned.get(id, req.user.id) : null;
  if (!address) return res.status(404).json({ error: 'Address not found.' });

  transaction(() => {
    remove.run(id, req.user.id);
    // Promote the next address so the account always has a default.
    if (address.is_default) {
      const next = listForUser.all(req.user.id)[0];
      if (next) setDefault.run(next.id, req.user.id);
    }
  })();

  res.json({ addresses: listForUser.all(req.user.id).map(shape) });
});

module.exports = router;

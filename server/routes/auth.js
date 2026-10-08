'use strict';

const express = require('express');
const { db } = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');

const router = express.Router();

const insertUser = db.prepare(
  'INSERT INTO users (name, email, password_hash, phone, address, role) VALUES (?, ?, ?, ?, ?, ?)'
);
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const publicUser = db.prepare(
  'SELECT id, name, email, phone, address, role, created_at FROM users WHERE id = ?'
);
const updateProfile = db.prepare(
  'UPDATE users SET name = ?, phone = ?, address = ? WHERE id = ?'
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim();

    if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (findByEmail.get(email)) return res.status(409).json({ error: 'That email is already registered.' });

    const hash = await hashPassword(password);
    const { lastInsertRowid } = insertUser.run(name, email, hash, phone, address, 'customer');
    const user = publicUser.get(Number(lastInsertRowid));

    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const row = findByEmail.get(email);
    const ok = row ? await verifyPassword(password, row.password_hash) : false;
    if (!ok) return res.status(401).json({ error: 'Email or password is incorrect.' });

    const user = publicUser.get(row.id);
    res.json({ user, token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.patch('/me', requireAuth, (req, res) => {
  const name = String(req.body.name ?? req.user.name).trim();
  const phone = String(req.body.phone ?? req.user.phone ?? '').trim();
  const address = String(req.body.address ?? req.user.address ?? '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });

  updateProfile.run(name, phone, address, req.user.id);
  res.json({ user: publicUser.get(req.user.id) });
});

module.exports = router;

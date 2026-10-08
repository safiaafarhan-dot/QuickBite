'use strict';

const express = require('express');
const { db } = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');
const { cleanText, rateLimit, EMAIL_RE, PHONE_RE } = require('../middleware');

const router = express.Router();

const insertUser = db.prepare(
  'INSERT INTO users (name, email, password_hash, phone, address, role) VALUES (?, ?, ?, ?, ?, ?)'
);
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const publicUser = db.prepare(
  'SELECT id, name, email, phone, address, role, created_at FROM users WHERE id = ?'
);
const updateProfile = db.prepare('UPDATE users SET name = ?, phone = ?, address = ? WHERE id = ?');

/**
 * Credential endpoints are the obvious target for guessing, so they get a much
 * tighter budget than the rest of the API.
 */
const credentialLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60_000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  keyPrefix: 'auth',
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
});

const MIN_PASSWORD = 8;

/** Rejects the handful of passwords that show up in every breach list. */
const WEAK = new Set([
  'password', 'password1', '12345678', '123456789', 'qwerty123',
  'letmein1', 'welcome1', 'iloveyou', 'admin123', 'quickbite',
]);

function passwordProblem(password) {
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return 'Password is too long.';
  if (WEAK.has(password.toLowerCase())) return 'That password is too common — please choose another.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number.';
  }
  return null;
}

/** Credentials must arrive as strings; arrays and objects are rejected, not coerced. */
function badCredentialTypes(body) {
  for (const field of ['email', 'password']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') return true;
  }
  return false;
}

router.post('/register', credentialLimiter, async (req, res, next) => {
  try {
    if (badCredentialTypes(req.body)) {
      return res.status(400).json({ error: 'Email and password must be text.' });
    }

    const name = cleanText(req.body.name, 80);
    const email = cleanText(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || '');
    const phone = cleanText(req.body.phone, 20);
    const address = cleanText(req.body.address, 300);

    if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    const weak = passwordProblem(password);
    if (weak) return res.status(400).json({ error: weak });

    if (phone && !PHONE_RE.test(phone)) {
      return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }
    if (findByEmail.get(email)) return res.status(409).json({ error: 'That email is already registered.' });

    const hash = await hashPassword(password);
    // Role is never taken from the request body — accounts are always customers.
    const { lastInsertRowid } = insertUser.run(name, email, hash, phone, address, 'customer');
    const user = publicUser.get(Number(lastInsertRowid));

    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', credentialLimiter, async (req, res, next) => {
  try {
    if (badCredentialTypes(req.body)) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }

    const email = cleanText(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || '');

    const row = findByEmail.get(email);

    // Always run a comparison so a missing account and a wrong password take
    // the same amount of time.
    const hash = row ? row.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await verifyPassword(password, hash);

    if (!row || !ok) return res.status(401).json({ error: 'Email or password is incorrect.' });

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
  const name = cleanText(req.body.name ?? req.user.name, 80);
  const phone = cleanText(req.body.phone ?? req.user.phone ?? '', 20);
  const address = cleanText(req.body.address ?? req.user.address ?? '', 300);

  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
  if (phone && !PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  }

  updateProfile.run(name, phone, address, req.user.id);
  res.json({ user: publicUser.get(req.user.id) });
});

/**
 * Tokens are stateless JWTs held in localStorage, so "logging out" is a client
 * action. This endpoint exists so the front end has one thing to call and the
 * contract is explicit.
 */
router.post('/logout', (_req, res) => {
  res.json({ ok: true, message: 'Discard the token on the client.' });
});

module.exports = router;

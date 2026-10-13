'use strict';

const express = require('express');
const { sql } = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');
const { cleanText, rateLimit, EMAIL_RE, PHONE_RE, route } = require('../middleware');

const router = express.Router();

/*
 * `ON CONFLICT (email) DO NOTHING` plus `RETURNING id` makes registration a
 * single statement that cannot race: the old read-then-insert could let two
 * simultaneous sign-ups both pass the "is this email taken?" check. An empty
 * result now means the address was taken, and the unique index is what decides
 * it rather than a check a moment earlier.
 */
const INSERT_USER = `
  INSERT INTO users (name, email, password_hash, phone, address, role)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (email) DO NOTHING
  RETURNING id
`;
const FIND_BY_EMAIL = 'SELECT * FROM users WHERE email = $1';
const PUBLIC_USER =
  'SELECT id, name, email, phone, address, role, created_at FROM users WHERE id = $1';
const UPDATE_PROFILE = 'UPDATE users SET name = $1, phone = $2, address = $3 WHERE id = $4';

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

router.post('/register', credentialLimiter, route(async (req, res) => {
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
    if (await sql.get(FIND_BY_EMAIL, [email])) {
      return res.status(409).json({ error: 'That email is already registered.' });
    }

    const hash = await hashPassword(password);
    // Role is never taken from the request body — accounts are always customers.
    const inserted = await sql.run(INSERT_USER, [name, email, hash, phone, address, 'customer']);
    if (inserted.rowCount === 0) {
      return res.status(409).json({ error: 'That email is already registered.' });
    }

    const user = await sql.get(PUBLIC_USER, [inserted.row.id]);
    res.status(201).json({ user, token: signToken(user) });
}));

router.post('/login', credentialLimiter, route(async (req, res) => {
    if (badCredentialTypes(req.body)) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }

    const email = cleanText(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || '');

    const row = await sql.get(FIND_BY_EMAIL, [email]);

    // Always run a comparison so a missing account and a wrong password take
    // the same amount of time.
    const hash = row ? row.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await verifyPassword(password, hash);

    if (!row || !ok) return res.status(401).json({ error: 'Email or password is incorrect.' });

    const user = await sql.get(PUBLIC_USER, [row.id]);
    res.json({ user, token: signToken(user) });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.patch('/me', requireAuth, route(async (req, res) => {
  const name = cleanText(req.body.name ?? req.user.name, 80);
  const phone = cleanText(req.body.phone ?? req.user.phone ?? '', 20);
  const address = cleanText(req.body.address ?? req.user.address ?? '', 300);

  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
  if (phone && !PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  }

  await sql.run(UPDATE_PROFILE, [name, phone, address, req.user.id]);
  res.json({ user: await sql.get(PUBLIC_USER, [req.user.id]) });
}));

/**
 * Tokens are stateless JWTs held in localStorage, so "logging out" is a client
 * action. This endpoint exists so the front end has one thing to call and the
 * contract is explicit.
 */
router.post('/logout', (_req, res) => {
  res.json({ ok: true, message: 'Discard the token on the client.' });
});

module.exports = router;

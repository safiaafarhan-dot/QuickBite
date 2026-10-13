'use strict';

/**
 * Payment integration — sandbox by default.
 *
 * No real gateway is configured in this repository. What is implemented is the
 * part that matters for correctness and security:
 *
 *   - an order is NEVER marked paid because the browser said so;
 *   - a webhook is only accepted if its HMAC signature verifies against
 *     `PAYMENT_WEBHOOK_SECRET`;
 *   - processing is idempotent — the same provider reference can arrive any
 *     number of times and the order is updated once.
 *
 * Swapping in Razorpay/Stripe means replacing `verifySignature` and the
 * reference format; the order-state logic below stays as it is.
 */

const express = require('express');
const crypto = require('node:crypto');
const { sql, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { toPositiveInt, cleanText, route } = require('../middleware');

const router = express.Router();

const PROVIDER = process.env.PAYMENT_PROVIDER || 'sandbox';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';

const FIND_ORDER = 'SELECT * FROM orders WHERE id = $1';
const FIND_OWNED_ORDER = 'SELECT * FROM orders WHERE id = $1 AND user_id = $2';
const FIND_BY_REFERENCE = 'SELECT * FROM payment_events WHERE reference = $1';
/*
 * `ON CONFLICT (reference) DO NOTHING` makes the replay guard atomic. The
 * read-then-insert it replaces left a window in which two copies of the same
 * webhook — gateways retry, and retries overlap — could both pass the "have I
 * seen this reference?" check and settle the order twice. The unique index on
 * `reference` is now what decides, and an empty result means a replay.
 */
const INSERT_EVENT = `
  INSERT INTO payment_events (order_id, provider, reference, status, amount, raw)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (reference) DO NOTHING
  RETURNING id
`;
const MARK_PAID =
  'UPDATE orders SET payment_status = $1, payment_reference = $2, updated_at = now() WHERE id = $3';
const ORDER_EVENT = 'INSERT INTO order_events (order_id, status, note) VALUES ($1, $2, $3)';

/** Whether a real gateway has been wired up for this deployment. */
const isConfigured = () => PROVIDER !== 'sandbox' && WEBHOOK_SECRET.length > 0;

/**
 * Timing-safe HMAC-SHA256 check over the raw request body.
 * Requires the raw bytes — see the `verify` hook on `express.json` in index.js.
 */
function verifySignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) return false;
  if (typeof signature !== 'string' || signature.length === 0) return false;

  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POST /api/payments/intent — start a payment for an order you own.
 *
 * Returns what a real gateway would need to open its checkout. In sandbox mode
 * it also returns the signature a test webhook would carry, so the whole flow
 * can be exercised end to end without an account anywhere.
 */
router.post('/intent', requireAuth, route(async (req, res) => {
  const orderId = toPositiveInt(req.body.order_id);
  const order = orderId ? await sql.get(FIND_OWNED_ORDER, [orderId, req.user.id]) : null;

  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.payment_status === 'paid') {
    return res.status(409).json({ error: 'This order has already been paid for.' });
  }
  if (order.payment_method === 'cod') {
    return res.status(400).json({ error: 'This order is cash on delivery — there is nothing to pay online.' });
  }

  const reference = `${PROVIDER}_${crypto.randomBytes(8).toString('hex')}`;

  const intent = {
    reference,
    order_id: order.id,
    order_code: order.code,
    // The amount comes from the stored order, never from the request.
    amount: order.total,
    currency: 'INR',
    provider: PROVIDER,
    configured: isConfigured(),
  };

  if (!isConfigured()) {
    intent.sandbox = true;
    intent.note =
      'Sandbox mode: no real gateway is configured. POST the payload below to '
      + '/api/payments/webhook with the X-Signature header to simulate settlement.';
    intent.simulate = {
      url: '/api/payments/webhook',
      body: { reference, order_id: order.id, status: 'paid', amount: order.total },
    };
    if (WEBHOOK_SECRET) {
      intent.simulate.signature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(JSON.stringify(intent.simulate.body))
        .digest('hex');
    } else {
      intent.simulate.signature = null;
      intent.simulate.warning =
        'PAYMENT_WEBHOOK_SECRET is not set, so the webhook will reject every call. '
        + 'Set it in .env to exercise settlement.';
    }
  }

  res.status(201).json({ intent });
}));

/**
 * POST /api/payments/webhook — gateway callback.
 *
 * Unauthenticated by design (the gateway has no session), so the signature is
 * the only thing that makes it trustworthy. Replays are ignored.
 */
router.post('/webhook', route(async (req, res) => {
  const signature = req.get('X-Signature') || req.get('x-razorpay-signature') || '';

  if (!WEBHOOK_SECRET) {
    return res.status(503).json({
      error: 'Payments are not configured on this deployment (PAYMENT_WEBHOOK_SECRET is unset).',
    });
  }

  if (!req.rawBody || !verifySignature(req.rawBody, signature)) {
    // Deliberately terse: a probing caller learns nothing about why it failed.
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  const reference = cleanText(req.body.reference, 100);
  const orderId = toPositiveInt(req.body.order_id);
  const status = ['paid', 'failed', 'refunded'].includes(req.body.status) ? req.body.status : null;
  const amount = Math.trunc(Number(req.body.amount));

  if (!reference || !orderId || !status || !Number.isInteger(amount)) {
    return res.status(400).json({ error: 'Malformed webhook payload.' });
  }

  // Idempotent: the same reference is only ever applied once.
  const seen = await sql.get(FIND_BY_REFERENCE, [reference]);
  if (seen) return res.json({ ok: true, replayed: true, order_id: seen.order_id });

  const order = await sql.get(FIND_ORDER, [orderId]);
  if (!order) return res.status(404).json({ error: 'Unknown order.' });

  const raw = JSON.stringify(req.body).slice(0, 2000);

  // The gateway must agree with our own total; a mismatch is never accepted.
  if (status === 'paid' && amount !== order.total) {
    await sql.run(INSERT_EVENT, [order.id, PROVIDER, reference, 'mismatch', amount, raw]);
    return res.status(409).json({ error: 'Amount does not match the order total.' });
  }

  const applied = await transaction(async (tx) => {
    const inserted = await tx.run(INSERT_EVENT, [order.id, PROVIDER, reference, status, amount, raw]);
    // Another copy of this webhook won the race and already settled the order.
    if (inserted.rowCount === 0) return false;

    await tx.run(MARK_PAID, [status, reference, order.id]);
    await tx.run(ORDER_EVENT, [order.id, order.status, `Payment ${status} (${reference})`]);
    return true;
  });

  if (!applied) return res.json({ ok: true, replayed: true, order_id: order.id });

  res.json({ ok: true, order_id: order.id, payment_status: status });
}));

/** GET /api/payments/status/:orderId — what the customer is allowed to see. */
router.get('/status/:orderId', requireAuth, route(async (req, res) => {
  const orderId = toPositiveInt(req.params.orderId);
  const order = orderId ? await sql.get(FIND_OWNED_ORDER, [orderId, req.user.id]) : null;
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  res.json({
    order_id: order.id,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    amount: order.total,
  });
}));

router.get('/config', (_req, res) => {
  res.json({
    provider: PROVIDER,
    configured: isConfigured(),
    webhook_secret_set: WEBHOOK_SECRET.length > 0,
    note: isConfigured()
      ? 'A payment provider is configured.'
      : 'Running in sandbox mode — no real money moves. Set PAYMENT_PROVIDER and PAYMENT_WEBHOOK_SECRET to go live.',
  });
});

module.exports = { router, verifySignature, isConfigured };

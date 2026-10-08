'use strict';

const crypto = require('node:crypto');

/* ------------------------------------------------------------------ */
/* Security headers                                                    */
/* ------------------------------------------------------------------ */

/**
 * A deliberately tight Content-Security-Policy: the front end is plain
 * same-origin HTML/CSS/JS with no CDN, so nothing needs to be allowed off-site.
 * `'unsafe-inline'` covers the handful of inline `onerror` image fallbacks.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // Only meaningful once the app is actually served over TLS.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * A fixed-window counter held in memory. That is the right shape for a
 * single-process deployment; a multi-instance deployment would need shared
 * state (Redis) instead, which is noted in the deployment docs.
 */
function rateLimit({ windowMs, max, keyPrefix = '', message }) {
  const hits = new Map();

  // Drop expired buckets periodically so the map cannot grow without bound.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 60_000));
  sweeper.unref?.();

  return (req, res, next) => {
    const key = `${keyPrefix}:${req.user?.id ?? req.ip}`;
    const now = Date.now();

    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(max - bucket.count, 0);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({
        error: message || 'Too many requests. Please slow down and try again shortly.',
      });
    }

    next();
  };
}

/* ------------------------------------------------------------------ */
/* Request logging                                                     */
/* ------------------------------------------------------------------ */

/** Header and body keys that must never reach the log. */
const REDACTED = new Set(['password', 'token', 'authorization', 'idempotency-key', 'secret']);

/**
 * One structured JSON line per request. Deliberately records no request body and
 * no header values — only the user id, which is needed to trace an issue.
 */
function requestLogger(req, res, next) {
  if (process.env.NODE_ENV === 'test' || process.env.QUICKBITE_QUIET === '1') return next();

  const started = process.hrtime.bigint();
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        id: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(ms),
        user: req.user?.id ?? null,
      })
    );
  });

  next();
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

/** Trims, caps length, and strips control characters from user-supplied text. */
function cleanText(value, maxLength = 200) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+\-\s()]{8,20}$/;

/** Parses a positive integer from untrusted input, or returns null. */
function toPositiveInt(value, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Math.trunc(Number(value));
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

module.exports = {
  securityHeaders,
  rateLimit,
  requestLogger,
  cleanText,
  toPositiveInt,
  EMAIL_RE,
  PHONE_RE,
  REDACTED,
};

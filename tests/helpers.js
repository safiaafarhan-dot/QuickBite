'use strict';

/**
 * Shared test harness: a throwaway database, a live server on a random port,
 * and small helpers for talking to the API.
 *
 * Every test file gets its own SQLite file, so suites never see each other's
 * data and nothing can touch a real database.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Must be called before `require`-ing anything under `server/`, because the
 * database module reads these at load time.
 */
function prepareEnvironment(label) {
  const file = path.join(os.tmpdir(), `quickbite-${label}-${process.pid}-${Date.now()}.db`);

  process.env.DB_FILE = file;
  process.env.JWT_SECRET = 'test-secret-not-used-anywhere-real';
  process.env.NODE_ENV = 'test';
  // Rate limits are a production concern; a test suite creates far more
  // accounts in a minute than any human would. `tests/security.test.js`
  // exercises the limiter itself with a deliberately low ceiling.
  process.env.AUTH_RATE_LIMIT_MAX = '10000';
  process.env.API_RATE_LIMIT_MAX = '100000';
  process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';

  return file;
}

/** Removes the throwaway database, tolerating Windows' lazy file handles. */
function cleanup(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true });
    } catch {
      /* a stale temp file is harmless */
    }
  }
}

/** Builds a `call(method, path, options)` helper bound to a base URL. */
function makeClient(getBase) {
  return async function call(method, route, { token, body, headers = {} } = {}) {
    const res = await fetch(getBase() + route, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return {
      status: res.status,
      headers: res.headers,
      body: await res.json().catch(() => ({})),
    };
  };
}

let counter = 0;
const uniqueEmail = () => `user${Date.now()}${counter++}@test.local`;

/** A password that satisfies the strength rules, used across the suites. */
const GOOD_PASSWORD = 'secret123';

const VALID_ADDRESS = '42 Test Street, Example Area, Bengaluru 560001';
const VALID_PHONE = '+91 90000 00000';

module.exports = {
  prepareEnvironment,
  cleanup,
  makeClient,
  uniqueEmail,
  GOOD_PASSWORD,
  VALID_ADDRESS,
  VALID_PHONE,
};

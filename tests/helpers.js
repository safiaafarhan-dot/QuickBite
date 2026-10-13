'use strict';

/**
 * Shared test harness: an isolated database, a live server on a random port,
 * and small helpers for talking to the API.
 *
 * Under SQLite every suite got its own file. PostgreSQL has no equivalent, so
 * each suite gets its own **schema** inside one database instead: the
 * connection's `search_path` points at it, every table is created there, and
 * the schema is dropped when the suite finishes. Suites still never see each
 * other's data, and nothing can touch a real deployment's tables.
 *
 * The suites need a real PostgreSQL. There is no in-process equivalent of a
 * SQLite temp file, so when `DATABASE_URL` (or `TEST_DATABASE_URL`) is unset
 * the database-backed suites SKIP — loudly, and never counted as a pass — in
 * exactly the way the browser suites skip when Chrome is unavailable.
 */

const os = require('node:os');
const path = require('node:path');

/**
 * Why a test database must be opted into explicitly: these suites create and
 * drop schemas and write freely. Pointing them at a database that matters
 * would be destructive, so the harness refuses to guess.
 */
const TEST_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';

const SKIP_REASON =
  'no test database — set TEST_DATABASE_URL (or DATABASE_URL) to a PostgreSQL '
  + 'instance you do not mind this suite writing to, e.g. '
  + 'postgresql://postgres:postgres@127.0.0.1:5432/quickbite_test';

/** `null` when the suites can run, or a human-readable reason when they cannot. */
function databaseUnavailable() {
  return TEST_URL ? null : SKIP_REASON;
}

/**
 * Must be called before `require`-ing anything under `server/`, because the
 * database module reads these when it builds its pool.
 *
 * @returns {string} the schema this suite owns
 */
function prepareEnvironment(label) {
  const schema = `qb_test_${label}_${process.pid}_${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 60);

  process.env.DATABASE_URL = TEST_URL;
  process.env.DB_SCHEMA = schema;
  process.env.JWT_SECRET = 'test-secret-not-used-anywhere-real';
  process.env.NODE_ENV = 'test';
  // Rate limits are a production concern; a test suite creates far more
  // accounts in a minute than any human would. `tests/security.test.js`
  // exercises the limiter itself with a deliberately low ceiling.
  process.env.AUTH_RATE_LIMIT_MAX = '10000';
  process.env.API_RATE_LIMIT_MAX = '100000';
  process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';

  return schema;
}

/**
 * Connects, migrates and seeds this suite's schema. Call it from `test.before`
 * — the schema does not exist until it runs.
 */
async function initTestDb() {
  const { initDb } = require('../server/db');
  await initDb({ log: false });
}

/**
 * Drops the suite's schema and closes the pool.
 *
 * `CASCADE` is safe here precisely because the schema is this suite's alone:
 * it was created by `prepareEnvironment` under a name carrying the pid and a
 * timestamp, and holds nothing but the tables the suite just made.
 */
async function cleanup(schema) {
  const { sql, closeDb, quoteIdent } = require('../server/db');

  try {
    if (schema) await sql.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  } catch {
    /* the pool may already be closed, or the schema never created */
  }

  try {
    await closeDb();
  } catch {
    /* nothing left to close */
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
  initTestDb,
  databaseUnavailable,
  cleanup,
  makeClient,
  uniqueEmail,
  GOOD_PASSWORD,
  VALID_ADDRESS,
  VALID_PHONE,
};

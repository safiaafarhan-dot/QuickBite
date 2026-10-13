'use strict';

/**
 * PostgreSQL access layer.
 *
 * One pool for the process, a `sql` helper that mirrors the three shapes the
 * old SQLite code used (`get`, `all`, `run`), and a transaction helper that
 * hands out a dedicated client — because in PostgreSQL a transaction lives on
 * one connection, and a statement sent to the pool mid-transaction would run
 * outside it on a different connection entirely.
 *
 * Nothing here runs at require time. The database is reached over a network
 * now, so `initDb()` must be awaited before the first query; `server/index.js`
 * does that before it listens, and the test harness does it before it starts a
 * server.
 */

const { Pool, types } = require('pg');

/* ------------------------------------------------------------------ */
/* Type parsing — keeping the wire format identical to SQLite's         */
/* ------------------------------------------------------------------ */

/*
 * `COUNT(*)` and `SUM(...)` come back as int8, and node-postgres returns int8
 * as a *string* because it can exceed Number.MAX_SAFE_INTEGER. Every caller
 * here treats those as numbers — `page.total`, `offset + limit < total`, the
 * analytics revenue figures — so a string would quietly corrupt arithmetic and
 * change the JSON the front end receives. Order counts and rupee totals are
 * nowhere near 2^53, so parsing them is safe.
 */
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

/*
 * Timestamps are the subtler one. SQLite stored them as the text
 * `'YYYY-MM-DD HH:MM:SS'` in UTC, and that exact string is what the API
 * returns, what `orderState.minutesSince()` parses, and what the order
 * timeline renders. node-postgres would hand back a JS Date, which serialises
 * as an ISO-8601 string with a timezone offset — a visible API change.
 *
 * The columns are real `TIMESTAMPTZ` (so date arithmetic in SQL is genuine);
 * only the representation handed to JavaScript is pinned to the old format.
 */
const pad = (n) => String(n).padStart(2, '0');

function formatUtcTimestamp(value) {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

types.setTypeParser(1114, formatUtcTimestamp); // timestamp without time zone
types.setTypeParser(1184, formatUtcTimestamp); // timestamp with time zone
types.setTypeParser(1082, (value) => value);   // date — already 'YYYY-MM-DD'

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

const CONNECTION_HELP = `
  ✗ DATABASE_URL is not set.

    QuickBite stores its data in PostgreSQL. Set a connection string, for
    example a Supabase pooler URL:

      DATABASE_URL=postgresql://USER:PASSWORD@HOST:6543/postgres

    Supabase → Project Settings → Database → Connection string → "Transaction"
    (port 6543) is the right one for a Render free web service.
`;

/**
 * Supabase and most managed providers terminate TLS with a certificate this
 * container has no root for. `sslmode=require` in the URL asks node-postgres
 * for TLS but still verifies, which fails; `rejectUnauthorized: false` keeps
 * the connection encrypted while accepting the provider's chain. Set
 * `PGSSL_STRICT=1` with `PGSSLROOTCERT` to verify properly.
 */
function sslFor(connectionString) {
  if (process.env.PGSSL_DISABLE === '1') return false;

  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString || '');
  if (local && process.env.PGSSL_FORCE !== '1') return false;

  if (process.env.PGSSL_STRICT === '1') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

let pool = null;
let ready = null;

/** The connection string in use, with any password redacted — safe to log. */
function describeConnection() {
  const url = process.env.DATABASE_URL || '';
  try {
    const u = new URL(url);
    const schema = process.env.DB_SCHEMA ? ` schema=${process.env.DB_SCHEMA}` : '';
    return `${u.hostname}:${u.port || 5432}${u.pathname}${schema}`;
  } catch {
    return 'postgres';
  }
}

/**
 * Builds the pool. Separate from `initDb()` so a caller can create the pool,
 * run DDL, and only then migrate.
 */
function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    const err = new Error('DATABASE_URL is not set.');
    err.help = CONNECTION_HELP;
    throw err;
  }

  /*
   * Every connection starts in the right schema, and it is set in the startup
   * packet rather than with a `SET` on the pool's 'connect' event: that event
   * fires while the client is already free to run queries, so the first real
   * query could race ahead of the `SET` and land in the wrong schema. Only the
   * test harness sets DB_SCHEMA — it is how suites stay isolated now that they
   * cannot each have their own file. Production uses the default schema and
   * passes no options at all.
   */
  const schema = process.env.DB_SCHEMA;

  pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    ...(schema ? { options: `-c search_path=${quoteIdent(schema)},public` } : {}),
    /*
     * Render's free tier runs one small instance and Supabase's free pooler
     * caps client connections, so a small pool is the right shape — and a
     * bounded queue means a connection storm surfaces as a slow request
     * rather than an exhausted database.
     */
    max: Number(process.env.PGPOOL_MAX) || 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS) || 15_000,
    application_name: 'quickbite',
  });

  /*
   * A pooled connection can be dropped by the provider at any time. Without a
   * listener this is an unhandled 'error' event, which takes the process down
   * — on Render that is a restart loop rather than a reconnect.
   */
  pool.on('error', (err) => {
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: 'error',
        scope: 'pg-pool',
        message: err.message,
      })
    );
  });

  return pool;
}

/** Quotes an identifier for interpolation where a placeholder is not allowed. */
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

/* ------------------------------------------------------------------ */
/* Query helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * The three result shapes the application uses. `exec` is bound either to the
 * pool or, inside a transaction, to that transaction's client.
 */
function bind(exec) {
  return {
    /** First row, or undefined — the old `stmt.get(...)`. */
    async get(text, params = []) {
      const { rows } = await exec(text, params);
      return rows[0];
    },
    /** Every row — the old `stmt.all(...)`. */
    async all(text, params = []) {
      const { rows } = await exec(text, params);
      return rows;
    },
    /**
     * A write. `rowCount` replaces SQLite's `changes`, and `rows[0]` carries
     * whatever the statement's RETURNING clause asked for.
     */
    async run(text, params = []) {
      const result = await exec(text, params);
      return { rowCount: result.rowCount, rows: result.rows, row: result.rows[0] };
    },
    /** Multi-statement DDL, where placeholders are not used. */
    async exec(text) {
      await exec(text, []);
    },
  };
}

const sql = bind((text, params) => getPool().query(text, params));

/**
 * Runs `fn` against one dedicated connection.
 *
 * Migrations need this and not the pool: `BEGIN`, `COMMIT` and
 * `pg_advisory_lock` are all session-scoped, so sending them through the pool
 * would start a transaction on one connection and the DDL on another.
 */
async function withClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(bind((text, params) => client.query(text, params)));
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a single transaction on one dedicated client.
 *
 * `fn` receives a `tx` with the same `get`/`all`/`run` shape, and **must** use
 * it for every statement — anything sent through the module-level `sql` would
 * take a different connection from the pool and commit on its own, outside the
 * transaction. Nesting re-uses the outer client via savepoints, so a helper
 * that opens a transaction can safely be called from inside one.
 */
async function transaction(fn) {
  const existing = currentTx();
  if (existing) return nestedTransaction(existing, fn);

  const client = await getPool().connect();
  const tx = bind((text, params) => client.query(text, params));
  tx.depth = 0;

  await client.query('BEGIN');
  try {
    const result = await withTx(tx, () => fn(tx));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection is already gone; the server rolls back for us */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function nestedTransaction(tx, fn) {
  const name = `sp_${(tx.depth += 1)}`;
  await tx.run(`SAVEPOINT ${name}`);
  try {
    const result = await fn(tx);
    await tx.run(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await tx.run(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  } finally {
    tx.depth -= 1;
  }
}

/*
 * The ambient transaction, so a nested `transaction()` call joins the one
 * already running instead of deadlocking against it on a second connection.
 * AsyncLocalStorage is what makes "ambient" safe under concurrent requests:
 * each request chain gets its own store.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const txStore = new AsyncLocalStorage();
const currentTx = () => txStore.getStore();
const withTx = (tx, fn) => txStore.run(tx, fn);

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * Connects, applies migrations, and brings the menu and coupons in line with
 * the source files. Safe to call repeatedly — the second call returns the same
 * promise, so concurrent callers share one initialisation.
 */
function initDb({ log = process.env.NODE_ENV !== 'test', seed = true } = {}) {
  if (ready) return ready;

  ready = (async () => {
    const { migrate } = require('./migrations');
    const { seedReferenceData } = require('./seedReference');

    getPool();

    if (process.env.DB_SCHEMA) {
      const schema = quoteIdent(process.env.DB_SCHEMA);
      await sql.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    }

    // One connection for the whole migration run — see `withClient`.
    await withClient((client) => migrate(client, { log }));

    if (seed) await seedReferenceData();
  })();

  return ready;
}

/** Closes the pool. Used by the test harness and on shutdown. */
async function closeDb() {
  if (!pool) return;
  const p = pool;
  pool = null;
  ready = null;
  await p.end();
}

module.exports = {
  sql,
  transaction,
  withClient,
  initDb,
  closeDb,
  getPool,
  quoteIdent,
  describeConnection,
  CONNECTION_HELP,
};

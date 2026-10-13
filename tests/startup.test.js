'use strict';

/**
 * Startup and configuration tests.
 *
 * These run the entry point as a real child process, because the behaviour
 * under test only happens when `server/index.js` is the main module — a
 * requiring test can never observe it.
 *
 * Both cases here were found during the production-readiness audit: a busy port
 * and a missing production secret each produced a raw stack trace instead of
 * something an operator could act on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { databaseUnavailable } = require('./helpers');

const ENTRY = path.join(__dirname, '..', 'server', 'index.js');

/*
 * Most of this file is about what the process prints before it ever reaches
 * the database, so it needs no PostgreSQL at all. The two cases that assert a
 * *successful* boot do, and they skip loudly without one.
 */
const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const skipWithoutDb = () =>
  (DB_URL ? {} : { skip: 'no test database — set TEST_DATABASE_URL to run the boot tests' });

/**
 * A connection string plus a schema of this test's own, so a spawned server
 * migrates into its own corner and never collides with a suite running
 * alongside it.
 */
function dbEnv(label) {
  return {
    DATABASE_URL: DB_URL,
    DB_SCHEMA: `qb_startup_${label}_${process.pid}`.toLowerCase(),
  };
}

/** Removes a schema a spawned server created. Best effort; never fails a test. */
async function dropSchema(schema) {
  if (!DB_URL || !schema) return;
  const { Client } = require('pg');
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } catch {
    /* a leftover test schema is harmless */
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Runs the server until it prints something conclusive, then kills it.
 *
 * The timeout is generous on purpose. A cold `node` spawn that also opens
 * SQLite and runs migrations can take several seconds, and `npm test`
 * runs every suite in parallel — including two that each drive a real
 * Chrome. At 15 s this gave up under that load and reported "the server
 * should have started" against empty output, which looks exactly like a
 * broken server and was in fact a busy machine.
 *
 * Nothing is being papered over: a server that genuinely refuses to start
 * exits immediately and is caught by the `exit` handler, not the timer.
 * A timeout is reported as a timeout so it can never be mistaken for a
 * real assertion failure.
 */
function startServer(env, { waitForExit = true, timeout = 45000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        output: stdout + stderr + (timedOut ? `\n[test harness] gave up after ${timeout}ms` : ''),
      });
    };

    child.stdout.on('data', (d) => {
      stdout += d;
      // When we only want to see that it booted, stop at the banner.
      if (!waitForExit && /running at http/.test(stdout)) finish(null);
    });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('exit', (code) => finish(code));

    const timer = setTimeout(() => finish(null, true), timeout);
  });
}

/**
 * Grabs a port, holds it, and hands it back so a clash can be forced.
 *
 * The host is deliberately left unspecified so the blocker binds the same
 * dual-stack wildcard address Express does — binding IPv4-only would not
 * actually collide on Windows.
 */
function occupyPort() {
  return new Promise((resolve) => {
    const blocker = net.createServer();
    blocker.listen(0, () => resolve({ port: blocker.address().port, blocker }));
  });
}

/**
 * Asks the OS for a free port, then immediately gives it back.
 *
 * The boot tests below used to pass `PORT=0`, meaning "any free port".
 * The server reads its port as `Number(process.env.PORT) || 3000`, and
 * `0` is falsy, so every one of them silently booted on 3000 instead —
 * including two that run back to back, where the first had not yet
 * released the socket when the second tried to bind it. That surfaced
 * as "the server should have started" against a real "port in use"
 * message, which is a confusing way to be told the tests were
 * colliding with each other.
 *
 * (The server's own handling of `PORT=0` is left alone. It is a genuine
 * wart, but changing it is outside what these tests need.)
 */
async function freePort() {
  const { port, blocker } = await occupyPort();
  await new Promise((resolve) => blocker.close(resolve));
  return port;
}

/* ================================================================== */

/*
 * This one needs a database even though it is about the port: the boot has to
 * get all the way past `initDb()` to reach `listen` and fail there. Without a
 * connection string the process exits earlier, on the missing DATABASE_URL,
 * and the assertion below fails for a reason that has nothing to do with the
 * port — so it skips loudly like the other database-backed cases rather than
 * reporting a false failure.
 */
test('a busy port is reported in plain language, not as a stack trace', skipWithoutDb(), async () => {
  const { port, blocker } = await occupyPort();
  /*
   * This boot gets far enough to migrate before `listen` fails, so it leaves a
   * schema behind like the successful cases do — and left unswept they pile up
   * one per run.
   */
  const env = dbEnv('busy');

  try {
    const result = await startServer({
      PORT: String(port),
      ...env,
      NODE_ENV: 'development',
    });

    assert.equal(result.code, 1, 'the process should exit non-zero');
    assert.match(result.output, /already in use/i, 'the operator is told the port is taken');
    assert.match(result.output, new RegExp(String(port)), 'the message names the port');
    assert.match(result.output, /PORT=\d+ npm start/, 'the message suggests a way forward');

    assert.doesNotMatch(result.output, /Unhandled 'error' event/, 'an unhandled error event leaked');
    assert.doesNotMatch(result.output, /at Server\.setupListenHandle/, 'a stack trace leaked');
  } finally {
    blocker.close();
    await dropSchema(env.DB_SCHEMA);
  }
});

test('production refuses to start without JWT_SECRET, and says why', async () => {
  const result = await startServer({
    NODE_ENV: 'production',
    PORT: String(await freePort()),
    ...dbEnv('nosecret'),
    JWT_SECRET: '',
  });

  assert.equal(result.code, 1, 'the process must refuse to start');
  assert.match(result.output, /JWT_SECRET/, 'the missing variable is named');
  assert.match(result.output, /NODE_ENV=production/, 'the condition is explained');
  assert.match(result.output, /randomBytes/, 'a way to generate one is offered');

  assert.doesNotMatch(result.output, /^\s+at .*\(.*:\d+:\d+\)$/m, 'a stack trace leaked');
  assert.doesNotMatch(result.output, /throw er/, 'an unhandled throw leaked');
});

test('production starts normally once JWT_SECRET is supplied', skipWithoutDb(), async () => {
  const env = dbEnv('ok');

  const result = await startServer({
    NODE_ENV: 'production',
    PORT: String(await freePort()),
    ...env,
    JWT_SECRET: 'a-test-only-secret-that-is-long-enough',
    PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret',
  }, { waitForExit: false });

  assert.equal(result.timedOut, false, `the server never printed anything: ${result.output}`);
  assert.match(result.output, /QuickBite running at/, 'the server should have started');
  assert.doesNotMatch(result.output, /Refusing to start/);

  await dropSchema(env.DB_SCHEMA);
});

/*
 * The counterpart to the JWT_SECRET check: the server now needs somewhere to
 * keep its data, and should say so in the same plain language rather than
 * failing somewhere inside the driver.
 */
test('a missing DATABASE_URL is explained, not thrown', async () => {
  const result = await startServer({
    NODE_ENV: 'development',
    PORT: String(await freePort()),
    DATABASE_URL: '',
    JWT_SECRET: 'a-test-only-secret-that-is-long-enough',
  });

  assert.equal(result.code, 1, 'the process must refuse to start');
  assert.match(result.output, /DATABASE_URL/, 'the missing variable is named');
  assert.match(result.output, /postgres/i, 'the operator is told what it wants');

  assert.doesNotMatch(result.output, /^\s+at .*\(.*:\d+:\d+\)$/m, 'a stack trace leaked');
});

/*
 * A connection string that parses but points nowhere must also be a readable
 * message. On Render a stale password or a paused database is exactly this
 * case, and a raw ECONNREFUSED in the deploy log helps nobody.
 */
test('an unreachable database is reported in plain language', async () => {
  const result = await startServer({
    NODE_ENV: 'development',
    PORT: String(await freePort()),
    // Port 1 is reserved and nothing listens there.
    DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/quickbite',
    JWT_SECRET: 'a-test-only-secret-that-is-long-enough',
  });

  assert.equal(result.code, 1, 'the process should exit non-zero');
  assert.match(result.output, /Could not reach the database/i, 'the operator is told what failed');
  assert.doesNotMatch(result.output, /UnhandledPromiseRejection/, 'an unhandled rejection leaked');
});

test('an unset payment webhook secret warns in production but does not block boot',
  skipWithoutDb(), async () => {
    const env = dbEnv('nowebhook');

    const result = await startServer({
      NODE_ENV: 'production',
      PORT: String(await freePort()),
      ...env,
      JWT_SECRET: 'a-test-only-secret-that-is-long-enough',
      PAYMENT_WEBHOOK_SECRET: '',
    }, { waitForExit: false });

    assert.equal(result.timedOut, false, `the server never printed anything: ${result.output}`);
    assert.match(result.output, /PAYMENT_WEBHOOK_SECRET is unset/, 'the operator is warned');
    assert.match(result.output, /QuickBite running at/, 'but the shop still opens');

    await dropSchema(env.DB_SCHEMA);
  });

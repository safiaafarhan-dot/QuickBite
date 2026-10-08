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

const ENTRY = path.join(__dirname, '..', 'server', 'index.js');

/** Runs the server until it prints something conclusive, then kills it. */
function startServer(env, { waitForExit = true, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ code, stdout, stderr, output: stdout + stderr });
    };

    child.stdout.on('data', (d) => {
      stdout += d;
      // When we only want to see that it booted, stop at the banner.
      if (!waitForExit && /running at http/.test(stdout)) finish(null);
    });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('exit', (code) => finish(code));

    const timer = setTimeout(() => finish(null), timeout);
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

/* ================================================================== */

test('a busy port is reported in plain language, not as a stack trace', async () => {
  const { port, blocker } = await occupyPort();

  try {
    const result = await startServer({
      PORT: String(port),
      DB_FILE: path.join(os.tmpdir(), `qb-startup-${process.pid}-busy.db`),
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
  }
});

test('production refuses to start without JWT_SECRET, and says why', async () => {
  const result = await startServer({
    NODE_ENV: 'production',
    PORT: '0',
    DB_FILE: path.join(os.tmpdir(), `qb-startup-${process.pid}-nosecret.db`),
    JWT_SECRET: '',
  });

  assert.equal(result.code, 1, 'the process must refuse to start');
  assert.match(result.output, /JWT_SECRET/, 'the missing variable is named');
  assert.match(result.output, /NODE_ENV=production/, 'the condition is explained');
  assert.match(result.output, /randomBytes/, 'a way to generate one is offered');

  assert.doesNotMatch(result.output, /^\s+at .*\(.*:\d+:\d+\)$/m, 'a stack trace leaked');
  assert.doesNotMatch(result.output, /throw er/, 'an unhandled throw leaked');
});

test('production starts normally once JWT_SECRET is supplied', async () => {
  const dbFile = path.join(os.tmpdir(), `qb-startup-${process.pid}-ok.db`);

  const result = await startServer({
    NODE_ENV: 'production',
    PORT: '0',                       // let the OS choose a free port
    DB_FILE: dbFile,
    JWT_SECRET: 'a-test-only-secret-that-is-long-enough',
    PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret',
  }, { waitForExit: false });

  assert.match(result.output, /QuickBite running at/, 'the server should have started');
  assert.doesNotMatch(result.output, /Refusing to start/);

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
});

test('an unset payment webhook secret warns in production but does not block boot', async () => {
  const dbFile = path.join(os.tmpdir(), `qb-startup-${process.pid}-nowebhook.db`);

  const result = await startServer({
    NODE_ENV: 'production',
    PORT: '0',
    DB_FILE: dbFile,
    JWT_SECRET: 'a-test-only-secret-that-is-long-enough',
    PAYMENT_WEBHOOK_SECRET: '',
  }, { waitForExit: false });

  assert.match(result.output, /PAYMENT_WEBHOOK_SECRET is unset/, 'the operator is warned');
  assert.match(result.output, /QuickBite running at/, 'but the shop still opens');

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
});

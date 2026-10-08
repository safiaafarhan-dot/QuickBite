'use strict';

/**
 * Real-browser regression tests, driven through playwright-core against the
 * Chrome already installed on the machine.
 *
 * These exist because jsdom cannot catch layout and cascade faults. Every test
 * here guards a defect that the jsdom suite passed straight through:
 *
 *   · `element.hidden = true` doing nothing, because an author `display` rule
 *     outranks the user-agent `[hidden]` rule
 *   · the page scrolling sideways on a phone
 *
 * If Chrome or playwright-core is unavailable the whole suite SKIPS rather than
 * fails, so `npm test` still works on a machine without a browser. A skip is
 * reported as a skip — it is never counted as a pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prepareEnvironment, cleanup, makeClient,
  GOOD_PASSWORD, VALID_ADDRESS, VALID_PHONE,
} = require('./helpers');

const DB_FILE = prepareEnvironment('browser');

const app = require('../server/index');
const { hashPassword } = require('../server/auth');
const { db } = require('../server/db');

/* ------------------------------------------------------------------ */
/* Availability check                                                  */
/* ------------------------------------------------------------------ */

let chromium = null;
let unavailable = null;

try {
  ({ chromium } = require('playwright-core'));
} catch {
  unavailable = 'playwright-core is not installed (npm i -D playwright-core)';
}

let server;
let base;
let browser;
const call = makeClient(() => base);

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  db.prepare('INSERT INTO users (name, email, password_hash, phone, address, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('Browser Tester', 'browser@test.local', await hashPassword(GOOD_PASSWORD), VALID_PHONE, VALID_ADDRESS, 'customer');
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run('Browser Admin', 'browseradmin@test.local', await hashPassword('adminpass1'), 'admin');

  if (chromium) {
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch (err) {
      unavailable = `Chrome could not be launched: ${err.message.split('\n')[0]}`;
    }
  }

  if (unavailable) {
    console.log(`\n  ⊘ Browser tests skipped — ${unavailable}\n`);
  }
});

test.after(async () => {
  await browser?.close();
  server?.close();
  db.close();
  cleanup(DB_FILE);
});

/** Opens a page at a given viewport, optionally already signed in. */
async function open(viewport, { token, page: file = 'index.html' } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  if (token) {
    await page.addInitScript((t) => window.localStorage.setItem('qb_token', t), token);
  }

  await page.goto(`${base}/${file}`, { waitUntil: 'networkidle' });
  return { context, page };
}

async function tokenFor(email, password) {
  const { body } = await call('POST', '/api/auth/login', { body: { email, password } });
  return body.token;
}

/** Shared skip guard — keeps every test honest about why it did not run. */
const skipIf = () => (unavailable ? { skip: unavailable } : {});

/* ================================================================== */
/* Regression: [hidden] must actually hide                             */
/* ================================================================== */

test('an element marked hidden is genuinely not rendered', skipIf(), async () => {
  const { context, page } = await open({ width: 1440, height: 900 });
  await page.waitForSelector('.dish');

  // Probe one of each styling family that the scripts toggle with `.hidden`.
  const result = await page.evaluate(() => {
    const probe = document.createElement('div');
    document.body.appendChild(probe);

    const families = ['btn', 'chips', 'admin-grid', 'badge', 'dropdown', 'rail'];
    const out = {};

    for (const cls of families) {
      probe.className = cls;
      probe.hidden = true;
      out[cls] = {
        display: getComputedStyle(probe).display,
        rects: probe.getClientRects().length,
      };
    }

    probe.remove();
    return out;
  });

  for (const [cls, state] of Object.entries(result)) {
    assert.equal(state.display, 'none', `.${cls}[hidden] must compute to display:none, got ${state.display}`);
    assert.equal(state.rects, 0, `.${cls}[hidden] must not be laid out`);
  }

  await context.close();
});

test('signing in actually removes the sign-in button from the page', skipIf(), async () => {
  const { context, page } = await open({ width: 1440, height: 900 });
  await page.waitForSelector('.dish');

  await page.locator('#signInBtn').click();
  await page.fill('#authForm input[name=email]', 'browser@test.local');
  await page.fill('#authForm input[name=password]', GOOD_PASSWORD);
  await page.locator('#authSubmit').click();
  await page.waitForSelector('#accountMenu:not([hidden])', { timeout: 10000 });

  // `hidden` being true is not enough — it has to be off the screen.
  assert.equal(
    await page.locator('#signInBtn').isVisible(), false,
    'the Sign in button is still rendered after signing in'
  );
  assert.equal(await page.locator('#accountTrigger').isVisible(), true);

  await context.close();
});

test('a customer is never shown the kitchen link', skipIf(), async () => {
  const token = await tokenFor('browser@test.local', GOOD_PASSWORD);
  const { context, page } = await open({ width: 1440, height: 900 }, { token });
  await page.waitForSelector('.dish');
  await page.waitForTimeout(400);

  const links = page.locator('.admin-link');
  const count = await links.count();
  for (let i = 0; i < count; i++) {
    assert.equal(
      await links.nth(i).isVisible(), false,
      'a customer can see a link to the kitchen dashboard'
    );
  }

  await context.close();
});

test('the admin tabs show one view at a time', skipIf(), async () => {
  const token = await tokenFor('browseradmin@test.local', 'adminpass1');
  const { context, page } = await open({ width: 1440, height: 900 }, { token, page: 'admin.html' });

  await page.waitForSelector('.stat-card', { timeout: 10000 });

  assert.equal(await page.locator('#viewOperations').isVisible(), true);
  assert.equal(await page.locator('#viewAnalytics').isVisible(), false, 'both admin views are showing at once');

  await page.locator('[data-view="analytics"]').click();
  await page.waitForTimeout(600);

  assert.equal(await page.locator('#viewOperations').isVisible(), false, 'the operations view did not go away');
  assert.equal(await page.locator('#viewAnalytics').isVisible(), true);

  await context.close();
});

/* ================================================================== */
/* Regression: no sideways scrolling                                   */
/* ================================================================== */

for (const vp of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'small mobile', width: 320, height: 568 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
]) {
  test(`the page does not scroll sideways at ${vp.name} (${vp.width}px)`, skipIf(), async () => {
    const { context, page } = await open({ width: vp.width, height: vp.height });
    await page.waitForSelector('.dish');
    await page.waitForTimeout(400);

    const measure = () => page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      widest: [...document.querySelectorAll('body *')]
        .filter((n) => {
          const s = getComputedStyle(n);
          if (s.overflowX === 'auto' || s.overflowX === 'scroll') return false;
          // Ignore anything inside a legitimately scrollable strip.
          for (let p = n.parentElement; p; p = p.parentElement) {
            const ps = getComputedStyle(p);
            if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') return false;
          }
          return n.getBoundingClientRect().width > document.documentElement.clientWidth + 1;
        })
        .slice(0, 3)
        .map((n) => `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ')[0]}`),
    }));

    const home = await measure();
    assert.ok(
      home.scrollW <= home.clientW + 1,
      `home scrolls sideways: ${home.scrollW} > ${home.clientW}; widest: ${home.widest.join(', ')}`
    );

    // The menu section carries the chip strip and the filter rows, which is
    // where the overflow actually came from.
    await page.locator('#menu').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const menu = await measure();
    assert.ok(
      menu.scrollW <= menu.clientW + 1,
      `menu scrolls sideways: ${menu.scrollW} > ${menu.clientW}; widest: ${menu.widest.join(', ')}`
    );

    await context.close();
  });
}

test('the orders and admin pages do not scroll sideways on a phone', skipIf(), async () => {
  const customer = await tokenFor('browser@test.local', GOOD_PASSWORD);
  const admin = await tokenFor('browseradmin@test.local', 'adminpass1');

  for (const [file, token] of [['orders.html', customer], ['admin.html', admin]]) {
    const { context, page } = await open({ width: 390, height: 844 }, { token, page: file });
    await page.waitForTimeout(1500);

    const { scrollW, clientW } = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    assert.ok(scrollW <= clientW + 1, `${file} scrolls sideways: ${scrollW} > ${clientW}`);

    await context.close();
  }
});

/* ================================================================== */
/* Regression: no console errors or failed requests on a clean load    */
/* ================================================================== */

test('loading each page produces no console errors or failed requests', skipIf(), async () => {
  const token = await tokenFor('browseradmin@test.local', 'adminpass1');
  const problems = [];

  for (const file of ['index.html', 'orders.html', 'admin.html', '404-check']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript((t) => window.localStorage.setItem('qb_token', t), token);

    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // The deliberate 404 probe is expected to log a failed-resource error.
      if (file === '404-check' && /Failed to load resource/.test(m.text())) return;
      problems.push(`${file}: console ${m.text().slice(0, 120)}`);
    });
    page.on('pageerror', (e) => problems.push(`${file}: exception ${e.message.slice(0, 120)}`));
    page.on('response', (r) => {
      // The deliberate 404 probe is expected to 404.
      if (r.status() >= 400 && !r.url().includes('404-check')) {
        problems.push(`${file}: ${r.status()} ${r.url().replace(base, '')}`);
      }
    });

    await page.goto(`${base}/${file}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(1200);
    await context.close();
  }

  assert.deepEqual(problems, [], `browser reported problems:\n  ${problems.join('\n  ')}`);
});

/* ================================================================== */
/* Regression: every dish photo decodes                                */
/* ================================================================== */

test('every dish image on the menu actually decodes', skipIf(), async () => {
  const { context, page } = await open({ width: 1440, height: 900 });
  await page.waitForSelector('.dish');

  // Scroll the whole grid so lazy-loaded images are requested.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 90));
    }
  });
  await page.waitForTimeout(1500);

  const report = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.dish img')];
    return {
      total: imgs.length,
      broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')),
      placeholders: imgs.filter((i) => (i.currentSrc || '').includes('placeholder')).map((i) => i.alt),
      tiny: imgs.filter((i) => i.naturalWidth > 0 && i.naturalWidth < 600).map((i) => `${i.alt} (${i.naturalWidth}px)`),
    };
  });

  assert.equal(report.total, 30, 'all 30 dishes rendered');
  assert.deepEqual(report.broken, [], 'some dish photos failed to load');
  assert.deepEqual(report.placeholders, [], 'some dishes fell back to the placeholder');
  assert.deepEqual(report.tiny, [], 'some dish photos are too small to render crisply');

  await context.close();
});

/* ================================================================== */
/* Regression: the CSP must not disable our own code                   */
/* ================================================================== */

test('a failed dish photo falls back to the placeholder', skipIf(), async () => {
  const { context, page } = await open({ width: 1440, height: 900 });

  // Make one photo 404 so the fallback has to run. This previously relied on an
  // inline `onerror` attribute, which `script-src 'self'` silently blocked.
  await page.route('**/images/dishes/margherita-pizza.jpg', (r) => r.fulfill({ status: 404, body: '' }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dish');
  await page.waitForTimeout(1200);

  const state = await page.evaluate(() => {
    const img = [...document.querySelectorAll('.dish img')].find((i) => i.alt === 'Classic Margherita Pizza');
    return { src: img.getAttribute('src'), width: img.naturalWidth };
  });

  assert.match(state.src, /placeholder\.svg$/, 'the placeholder did not replace the broken photo');
  assert.ok(state.width > 0, 'the placeholder itself failed to decode');

  await context.close();
});

test('no page triggers a Content-Security-Policy violation', skipIf(), async () => {
  const token = await tokenFor('browseradmin@test.local', 'adminpass1');
  const violations = [];

  for (const file of ['index.html', 'orders.html', 'admin.html', 'no-such-page']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript((t) => window.localStorage.setItem('qb_token', t), token);
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(`${file}: ${m.text().slice(0, 110)}`);
    });

    await page.goto(`${base}/${file}`, { waitUntil: 'networkidle' }).catch(() => {});
    // Force an image error too, so the fallback path is exercised under the CSP.
    await page.evaluate(() => {
      const img = document.querySelector('img');
      if (img) img.src = '/definitely-not-here.png';
    });
    await page.waitForTimeout(900);
    await context.close();
  }

  assert.deepEqual(violations, [], 'CSP violations: ' + violations.join(' | '));
});

test('the 404 page still applies the saved theme', skipIf(), async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => window.localStorage.setItem('qb_theme', 'dark'));

  await page.goto(`${base}/no-such-page`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme), 'dark',
    'the 404 page ignored the saved theme — its boot script did not run'
  );

  await context.close();
});

/* ================================================================== */
/* Regression: the analytics charts must actually draw                 */
/* ================================================================== */

test('the admin bar charts render with real heights, not a flat line', skipIf(), async () => {
  // Give the charts something with shape to draw: orders at three different
  // hours, with different volumes, so bars of equal height would be a bug.
  const customer = db.prepare('SELECT id FROM users WHERE email = ?').get('browser@test.local');
  const insert = db.prepare(`
    INSERT INTO orders (code, user_id, status, subtotal, discount, delivery_fee, tax, total,
                        customer_name, phone, address, payment_method, payment_status,
                        eta_minutes, auto_advance, placed_at, updated_at)
    VALUES (?, ?, 'delivered', 500, 0, 0, 25, 525, 'Browser Tester', ?, ?, 'cod', 'on_delivery',
            35, 0, ?, ?)
  `);

  let n = 0;
  for (const [hour, count] of [[12, 1], [13, 3], [20, 2]]) {
    for (let i = 0; i < count; i++) {
      const at = `2025-01-0${(i % 3) + 1} ${String(hour).padStart(2, '0')}:15:00`;
      insert.run(`QB-CHART${n++}`, customer.id, VALID_PHONE, VALID_ADDRESS, at, at);
    }
  }

  const token = await tokenFor('browseradmin@test.local', 'adminpass1');
  const { context, page } = await open({ width: 1440, height: 900 }, { token, page: 'admin.html' });

  await page.waitForSelector('.stat-card', { timeout: 10000 });
  await page.locator('[data-view="analytics"]').click();
  await page.waitForSelector('#hourChart .bars', { timeout: 10000 });
  await page.waitForTimeout(1200);

  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('#hourChart .bar')]
      .map((b) => Math.round(parseFloat(getComputedStyle(b).height))));

  assert.ok(heights.length > 0, 'the hourly chart drew no bars at all');

  // A percentage height only resolves against a definite container height. When
  // that is missing every bar collapses to its 3px min-height and the chart
  // silently becomes a flat line, which is what this guards against.
  assert.ok(
    Math.max(...heights) > 20,
    `every bar collapsed to its min-height: ${heights.join(', ')}`
  );
  assert.ok(
    new Set(heights).size > 1,
    `all bars are the same height, so the chart carries no information: ${heights.join(', ')}`
  );

  await context.close();
});

/* ================================================================== */
/* Regression: keyboard access                                         */
/* ================================================================== */

test('the cart drawer is reachable and dismissable by keyboard', skipIf(), async () => {
  const { context, page } = await open({ width: 1440, height: 900 });
  await page.waitForSelector('.dish');

  await page.locator('#cartBtn').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#cartDrawer').isVisible(), true);

  // Focus must land inside the drawer, not be left behind on the page.
  const focusInside = await page.evaluate(() =>
    document.getElementById('cartDrawer').contains(document.activeElement));
  assert.equal(focusInside, true, 'focus did not move into the drawer');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#cartDrawer.is-open').count(), 0, 'Escape did not close the drawer');

  await context.close();
});

test('the skip link becomes visible when focused', skipIf(), async () => {
  const { context, page } = await open({ width: 1440, height: 900 });
  await page.waitForSelector('.dish');

  const before = await page.locator('.skip-link').boundingBox();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(350);
  const after = await page.locator('.skip-link').boundingBox();

  assert.ok(before.y < 0, 'the skip link should start off-screen');
  assert.ok(after.y >= 0, 'the skip link should move on-screen when focused');

  await context.close();
});

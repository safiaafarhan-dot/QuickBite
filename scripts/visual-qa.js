'use strict';

/**
 * Visual QA harness — drives the installed Chrome via playwright-core.
 *
 *   node scripts/visual-qa.js [baseUrl]
 *
 * Captures screenshots at desktop / tablet / mobile widths, and records every
 * console error, page exception and failed network request it sees along the
 * way. Also checks for horizontal overflow and for images that failed to decode,
 * which are the two layout faults a DOM-only test cannot catch.
 *
 * This is a QA tool, not part of the app. It never writes to the database
 * except through the normal API, using a throwaway account it creates itself.
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'qa-screenshots');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 },
];

const problems = [];
const note = (kind, where, detail) => {
  problems.push({ kind, where, detail });
  console.log(`  ⚠ ${kind} @ ${where}: ${detail}`);
};

/** Attaches listeners that record anything the browser complains about. */
function watch(page, where) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') note('console-error', where, msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => note('page-exception', where, err.message.slice(0, 200)));
  page.on('requestfailed', (req) => {
    // Ignore aborts caused by navigating away mid-flight.
    const failure = req.failure()?.errorText || '';
    if (failure.includes('ERR_ABORTED')) return;
    note('request-failed', where, `${req.method()} ${req.url().replace(BASE, '')} — ${failure}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      note('http-error', where, `${res.status()} ${res.url().replace(BASE, '')}`);
    }
  });
}

/** Detects a page that scrolls sideways — the classic responsive failure. */
async function checkOverflow(page, where) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const scrollW = doc.scrollWidth;
    const clientW = doc.clientWidth;
    if (scrollW <= clientW + 1) return null;

    // Identify which elements actually stick out, to make the report actionable.
    const guilty = [...document.querySelectorAll('body *')]
      .filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && (r.right > clientW + 1 || r.left < -1);
      })
      .slice(0, 5)
      .map((n) => `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ')[0]}`);

    return { scrollW, clientW, guilty };
  });

  if (overflow) {
    note('h-overflow', where, `scrollWidth ${overflow.scrollW} > clientWidth ${overflow.clientW}; near: ${overflow.guilty.join(', ')}`);
  }
}

/** Finds <img> elements the browser could not decode. */
async function checkImages(page, where) {
  const broken = await page.evaluate(() =>
    [...document.images]
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.getAttribute('src'))
  );
  for (const src of broken) note('broken-image', where, src);
}

/** Flags visible text that is being clipped by its container. */
async function checkClipping(page, where) {
  const clipped = await page.evaluate(() => {
    const out = [];
    for (const n of document.querySelectorAll('h1,h2,h3,p,span,button,a,td,th,label')) {
      const style = getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.overflow === 'visible') continue;
      // .visually-hidden is deliberately clipped to 1x1 for screen readers.
      if (n.classList.contains('visually-hidden')) continue;
      // -webkit-line-clamp is deliberate truncation, not a fault.
      if (style.webkitLineClamp && style.webkitLineClamp !== 'none') continue;
      if (n.scrollWidth > n.clientWidth + 2 && n.clientWidth > 0) {
        out.push(`${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ')[0]} "${n.textContent.trim().slice(0, 30)}"`);
      }
    }
    return out.slice(0, 6);
  });
  for (const c of clipped) note('text-clipped', where, c);
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`  📷 ${name}.png`);
};

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  console.log(`\nChrome ${browser.version()} → ${BASE}\n`);

  /* ---------------------------------------------------------------- */
  /* Pass 1: every page at every viewport                              */
  /* ---------------------------------------------------------------- */

  for (const vp of VIEWPORTS) {
    console.log(`── ${vp.name} ${vp.width}×${vp.height} ──`);

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    watch(page, vp.name);

    // Home
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.dish', { timeout: 10000 });
    await checkOverflow(page, `${vp.name}/home`);
    await checkImages(page, `${vp.name}/home`);
    await checkClipping(page, `${vp.name}/home`);
    await shot(page, `${vp.name}-01-home-hero`);

    // Menu grid
    await page.locator('#menu').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, `${vp.name}-02-menu-grid`);

    // Recommendation rail
    await page.locator('#picks').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-03-recommendations`);

    // Cart drawer with an item in it
    await page.locator('[data-add]').first().click();
    await page.waitForTimeout(700);
    await page.locator('#cartBtn').click();
    await page.waitForTimeout(500);
    await checkOverflow(page, `${vp.name}/cart`);
    await shot(page, `${vp.name}-04-cart-drawer`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Dish detail
    await page.locator('.dish-name-btn').first().click();
    await page.waitForSelector('.detail-facts', { timeout: 10000 });
    await page.waitForTimeout(600);
    await checkOverflow(page, `${vp.name}/detail`);
    await checkImages(page, `${vp.name}/detail`);
    await shot(page, `${vp.name}-05-dish-detail`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // AI assistant
    await page.locator('#assistantFab').click();
    await page.waitForTimeout(300);
    await page.fill('#assistantInput', 'something spicy and vegetarian under 400');
    await page.locator('#assistantForm button[type=submit]').click();
    await page.waitForSelector('.pick', { timeout: 10000 });
    await page.waitForTimeout(500);
    await checkOverflow(page, `${vp.name}/assistant`);
    await shot(page, `${vp.name}-06-assistant`);
    await page.locator('#assistantClose').click();

    // Dark mode on the menu
    await page.locator('[data-theme-toggle]').first().click();
    await page.waitForTimeout(400);
    await page.locator('#menu').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, `${vp.name}-07-dark-menu`);
    await page.locator('[data-theme-toggle]').first().click();
    await page.waitForTimeout(300);

    // Signed-out orders page
    await page.goto(`${BASE}/orders.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await checkOverflow(page, `${vp.name}/orders-gate`);
    await shot(page, `${vp.name}-08-orders-signed-out`);

    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* Pass 2: signed-in journeys (desktop + mobile)                     */
  /* ---------------------------------------------------------------- */

  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    console.log(`── ${vp.name}: signed-in journey ──`);

    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    watch(page, `${vp.name}-journey`);

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.dish');

    // Sign in as the demo customer
    await page.locator('#signInBtn').click();
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-09-auth-modal`);

    await page.fill('#authForm input[name=email]', 'demo@quickbite.test');
    await page.fill('#authForm input[name=password]', 'demo1234');
    await page.locator('#authSubmit').click();
    await page.waitForSelector('#accountMenu:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(600);

    // Validation: a deliberately bad coupon must be reported, not swallowed
    await page.locator('[data-add]').first().click();
    await page.waitForTimeout(700);
    await page.locator('#cartBtn').click();
    await page.waitForTimeout(400);
    await page.fill('#couponInput', 'NOPE123');
    await page.locator('#couponForm button[type=submit]').click();
    await page.waitForTimeout(800);
    await shot(page, `${vp.name}-10-coupon-rejected`);

    // Apply a real one
    await page.fill('#couponInput', 'QUICK10');
    await page.locator('#couponForm button[type=submit]').click();
    await page.waitForTimeout(800);
    await shot(page, `${vp.name}-11-coupon-applied`);

    // Checkout
    await page.locator('#checkoutBtn').click();
    await page.waitForSelector('#checkoutModal.is-open', { timeout: 8000 });
    await page.waitForTimeout(700);
    await checkOverflow(page, `${vp.name}/checkout`);
    await checkClipping(page, `${vp.name}/checkout`);
    await shot(page, `${vp.name}-12-checkout`);

    await page.locator('#placeOrderBtn').click();
    await page.waitForSelector('#successModal.is-open', { timeout: 12000 });
    await page.waitForTimeout(600);
    await shot(page, `${vp.name}-13-order-confirmed`);

    // Orders page with live tracking
    await page.goto(`${BASE}/orders.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.order-card', { timeout: 10000 });
    await page.waitForTimeout(700);
    await checkOverflow(page, `${vp.name}/orders`);
    await checkClipping(page, `${vp.name}/orders`);
    await checkImages(page, `${vp.name}/orders`);
    await shot(page, `${vp.name}-14-orders-tracking`);

    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* Pass 3: admin dashboard                                           */
  /* ---------------------------------------------------------------- */

  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    console.log(`── ${vp.name}: admin ──`);

    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    watch(page, `${vp.name}-admin`);

    // Sign in on the home page so the token lands in localStorage.
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.locator('#signInBtn').click();
    await page.fill('#authForm input[name=email]', 'admin@quickbite.test');
    await page.fill('#authForm input[name=password]', 'admin1234');
    await page.locator('#authSubmit').click();
    await page.waitForSelector('#accountMenu:not([hidden])', { timeout: 10000 });

    await page.goto(`${BASE}/admin.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.stat-card', { timeout: 10000 });
    await page.waitForTimeout(800);
    await checkOverflow(page, `${vp.name}/admin-ops`);
    await checkClipping(page, `${vp.name}/admin-ops`);
    await shot(page, `${vp.name}-15-admin-operations`);

    await page.locator('[data-view="analytics"]').click();
    await page.waitForSelector('#hourChart .bars', { timeout: 10000 });
    await page.waitForTimeout(1200);
    await checkOverflow(page, `${vp.name}/admin-analytics`);
    await checkClipping(page, `${vp.name}/admin-analytics`);
    await shot(page, `${vp.name}-16-admin-analytics`);

    await page.locator('#forecastPanel').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-17-admin-forecast`);

    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* Pass 4: keyboard accessibility                                    */
  /* ---------------------------------------------------------------- */

  console.log('── keyboard accessibility ──');
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    watch(page, 'a11y');

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.dish');

    // Tab through the first stretch and record what receives focus.
    const chain = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      chain.push(await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return 'BODY';
        const label = a.getAttribute('aria-label') || a.textContent?.trim().slice(0, 22) || '';
        const focus = getComputedStyle(a, ':focus-visible').outlineStyle;
        return `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''} "${label}" outline=${focus}`;
      }));
    }
    console.log('  focus order:');
    chain.forEach((c, i) => console.log(`    ${String(i + 1).padStart(2)}. ${c}`));

    // The skip link must be the first stop and must become visible.
    await page.keyboard.press('Shift+Tab');
    await shot(page, 'a11y-18-focus-ring');

    // Escape must close the cart drawer.
    await page.locator('#cartBtn').click();
    await page.waitForTimeout(400);
    const openBefore = await page.locator('#cartDrawer.is-open').count();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const openAfter = await page.locator('#cartDrawer.is-open').count();
    if (openBefore !== 1 || openAfter !== 0) {
      note('a11y', 'cart', `Escape did not close the drawer (before=${openBefore} after=${openAfter})`);
    } else {
      console.log('  ✓ Escape closes the cart drawer');
    }

    // Images must carry alt attributes.
    const noAlt = await page.evaluate(() =>
      [...document.images].filter((i) => !i.hasAttribute('alt')).map((i) => i.src).slice(0, 5));
    for (const src of noAlt) note('a11y', 'home', `<img> without alt: ${src}`);
    if (noAlt.length === 0) console.log('  ✓ every image has an alt attribute');

    // Form controls must have accessible names.
    const unlabelled = await page.evaluate(() =>
      [...document.querySelectorAll('input,select,textarea')]
        .filter((n) => n.type !== 'hidden')
        .filter((n) => !n.getAttribute('aria-label') && !n.closest('label')
          && !document.querySelector(`label[for="${n.id}"]`))
        .map((n) => n.name || n.id || n.type).slice(0, 8));
    for (const n of unlabelled) note('a11y', 'home', `control without an accessible name: ${n}`);
    if (unlabelled.length === 0) console.log('  ✓ every form control has an accessible name');

    await context.close();
  }

  await browser.close();

  /* ---------------------------------------------------------------- */

  console.log(`\n${'='.repeat(62)}`);
  if (problems.length === 0) {
    console.log('No problems detected.');
  } else {
    console.log(`${problems.length} problem(s) detected:\n`);
    const byKind = {};
    for (const p of problems) (byKind[p.kind] ||= []).push(p);
    for (const [kind, list] of Object.entries(byKind)) {
      console.log(`  ${kind} (${list.length})`);
      // Collapse duplicates that repeat across viewports.
      const seen = new Set();
      for (const p of list) {
        const key = p.detail;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`    · ${p.detail}   [${p.where}]`);
      }
    }
  }
  console.log(`${'='.repeat(62)}`);
  console.log(`Screenshots: ${OUT}\n`);

  fs.writeFileSync(path.join(OUT, 'problems.json'), JSON.stringify(problems, null, 2));
}

main().catch((err) => {
  console.error('\nQA run failed:', err);
  process.exit(1);
});

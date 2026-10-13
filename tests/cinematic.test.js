'use strict';

/**
 * Real-browser tests for the cinematic 3D hero.
 *
 * The central claim about this feature — "the burger's position and
 * rotation are genuinely linked to scroll progress" — cannot be shown by
 * a screenshot and cannot be shown in jsdom, which has no WebGL, no
 * layout and no scrolling. So the scene exposes its real rig values on
 * `window.__qbHero`, and these tests read them at a series of scroll
 * offsets. A one-shot "animate when visible" reveal would pass a naive
 * "did it move?" check, so the decisive test here scrubs *backwards* and
 * asserts the pose returns to where it was.
 *
 * Every other test in this file guards a defect that was actually
 * present during development and was caught by looking at the rendered
 * page rather than at the code.
 *
 * As with tests/browser.test.js, the suite SKIPS — loudly — when Chrome
 * or playwright-core is unavailable. A skip is never counted as a pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { prepareEnvironment, initTestDb, databaseUnavailable, cleanup } = require('./helpers');


/*
 * These suites need a real PostgreSQL. Without one they skip loudly rather
 * than failing or, worse, silently passing — the same contract this file
 * already uses when Chrome is unavailable.
 */
const dbUnavailable = databaseUnavailable();
if (dbUnavailable) {
  console.log(`\n  ⊘ Cinematic tests skipped — ${dbUnavailable}\n`);
  test('Cinematic suite needs a PostgreSQL test database', { skip: dbUnavailable }, () => {});
  return;
}

const SCHEMA = prepareEnvironment('cinematic');

const app = require('../server/index');
const { sql } = require('../server/db');

/* ------------------------------------------------------------------ */
/* Availability                                                        */
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

test.before(async () => {
  await initTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  /*
   * Scene 6 reads real reviews, and this suite's database is a fresh
   * one with none in it — so the section correctly renders nothing and
   * there is nothing to assert about. Three reviewers across four
   * dishes gives the carousel something true to show, and exercises
   * the round-robin that stops one name repeating down the rail.
   */
  const items = await sql.all('SELECT id FROM menu_items ORDER BY id LIMIT 4');
  const INSERT_USER =
    'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id';
  const INSERT_REVIEW =
    'INSERT INTO reviews (user_id, item_id, rating, comment) VALUES ($1, $2, $3, $4)';

  const voices = [
    ['Review One', 'Arrived hot and exactly as described.'],
    ['Review Two', 'Generous portion, and the packaging held up.'],
    ['Review Three', 'Ordered it twice in a week, which says enough.'],
  ];

  for (const [v, [name, comment]] of voices.entries()) {
    const { row } = await sql.run(INSERT_USER, [name, `review${v}@test.local`, 'x']);
    // Two dishes each, so the rail has to alternate between authors.
    for (const offset of [0, 1]) {
      const item = items[(v + offset * 2) % items.length];
      if (item) await sql.run(INSERT_REVIEW, [row.id, item.id, 4 + (v % 2), comment]);
    }
  }

  if (chromium) {
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch (err) {
      unavailable = `Chrome could not be launched: ${err.message.split('\n')[0]}`;
    }
  }

  if (unavailable) {
    console.log(`\n  ⊘ Cinematic 3D tests skipped — ${unavailable}\n`);
  }
});

test.after(async () => {
  await browser?.close();
  server?.close();
  await cleanup(SCHEMA);
});

const skipIf = () => (unavailable ? { skip: unavailable } : {});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Opens the home page and waits for the 3D scene to commit. */
async function openScene(viewport = { width: 1440, height: 900 }, options = {}) {
  const context = await browser.newContext({ viewport, ...options });
  const page = await context.newPage();

  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));

  await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
  return { context, page, problems };
}

async function waitForScene(page) {
  await page.waitForFunction(() => !!window.__qbHero, null, { timeout: 20000 });
  // Let the opening rise finish so it is not confused with scroll motion.
  await page.waitForFunction(() => window.__qbHero.intro() > 0.999, null, { timeout: 20000 });
}

/** Waits for the Scene 2 and Scene 3 content and their choreography. */
async function waitForScenes(page) {
  await page.waitForSelector('.flavour', { timeout: 20000 });
  await page.waitForSelector('#featured:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() => !!window.__qbMotion, null, { timeout: 20000 });
}

/**
 * Parks a section at a fraction down the viewport and lets the scrub
 * settle. Scrolling by document fraction would land on a different part
 * of the story at every viewport, because the page is a different height
 * at each one.
 */
async function park(page, selector, fraction) {
  await page.evaluate(([sel, f]) => {
    const el = document.querySelector(sel);
    const y = window.scrollY + el.getBoundingClientRect().top - window.innerHeight * f;
    window.scrollTo(0, Math.max(0, Math.round(y)));
  }, [selector, fraction]);

  await settlePose(page);
}

/**
 * Parks at a fraction through one of the scene's own scroll ranges.
 *
 * Scene 3 is pinned, so its element rectangle no longer moves with the
 * scroll — `park()` reads that rectangle and would simply refuse to go
 * anywhere. The acts report their real scroll offsets, so address them
 * by those instead.
 */
async function parkInAct(page, act, t) {
  await page.evaluate(([name, f]) => {
    const r = window.__qbHero.ranges()[name];
    window.scrollTo(0, Math.round(r.start + (r.end - r.start) * f));
  }, [act, t]);

  await settlePose(page);
}

/**
 * Waits for the scrubbed poses to stop moving.
 *
 * Both poses are pure functions of scroll offset, so unlike the
 * rendered transforms — which carry a deliberate idle drift — they do
 * settle and can be used to detect stillness. A flat delay instead of
 * this sampled the scene up to half a scrub period early, and reported
 * differences of a few hundredths as "it did not rewind".
 */
async function settlePose(page) {
  const read = () => page.evaluate(() => ({
    burger: window.__qbHero.pose(),
    pizza: window.__qbHero.pizza().pose,
    // The DOM choreography scrubs on its own clock and settles later.
    motion: window.__qbMotion ? window.__qbMotion.progress() : [],
  }));

  const same = (a, b) => ['ox', 'oy', 'z', 'ry', 's', 'explode', 'home'].every(
    (k) => Math.abs((a[k] || 0) - (b[k] || 0)) < 1e-5
  );

  const sameList = (a, b) =>
    a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);

  await page.waitForTimeout(500);   // past the scrub's own lag
  let previous = await read();
  let still = 0;

  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(80);
    const now = await read();

    still =
      same(previous.burger, now.burger) &&
      same(previous.pizza, now.pizza) &&
      sameList(previous.motion, now.motion)
        ? still + 1
        : 0;
    previous = now;

    if (still >= 3) return;
  }

  throw new Error('the scroll poses never settled');
}

/** The menu payload the page itself used, for cross-checking what is shown. */
function menuData(page) {
  return page.evaluate(() => window.__qbMenu);
}

/**
 * Walks the Scene 1 burger act, from its first frame to its last.
 *
 * The act runs from the top of the page to the top of Scene 2, so the
 * samples are spaced across *that*, not across a fraction of the whole
 * document. Document fractions were fine when the burger owned
 * everything down to the menu; once Scenes 2 and 3 were inserted, the
 * same fractions overshot the end of the act and three samples in a row
 * landed on progress 1, which read as "the rotation stalled".
 */
async function burgerActSteps(page, count = 6) {
  return page.evaluate((n) => {
    const { start, end } = window.__qbHero.ranges().burger;
    return Array.from({ length: n }, (_, i) =>
      Math.round(start + ((end - start) * i) / (n - 1)));
  }, count);
}

/**
 * Scrolls to a fraction of the document, then waits for the scrubbed
 * timeline to catch up before sampling.
 *
 * The settling is done here in Node rather than inside a
 * `page.waitForFunction` predicate. An async predicate there returns a
 * Promise, and a Promise object is truthy, so the wait resolved
 * immediately and every sample was read mid-scrub — which looked exactly
 * like a broken animation and was in fact a broken test.
 *
 * Settling is judged on `x` and `explode` only. Both are pure functions
 * of scroll offset. The rendered `y` carries an idle float and the
 * rendered `ry` a slow constant drift, both deliberate, so neither value
 * ever stops changing and neither can be used to detect stillness.
 */
async function scrollTo(page, fraction, { absolute = false } = {}) {
  const target = await page.evaluate(([f, abs]) => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const y = abs ? Math.round(f) : Math.round(max * f);
    window.scrollTo(0, y);
    return y;
  }, [fraction, absolute]);

  // The scroll itself must land before anything is timed from it.
  await page.waitForFunction(
    (y) => Math.abs(window.scrollY - y) <= 2,
    target,
    { timeout: 10000 }
  );

  const sample = () => page.evaluate(() => ({
    progress: window.__qbHero.progress(),
    pose: window.__qbHero.pose(),
    ...window.__qbHero.read(),
  }));

  /*
   * `scrub: 0.6` means the pose chases the scroll offset for roughly
   * half a second afterwards. Two identical readings therefore prove
   * nothing on their own — taken too early they mean "the scrub has not
   * started yet", which is indistinguishable from "the scrub has
   * finished". That is a race, and under the parallel load of the full
   * suite it lost about one run in three, reporting a stale pose that
   * looked exactly like a broken animation.
   *
   * So: wait out the scrub window first, then require three consecutive
   * still samples.
   */
  const SCRUB_FLOOR_MS = 700;
  await page.waitForTimeout(SCRUB_FLOOR_MS);

  let previous = await sample();
  let still = 0;

  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(80);
    const now = await sample();

    const settled =
      Math.abs(now.x - previous.x) < 1e-3 && Math.abs(now.explode - previous.explode) < 1e-4;

    still = settled ? still + 1 : 0;
    previous = now;

    if (still >= 3) return now;
  }

  throw new Error(`the scroll timeline never settled at fraction ${fraction}`);
}

/* ================================================================== */
/* The claim: genuinely scroll-linked, not a one-shot reveal           */
/* ================================================================== */

test('the burger moves and rotates continuously with scroll position', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  const frames = [];
  for (const y of await burgerActSteps(page)) frames.push(await scrollTo(page, y, { absolute: true }));

  // Progress genuinely tracks the scroll offset.
  for (let i = 1; i < frames.length; i++) {
    assert.ok(
      frames[i].progress >= frames[i - 1].progress,
      `progress went backwards while scrolling down: ${frames[i - 1].progress} → ${frames[i].progress}`
    );
  }
  assert.ok(frames[0].progress < 0.02, 'the timeline should start at zero');
  assert.ok(frames.at(-1).progress > 0.9, 'the timeline should reach its end within the hero act');

  /*
   * The burger turns throughout — several radians, always one way. This
   * reads the scroll-derived pose rather than the rendered rotation,
   * because the rendered value also carries a constant idle drift that
   * would make the assertion pass even if scroll did nothing at all.
   */
  for (let i = 1; i < frames.length; i++) {
    assert.ok(
      frames[i].pose.ry > frames[i - 1].pose.ry,
      `rotation stalled between samples ${i - 1} and ${i}`
    );
  }
  assert.ok(
    frames.at(-1).pose.ry - frames[0].pose.ry > 3,
    'the burger should turn by more than 3 radians overall'
  );

  // And that rotation genuinely reaches the renderer, not just the pose.
  assert.ok(
    frames.at(-1).ry - frames[0].ry > 3,
    'the scroll rotation never made it onto the rendered object'
  );

  // It travels sideways and descends, as the scene intends.
  assert.ok(frames.at(-1).x < frames[0].x - 3, 'the burger should travel left across the act');
  assert.ok(frames.at(-1).y < frames[0].y - 2, 'the burger should descend across the act');

  // And it really does approach the camera before retreating.
  const nearest = Math.max(...frames.map((f) => f.z));
  assert.ok(nearest > 0.5, `the burger should move toward the camera (nearest z was ${nearest})`);
  assert.ok(frames.at(-1).z < -1.5, 'and retreat again by the end');

  await context.close();
});

test('scrolling back up restores the earlier pose, so it is scrubbed not triggered', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  const steps = await burgerActSteps(page);

  const down = await scrollTo(page, steps[1], { absolute: true });
  await scrollTo(page, steps[5], { absolute: true });
  const backUp = await scrollTo(page, steps[1], { absolute: true });

  /*
   * This is the test that separates a scroll-linked timeline from a
   * "play once when it enters the viewport" animation. The latter would
   * hold its end pose here; a scrubbed timeline rewinds exactly.
   *
   * Compared on the scroll-derived pose, which is a pure function of
   * offset, so "rewinds exactly" can be asserted tightly instead of
   * being fudged to absorb the ambient motion.
   */
  for (const key of ['ox', 'oy', 'z', 'rx', 'ry', 'rz', 's', 'explode']) {
    assert.ok(
      Math.abs(down.pose[key] - backUp.pose[key]) < 1e-3,
      `${key} did not rewind: ${down.pose[key]} going down vs ${backUp.pose[key]} coming back up`
    );
  }

  // The rendered rig follows it back too, allowing for the idle float.
  assert.ok(Math.abs(down.x - backUp.x) < 0.05, `rendered x did not rewind: ${down.x} vs ${backUp.x}`);
  assert.ok(Math.abs(down.y - backUp.y) < 0.25, `rendered y did not rewind: ${down.y} vs ${backUp.y}`);

  await context.close();
});

test('the ingredients separate mid-scroll and reassemble by the end', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  // Sample finely: the separation peaks over a narrow slice of the act.
  const steps = await burgerActSteps(page, 11);

  const rest = await scrollTo(page, steps[0], { absolute: true });
  assert.equal(rest.explode, 0, 'the burger should start assembled');

  // Find the widest separation across the act rather than assuming where it is.
  let peak = rest;
  for (let i = 1; i < steps.length - 1; i++) {
    const s = await scrollTo(page, steps[i], { absolute: true });
    if (s.spread > peak.spread) peak = s;
  }

  assert.ok(peak.explode > 0.6, `the ingredients never separated (peak explode ${peak.explode})`);
  assert.ok(
    peak.spread > rest.spread * 1.4,
    `the layers did not actually move apart: ${rest.spread} → ${peak.spread}`
  );

  const end = await scrollTo(page, steps[steps.length - 1], { absolute: true });
  assert.ok(end.explode < 0.02, 'the burger should be reassembled by the end of the act');
  assert.ok(
    Math.abs(end.spread - rest.spread) < 0.02,
    `the layers did not return to the stack: ${rest.spread} → ${end.spread}`
  );

  await context.close();
});

/* ================================================================== */
/* Regression: the page the 3D sits on must survive                    */
/* ================================================================== */

test('the header still sticks to the top of the viewport while scrolled', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);

  /*
   * Guards a real defect: lifting page content above the WebGL stage with
   * `position: relative` also overrode the header's `position: sticky`,
   * so it scrolled away. jsdom cannot see this — it has no sticky.
   */
  await park(page, '#flavours', 0.2);

  const header = await page.evaluate(() => {
    const el = document.querySelector('.site-header');
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height, position: getComputedStyle(el).position };
  });

  assert.equal(header.position, 'sticky', 'the header must remain sticky');
  assert.ok(Math.abs(header.top) < 1, `the header should be pinned at the top, was at ${header.top}px`);
  assert.ok(header.height > 40, 'the header should still have its full height');

  await context.close();
});

test('the skip link stays out of the layout flow', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);

  /*
   * The same `position: relative` mistake pulled the skip link into the
   * flow, where its `top: -60px` hid it off-screen while it still
   * occupied its height — pushing the entire page down by 26px.
   */
  const probe = await page.evaluate(() => {
    const link = document.querySelector('.skip-link');
    const header = document.querySelector('.site-header');
    return {
      position: getComputedStyle(link).position,
      headerTop: header.getBoundingClientRect().top,
    };
  });

  assert.equal(probe.position, 'absolute', 'the skip link must stay out of the flow');
  assert.ok(Math.abs(probe.headerTop) < 1, 'nothing should sit above the header');

  await context.close();
});

test('hero copy is light against the dark stage, not inherited page text', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);

  /*
   * Guards the subtlest defect of the lot. `body { color: var(--text) }`
   * resolves --text at the body; re-pointing --text inside .hero does
   * nothing for elements that merely inherit a computed colour. The
   * headline and the stat figures rendered dark-on-dark and were
   * effectively invisible, while every test still passed.
   */
  const luminance = (css) => {
    const [r, g, b] = css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };

  const colours = await page.evaluate(() => ({
    h1: getComputedStyle(document.querySelector('.hero h1')).color,
    stat: getComputedStyle(document.querySelector('.hero-stats strong')).color,
    brand: getComputedStyle(document.querySelector('.site-header .brand')).color,
  }));

  for (const [name, css] of Object.entries(colours)) {
    assert.ok(
      luminance(css) > 0.4,
      `${name} is too dark to read on the cinematic stage: ${css}`
    );
  }

  await context.close();
});

test('the dark backdrop stops at the end of the cinematic act', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  /*
   * The backdrop was first faded out on scroll progress, which had no
   * idea where the act actually ends. It darkened the next section —
   * styled for a light page — and made its heading unreadable. It is now
   * measured from the real bottom edge of the last cinematic section,
   * which is Scene 3, every frame.
   */
  for (const [selector, fraction] of [['.hero', 0], ['#flavours', 0.3], ['#featured', 0.2]]) {
    await park(page, selector, fraction);

    const probe = await page.evaluate(() => {
      const stage = document.querySelector('.stage3d');
      return {
        actBottom: document.querySelector('#featured').getBoundingClientRect().bottom,
        cut: parseFloat(getComputedStyle(stage).getPropertyValue('--stage-cut')),
        viewport: window.innerHeight,
      };
    });

    const expected = Math.max(0, Math.min(probe.actBottom, probe.viewport));
    assert.ok(
      Math.abs(probe.cut - expected) < 8,
      `at ${selector}: backdrop ends at ${probe.cut}px but the act ends at ${expected}px`
    );
  }

  // And once the act is behind us, the backdrop is gone entirely.
  await park(page, '#menu', 0.1);
  const after = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.stage3d')).getPropertyValue('--stage-cut')));
  assert.ok(after < 10, `the backdrop is still ${after}px tall over the flat page`);

  await context.close();
});

test('no page scrolls sideways with the 3D stage live', skipIf(), async () => {
  for (const width of [320, 390, 820, 1440]) {
    const { context, page } = await openScene({ width, height: 860 });
    await waitForScene(page);
    await waitForScenes(page);

    // Every scene, not just the hero — Scene 2's grid and Scene 3's
    // plate are both wide, transformed and easy to get wrong.
    /*
     * Every section, not a sample of them. The closing act's own glow
     * dragged the document into horizontal scroll at 320px and none of
     * the earlier stops would have noticed, because none of them was
     * anywhere near the finale.
     */
    const stops = [
      ['.hero', 0], ['#flavours', 0.2], ['#featured', 0.1], ['#menu', 0.1],
      ['#how', 0.15], ['#offers', 0.15], ['#kitchens', 0.15], ['#finale', 0.05],
    ];

    for (const [selector, fraction] of stops) {
      if (!(await page.$(selector))) continue;
      await park(page, selector, fraction);

      const { scrollW, clientW, guilty } = await page.evaluate(() => {
        const doc = document.documentElement;
        const over = [...document.querySelectorAll('body *')]
          .filter((n) => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1);
          })
          .slice(0, 4)
          .map((n) => `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ')[0]}`);
        return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, guilty: over };
      });

      assert.equal(
        scrollW, clientW,
        `the page scrolls sideways at ${width}px around ${selector} — ${guilty.join(', ')}`
      );
    }

    await context.close();
  }
});

test('the scene runs without a console error or a failed request', skipIf(), async () => {
  const { context, page, problems } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  // Walk the whole act, so a fault in any scene surfaces here.
  for (const [selector, fraction] of [['#flavours', 0.6], ['#flavours', 0.1], ['#featured', 0.3], ['#menu', 0.2]]) {
    await park(page, selector, fraction);
  }

  assert.deepEqual(problems, [], `the cinematic layer reported: ${problems.join(' | ')}`);
  assert.ok(await page.evaluate(() => window.__qbHero.frames() > 30), 'the scene should be rendering frames');

  await context.close();
});

/* ================================================================== */
/* Scene 2 — flavour categories                                        */
/* ================================================================== */

test('every flavour card is a real category with real figures', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);

  const data = await menuData(page);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.flavour')].map((c) => ({
      category: c.dataset.flavour,
      label: c.querySelector('.flavour-name').textContent.trim(),
      count: c.querySelector('.flavour-count').textContent.trim(),
      from: c.querySelector('.flavour-from').textContent.trim(),
      img: c.querySelector('img').getAttribute('src'),
      tag: c.tagName,
    })));

  assert.ok(cards.length >= 4, `expected a grid of categories, got ${cards.length}`);

  /*
   * The point of this test is that nothing in Scene 2 is decorative
   * fiction. Every number on a card has to be derivable from the menu
   * the page actually loaded.
   */
  for (const card of cards) {
    const dishes = data.items.filter((i) => i.category === card.category);

    assert.ok(dishes.length > 0, `card "${card.label}" names a category with no dishes`);
    assert.equal(card.tag, 'BUTTON', `card "${card.label}" changes a filter and must be a button`);

    const expectedCount = dishes.length;
    assert.match(
      card.count,
      new RegExp(`^${expectedCount} dish(es)?$`),
      `card "${card.label}" claims "${card.count}" but the menu has ${expectedCount}`
    );

    const cheapest = Math.min(...dishes.map((d) => d.price));
    assert.ok(
      card.from.includes(cheapest.toLocaleString('en-IN')),
      `card "${card.label}" says "${card.from}" but the cheapest dish is ₹${cheapest}`
    );

    assert.ok(
      data.items.some((i) => i.image === card.img),
      `card "${card.label}" uses an image that belongs to no dish: ${card.img}`
    );
  }

  // And every category the menu has is actually offered.
  const shown = new Set(cards.map((c) => c.category));
  for (const item of data.items) {
    assert.ok(shown.has(item.category), `category "${item.category}" has no card`);
  }

  await context.close();
});

test('a flavour card really filters the menu', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);
  await page.waitForSelector('#categoryChips .chip');

  const data = await menuData(page);
  const before = await page.evaluate(() => document.querySelectorAll('.dish').length);

  // A category that is genuinely a subset, so "narrowed" means something.
  const target = await page.evaluate(() => document.querySelectorAll('.flavour')[1].dataset.flavour);
  const expected = data.items.filter((i) => i.category === target).length;

  assert.ok(expected > 0 && expected < before, `"${target}" is not a useful subset to test with`);

  await page.click(`.flavour[data-flavour="${target}"]`);

  /*
   * Wait for the exact result, not for a delay and not for a loading
   * flag. The chip path calls loadMenu() without a skeleton, so
   * `aria-busy` never goes true and waiting on it returned instantly —
   * which under the parallel load of the full suite meant sampling the
   * old grid. Waiting for the count the menu payload says this category
   * has is both precise and a stronger assertion than "fewer".
   */
  await page.waitForFunction(
    ([cat, n]) => document.querySelector('#categoryChips .chip.is-active')?.dataset.category === cat
      && document.querySelectorAll('.dish').length === n,
    [target, expected],
    { timeout: 20000 }
  );
  /*
   * Scene 3 is pinned, so the smooth scroll from Scene 2 to the menu now
   * crosses an extra viewport of pinned scroll. A fixed wait is not
   * enough to see it land; wait for the menu to be genuinely in view.
   */
  await page.waitForFunction(
    () => document.getElementById('menu').getBoundingClientRect().top < window.innerHeight,
    null,
    { timeout: 20000 }
  );

  const after = await page.evaluate((cat) => ({
    dishes: document.querySelectorAll('.dish').length,
    activeChip: document.querySelector('#categoryChips .chip.is-active')?.dataset.category,
    scrolledToMenu: document.getElementById('menu').getBoundingClientRect().top < window.innerHeight,
  }), target);

  assert.equal(after.dishes, expected, `"${target}" should show exactly its ${expected} dishes`);

  assert.equal(after.activeChip, target, 'the menu\'s own category chip should be the one activated');
  assert.ok(after.dishes > 0, 'the filtered menu should still show dishes');
  assert.ok(after.dishes < before, `filtering to "${target}" did not narrow the menu (${before} → ${after.dishes})`);
  assert.ok(after.scrolledToMenu, 'the page should take you to the menu it just filtered');

  await context.close();
});

test('flavour cards rise with scroll and go back when you scroll up', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);

  const read = () => page.evaluate(() => {
    const card = document.querySelector('.flavour');
    const cs = getComputedStyle(card);
    return { opacity: +cs.opacity, transform: cs.transform };
  });

  await park(page, '#flavours', 0.98);   // only just entering
  const entering = await read();

  await park(page, '#flavours', 0.1);    // fully arrived
  const arrived = await read();

  await park(page, '#flavours', 0.98);   // and back again
  const returned = await read();

  assert.ok(
    entering.opacity < arrived.opacity - 0.05,
    `the cards did not fade in with scroll (${entering.opacity} → ${arrived.opacity})`
  );
  assert.notEqual(entering.transform, arrived.transform, 'the cards did not move with scroll');
  assert.ok(arrived.opacity > 0.97, `the cards never finish arriving (${arrived.opacity})`);

  /*
   * The reversal is the part worth guarding: a one-shot reveal would
   * stay at its end state here.
   */
  assert.ok(
    Math.abs(returned.opacity - entering.opacity) < 0.08,
    `scrolling back up did not rewind the cards (${entering.opacity} vs ${returned.opacity})`
  );

  await context.close();
});

test('a flavour card is reachable and operable from the keyboard', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);

  const focused = await page.evaluate(() => {
    const card = document.querySelector('.flavour');
    card.focus();
    return {
      isFocused: document.activeElement === card,
      label: card.getAttribute('aria-label'),
      outline: getComputedStyle(card.querySelector('.flavour-tilt')).outlineStyle,
    };
  });

  assert.ok(focused.isFocused, 'a flavour card must be focusable');
  assert.match(focused.label || '', /\d+ dishes? from ₹/, 'the card must announce what it does');

  await page.keyboard.press('Enter');

  await page.waitForFunction(() => {
    const chip = document.querySelector('#categoryChips .chip.is-active');
    return chip && chip.dataset.category !== 'all';
  }, null, { timeout: 15000 });

  const activated = await page.evaluate(() =>
    document.querySelector('#categoryChips .chip.is-active')?.dataset.category);
  assert.ok(activated && activated !== 'all', `Enter did not activate the filter (chip is "${activated}")`);

  await context.close();
});

/* ================================================================== */
/* Scene 3 — featured dish                                             */
/* ================================================================== */

test('the featured dish is a real dish shown with its real figures', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);

  const data = await menuData(page);
  const shown = await page.evaluate(() => ({
    slug: document.getElementById('featured').dataset.slug,
    name: document.getElementById('featuredHeading').textContent.trim(),
    desc: document.querySelector('.featured-desc').textContent.trim(),
    facts: [...document.querySelectorAll('.featured-facts strong')].map((s) => s.textContent.trim()),
    img: document.querySelector('.featured-plate img').getAttribute('src'),
    alt: document.querySelector('.featured-plate img').getAttribute('alt'),
  }));

  const dish = data.items.find((i) => i.slug === shown.slug);
  assert.ok(dish, `the showcase names "${shown.slug}", which is not on the menu`);

  assert.equal(shown.name, dish.name);
  assert.equal(shown.desc, dish.description);
  assert.equal(shown.img, dish.image);
  assert.equal(shown.alt, dish.name);

  assert.ok(shown.facts[0].includes(dish.price.toLocaleString('en-IN')), `price ${shown.facts[0]} ≠ ₹${dish.price}`);
  assert.ok(shown.facts[1].includes(dish.rating.toFixed(1)), `rating ${shown.facts[1]} ≠ ${dish.rating}`);
  assert.ok(shown.facts[2].includes(String(dish.prep_minutes)), `prep ${shown.facts[2]} ≠ ${dish.prep_minutes} min`);

  // It is meant to be the best-rated pizza; at minimum it must be a pizza.
  const pizzas = data.items.filter((i) => i.category === 'pizza' && i.in_stock !== false);
  if (pizzas.length) {
    const best = Math.max(...pizzas.map((p) => p.rating));
    assert.equal(dish.category, 'pizza', 'Scene 3 is built around a pizza');
    assert.equal(dish.rating, best, 'it should be the best-rated pizza available');
  }

  await context.close();
});

test('the featured dish can actually be added to the cart', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);

  /*
   * Scene 3 reuses app.js's own cart handler rather than carrying a
   * copy. This proves the wiring, which is exactly the kind of thing
   * that looks fine and silently does nothing.
   */
  await park(page, '#featured', 0.1);
  await page.click('#featured [data-add]');

  await page.waitForFunction(
    () => Number(document.getElementById('cartCount').textContent) > 0,
    null,
    { timeout: 10000 }
  );

  const count = await page.evaluate(() => Number(document.getElementById('cartCount').textContent));
  assert.ok(count > 0, 'adding the featured dish did not reach the cart');

  await context.close();
});

/*
 * Scene 3 carries the dish's photograph twice and shows exactly one:
 * the full plate when there is no WebGL, and a chip inside the glass
 * panel when the modelled pizza has the stage. Tests must address
 * whichever is actually on screen.
 */
const VISIBLE_PLATE = 'html.qb-3d .featured-plate--chip, html:not(.qb-3d) .featured-plate--full';

test('the featured plate tilts to the pointer on a fine-pointer device', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);
  await parkInAct(page, 'showcase', 0.3);

  /*
   * The plate keeps drifting on a parallax tween, so its box is read
   * immediately before each pointer move rather than once up front.
   * A box captured even a few hundred milliseconds early can put the
   * pointer somewhere the plate no longer is.
   */
  const aim = async (fx, fy) => {
    const box = await page.locator(VISIBLE_PLATE).boundingBox();
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return el && el.style.getPropertyValue('--rx') !== '';
    }, VISIBLE_PLATE, { timeout: 8000 });

    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return {
        rx: parseFloat(el.style.getPropertyValue('--rx')),
        ry: parseFloat(el.style.getPropertyValue('--ry')),
        transform: getComputedStyle(el).transform,
      };
    }, VISIBLE_PLATE);
  };

  const tilted = await aim(0.25, 0.25);

  assert.ok(tilted.rx !== 0, `no X tilt was applied (--rx was ${tilted.rx})`);
  assert.ok(tilted.ry !== 0, `no Y tilt was applied (--ry was ${tilted.ry})`);
  assert.notEqual(tilted.transform, 'none', 'the tilt never reached a real transform');

  // Opposite corner, opposite sign — the tilt tracks the pointer.
  const other = await aim(0.75, 0.75);

  assert.ok(other.rx * tilted.rx < 0, `the X tilt did not invert (${tilted.rx} → ${other.rx})`);
  assert.ok(other.ry * tilted.ry < 0, `the Y tilt did not invert (${tilted.ry} → ${other.ry})`);

  await context.close();
});

test('a touch device gets no sticky tilt', skipIf(), async () => {
  /*
   * There is no pointerleave on a touch screen, so a tilt applied on tap
   * would simply stay at whatever angle the last tap left it. The touch
   * affordance is the press-down scale in CSS instead.
   */
  const { context, page } = await openScene(
    { width: 390, height: 844 },
    { hasTouch: true, isMobile: true }
  );
  await waitForScenes(page);
  await park(page, '#flavours', 0.1);

  await page.tap('.flavour');
  await page.waitForTimeout(500);

  const stuck = await page.evaluate(() =>
    [...document.querySelectorAll('.flavour')].some((c) =>
      c.classList.contains('is-tilting') || c.style.getPropertyValue('--rx')));

  assert.equal(stuck, false, 'a tap left a card tilted with no way to un-tilt it');

  await context.close();
});

/* ================================================================== */
/* The handoff                                                         */
/* ================================================================== */

test('the burger hands the stage to the pizza', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  const read = () => page.evaluate(() => ({
    burger: window.__qbHero.read(),
    pizza: window.__qbHero.pizza(),
  }));

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(900);
  const atHero = await read();

  assert.ok(atHero.burger.visible, 'the burger should own the hero');
  assert.equal(atHero.pizza.visible, false, 'the pizza should not be on stage yet');

  /*
   * The handoff itself: somewhere between the hero and Scene 2 both
   * objects are on stage at once, which is what makes it read as one
   * continuous world rather than two separate animations.
   */
  let overlapped = false;
  let pizzaArrived = false;

  for (const f of [0.95, 0.85, 0.75, 0.65, 0.55, 0.45]) {
    await park(page, '#flavours', f);
    const now = await read();
    if (now.burger.visible && now.pizza.visible) overlapped = true;
    if (now.pizza.visible) pizzaArrived = true;
  }

  assert.ok(pizzaArrived, 'the pizza never came on stage');
  assert.ok(overlapped, 'the burger and the pizza were never on stage together — no handoff, just a cut');

  // By the time Scene 3 is composed the burger is long gone.
  await parkInAct(page, 'showcase', 0.3);
  const atFeatured = await read();
  assert.equal(atFeatured.burger.visible, false, 'the burger is still on stage during Scene 3');

  /*
   * The modelled pizza is Scene 3's subject — it is what comes apart —
   * so it must still be here. What must NOT happen is two pizzas: the
   * full-size photograph steps aside for it and the panel shows a chip
   * instead.
   */
  assert.equal(atFeatured.pizza.visible, true, 'the modelled pizza should be the subject of Scene 3');

  const plates = await page.evaluate(() => {
    const seen = (sel) => {
      const el = document.querySelector(sel);
      return !!el && el.offsetParent !== null;
    };
    return { full: seen('.featured-plate--full'), chip: seen('.featured-plate--chip') };
  });

  assert.equal(plates.full, false, 'the full-size photograph must step aside for the modelled pizza');
  assert.equal(plates.chip, true, 'the real photograph must still be shown, as the panel chip');

  await context.close();
});

/* ================================================================== */
/* Scene 2 — depth and composition                                     */
/* ================================================================== */

test('the cards arrive from genuinely different depths', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);

  /*
   * The distinguishing claim of this scene is depth: cards come from
   * different distances, not merely from different delays. A uniform
   * grid animation would pass any "did it move?" check, so this reads
   * the real translateZ out of each card's matrix mid-entrance and
   * requires them to actually differ.
   */
  await park(page, '#flavours', 0.85);

  const z = await page.evaluate(() =>
    [...document.querySelectorAll('.flavour')].map((card) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(card).transform);
      return +m.m43.toFixed(1);   // translateZ
    }));

  assert.ok(z.length >= 4, 'expected a grid of cards');

  const spread = Math.max(...z) - Math.min(...z);
  assert.ok(spread > 80, `the cards all came from the same depth (z spread was ${spread}px)`);
  assert.ok(z.some((v) => v < -50), 'no card started behind the plane of the screen');

  /*
   * The depths must not form a ramp, or the row reads as being drawn
   * left to right. Checked against the configured values rather than
   * the mid-entrance matrix: at any given scroll offset some cards have
   * already landed on z=0, so adjacent rendered depths legitimately
   * coincide even when the configuration is well varied.
   */
  const configured = await page.evaluate(() =>
    [...document.querySelectorAll('.flavour')].map((c) => parseFloat(c.style.getPropertyValue('--depth'))));

  assert.ok(configured.every(Number.isFinite), 'every card needs a depth');
  assert.ok(new Set(configured).size >= 4, `only ${new Set(configured).size} distinct depths`);

  const ascending = configured.every((v, i) => i === 0 || v >= configured[i - 1]);
  const descending = configured.every((v, i) => i === 0 || v <= configured[i - 1]);
  assert.ok(!ascending && !descending, 'the depths run in order, which reads as a ramp');

  let adjacentDiffer = 0;
  for (let i = 1; i < z.length; i++) if (Math.abs(z[i] - z[i - 1]) > 20) adjacentDiffer++;
  assert.ok(
    adjacentDiffer >= Math.floor((z.length - 1) / 2),
    `only ${adjacentDiffer} of ${z.length - 1} neighbouring pairs differ in depth`
  );

  await context.close();
});

test('the cards settle into an asymmetric composition', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);
  await park(page, '#flavours', 0.1);

  const tops = await page.evaluate(() =>
    [...document.querySelectorAll('.flavour')]
      .slice(0, 4)
      .map((c) => Math.round(c.getBoundingClientRect().top)));

  const spread = Math.max(...tops) - Math.min(...tops);
  assert.ok(
    spread > 20,
    `the first row sits on one flat line (${tops.join(', ')}) — the composition is a plain grid`
  );

  // Varied heights too: at least one card is deliberately taller.
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('.flavour .flavour-media')].map((m) => Math.round(m.getBoundingClientRect().height)));
  assert.ok(
    Math.max(...heights) - Math.min(...heights) > 20,
    'every card photograph is the same height'
  );

  await context.close();
});

test('card depth drift reverses with the scroll', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);

  const read = () => page.evaluate(() =>
    [...document.querySelectorAll('.flavour-depth')].map((el) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { y: +m.m42.toFixed(1), z: +m.m43.toFixed(1) };
    }));

  await park(page, '#flavours', 0.6);
  const down = await read();

  await park(page, '#flavours', 0.0);
  const further = await read();

  await park(page, '#flavours', 0.6);
  const back = await read();

  assert.ok(down.length >= 4, 'expected depth wrappers on the cards');

  // It actually moved between the two positions...
  const moved = down.some((d, i) => Math.abs(d.y - further[i].y) > 3 || Math.abs(d.z - further[i].z) > 3);
  assert.ok(moved, 'the cards did not drift with continued scrolling');

  // ...and came back to where it was.
  for (let i = 0; i < down.length; i++) {
    assert.ok(
      Math.abs(down[i].y - back[i].y) < 2 && Math.abs(down[i].z - back[i].z) < 2,
      `card ${i} did not rewind: y ${down[i].y}→${back[i].y}, z ${down[i].z}→${back[i].z}`
    );
  }

  await context.close();
});

/* ================================================================== */
/* Navigation across the pinned section                                */
/* ================================================================== */

test('choosing a category still lands you on the menu, past the pin', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);
  await page.waitForSelector('#categoryChips .chip');

  /*
   * Guards a defect the pin introduced and that no existing test could
   * have caught. `scrollIntoView({ behavior: 'smooth' })` chooses its
   * destination once, at the start; ScrollTrigger then nudges the
   * scroll position as the pin engages, which cancels the native
   * animation outright. Measured before the fix: the page stopped dead
   * at y=2487, inside the pinned showcase, and never arrived at all.
   */
  const target = await page.evaluate(() => document.querySelectorAll('.flavour')[1].dataset.flavour);
  await page.click(`.flavour[data-flavour="${target}"]`);

  await page.waitForFunction(
    () => {
      const top = document.getElementById('menu').getBoundingClientRect().top;
      return top > -40 && top < 120;
    },
    null,
    { timeout: 15000 }
  );

  const landed = await page.evaluate(() => ({
    menuTop: Math.round(document.getElementById('menu').getBoundingClientRect().top),
    chip: document.querySelector('#categoryChips .chip.is-active')?.dataset.category,
  }));

  assert.equal(landed.chip, target, 'the filter should have been applied');
  assert.ok(
    Math.abs(landed.menuTop) < 120,
    `the menu should be at the top of the viewport, was ${landed.menuTop}px away`
  );

  await context.close();
});

/* ================================================================== */
/* Scene 3 — the exploded showcase                                     */
/* ================================================================== */

test('Scene 3 pins, and the pizza comes apart and back together', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  const read = () => page.evaluate(() => {
    const box = document.getElementById('featured').getBoundingClientRect();
    return {
      pizza: window.__qbHero.pizza(),
      sectionTop: box.top,
      sectionHeight: box.height,
      viewport: window.innerHeight,
    };
  });

  const samples = [];
  for (const t of [0, 0.2, 0.4, 0.5, 0.6, 0.75, 0.9]) {
    await parkInAct(page, 'showcase', t);
    samples.push({ t, ...(await read()) });
  }

  /*
   * Pinned means the section stays put at the top of the viewport while
   * the scroll continues. Without the pin the explode and the section's
   * own upward drift cancel each other out on screen.
   */
  for (const s of samples) {
    assert.ok(
      Math.abs(s.sectionTop) < 2,
      `at t=${s.t} the section should be pinned at the top, was at ${s.sectionTop}px`
    );
    assert.ok(
      s.sectionHeight >= s.viewport - 2,
      `at t=${s.t} the pinned section should fill the viewport (${s.sectionHeight} vs ${s.viewport})`
    );
  }

  const rest = samples[0].pizza.spread;
  const peak = Math.max(...samples.map((s) => s.pizza.spread));
  const end = samples.at(-1).pizza.spread;

  assert.ok(peak > rest * 4, `the layers barely separated (${rest} → ${peak})`);
  assert.ok(
    Math.abs(end - rest) < 0.05,
    `the pizza did not go back together by the end (${rest} → ${end})`
  );

  // Every layer is accounted for, and the pizza is on stage throughout.
  assert.ok(samples.every((s) => s.pizza.visible), 'the pizza left the stage mid-showcase');

  await context.close();
});

test('the exploded pizza rewinds when you scroll back up', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  const pose = () => page.evaluate(() => window.__qbHero.pizza().pose);

  await parkInAct(page, 'showcase', 0.5);
  const forward = await pose();

  await parkInAct(page, 'showcase', 0.95);
  await parkInAct(page, 'showcase', 0.5);
  const back = await pose();

  assert.ok(forward.explode > 0.3, `the sample point should be mid-explode (was ${forward.explode})`);

  for (const key of ['explode', 'rx', 'ry', 's', 'home']) {
    assert.ok(
      Math.abs(forward[key] - back[key]) < 5e-3,
      `${key} did not rewind: ${forward[key]} going down vs ${back[key]} coming back up`
    );
  }

  await context.close();
});

test('the pizza is scroll-linked and rewinds', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  const read = () => page.evaluate(() => window.__qbHero.pizza());

  /*
   * Sampled across the approach's own scroll range rather than against
   * Scene 2's rectangle. Scene 2's height is a design variable — the
   * editorial offsets and the taller feature cards both change it — and
   * addressing the act through it meant the samples silently covered
   * less and less of the animation.
   */
  const steps = [0.15, 0.35, 0.55, 0.75, 0.95];

  await parkInAct(page, 'pizza', steps[0]);
  const early = await read();

  const samples = [early];
  for (const t of steps.slice(1)) {
    await parkInAct(page, 'pizza', t);
    samples.push(await read());
  }

  /*
   * Rotation is monotonic by design — the pizza turns one way for the
   * whole approach.
   */
  for (let i = 1; i < samples.length; i++) {
    assert.ok(
      samples[i].pose.ry > samples[i - 1].pose.ry,
      `the pizza stopped turning between samples ${i - 1} and ${i}`
    );
  }
  assert.ok(samples.at(-1).pose.ry - early.pose.ry > 0.8, 'the pizza barely turned across the whole act');

  /*
   * Vertical travel is deliberately NOT monotonic: the pizza climbs
   * hard out of the bottom of the frame and then settles back down into
   * its showcase position. Asserting a monotonic climb would have
   * forbidden exactly the ascend-then-descend motion this scene is
   * built around — so what is asserted is the climb, and then the
   * settle, as separate claims.
   */
  const heights = samples.map((s) => s.pose.oy);
  const peak = Math.max(...heights);
  const peakAt = heights.indexOf(peak);

  assert.ok(peak - heights[0] > 1.0, `the pizza never really rose (${heights[0]} → ${peak})`);
  assert.ok(peakAt > 0, 'the pizza was already at its highest before the act began');
  assert.ok(
    heights.at(-1) < peak,
    'the pizza should settle back down into its showcase position after rising'
  );

  // And it genuinely comes toward the viewer on the way.
  assert.ok(
    Math.max(...samples.map((s) => s.pose.z)) - samples[0].pose.z > 1.0,
    'the pizza never approached the camera'
  );

  await parkInAct(page, 'pizza', steps[0]);
  const back = await read();

  for (const key of ['ox', 'oy', 'z', 'rx', 'ry', 's']) {
    assert.ok(
      Math.abs(early.pose[key] - back.pose[key]) < 1e-3,
      `pizza ${key} did not rewind: ${early.pose[key]} vs ${back.pose[key]}`
    );
  }

  await context.close();
});

/* ================================================================== */
/* Scenes 4-8 — the closing act                                        */
/* ================================================================== */

test('the journey shows the real order lifecycle, in order', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);
  await page.waitForSelector('.leg');

  const legs = await page.evaluate(() =>
    [...document.querySelectorAll('.leg')].map((l) => ({
      status: l.dataset.status,
      label: l.querySelector('.leg-label').textContent.trim(),
      step: l.querySelector('.leg-step').textContent.trim(),
    })));

  /*
   * These are the five statuses in `server/orderState.js`, in the order
   * an order actually moves through them. If the server's FLOW ever
   * changes, this is the test that should fail.
   */
  assert.deepEqual(
    legs.map((l) => l.status),
    ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'],
    'the journey must mirror the real lifecycle'
  );

  legs.forEach((leg, i) => {
    assert.equal(leg.step, `Step ${i + 1}`, 'the stages must be numbered in order');
    assert.ok(leg.label.length > 0, 'every stage needs a label');
  });

  await context.close();
});

test('the journey legs climb from different depths and rewind', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);

  const read = () => page.evaluate(() =>
    [...document.querySelectorAll('.leg')].map((l) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(l).transform);
      return { y: +m.m42.toFixed(1), z: +m.m43.toFixed(1) };
    }));

  await park(page, '#how', 0.9);
  const entering = await read();

  await park(page, '#how', 0.1);
  const arrived = await read();

  await park(page, '#how', 0.9);
  const back = await read();

  assert.equal(entering.length, 5);

  const depths = entering.map((l) => l.z);
  assert.ok(
    Math.max(...depths) - Math.min(...depths) > 100,
    `the legs all arrive from the same depth (z spread ${Math.max(...depths) - Math.min(...depths)}px)`
  );
  assert.ok(entering.some((l, i) => Math.abs(l.y - arrived[i].y) > 10), 'the legs did not climb');

  for (let i = 0; i < entering.length; i++) {
    assert.ok(
      Math.abs(entering[i].y - back[i].y) < 3 && Math.abs(entering[i].z - back[i].z) < 3,
      `leg ${i} did not rewind: y ${entering[i].y}→${back[i].y}, z ${entering[i].z}→${back[i].z}`
    );
  }

  await context.close();
});

test('the parcel travels across the journey and leaves', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  const read = () => page.evaluate(() => window.__qbHero.parcel());

  const samples = [];
  for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    await parkInAct(page, 'trip', t);
    samples.push(await read());
  }

  // It crosses the frame left to right, turning as it goes.
  for (let i = 1; i < samples.length; i++) {
    assert.ok(
      samples[i].pose.fx > samples[i - 1].pose.fx,
      `the parcel stopped travelling between samples ${i - 1} and ${i}`
    );
    assert.ok(
      samples[i].ry > samples[i - 1].ry,
      `the parcel stopped turning between samples ${i - 1} and ${i}`
    );
  }

  assert.ok(samples.at(-1).pose.fx - samples[0].pose.fx > 1.2, 'the parcel barely moved');
  assert.ok(samples.some((s) => s.visible), 'the parcel was never actually on stage');

  /*
   * It stays out of the upper half, where the section heading is. An
   * earlier route arced up through "From our pan to your door" and
   * parked a large parcel across it.
   */
  assert.ok(
    samples.every((s) => s.pose.fy < 0.05),
    `the parcel strayed into the heading (highest fy was ${Math.max(...samples.map((s) => s.pose.fy))})`
  );

  // And it rewinds.
  await parkInAct(page, 'trip', 0.3);
  const back = await read();
  assert.ok(
    Math.abs(back.pose.fx - samples[1].pose.fx) < 5e-3,
    `the parcel did not rewind: ${samples[1].pose.fx} vs ${back.pose.fx}`
  );

  await context.close();
});

test('the offers are the real coupons, and still apply', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);
  await page.waitForSelector('.offer');

  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('.offer')].map((o) => ({
      code: o.dataset.coupon,
      label: o.querySelector('.offer-code').textContent.trim(),
      desc: o.querySelector('.offer-desc').textContent.trim(),
    })));

  const live = await page.evaluate(async () => {
    const res = await fetch('/api/menu/coupons');
    return (await res.json()).coupons;
  });

  assert.ok(shown.length > 0, 'no offers were rendered');
  assert.deepEqual(
    shown.map((o) => o.code).sort(),
    live.map((c) => c.code).sort(),
    'the offers shown must be exactly the live coupons'
  );

  for (const offer of shown) {
    const match = live.find((c) => c.code === offer.code);
    assert.equal(offer.label, offer.code, 'the card shows its own code');
    assert.equal(offer.desc, match.description, 'the terms must come from the API');
  }

  // The card is still the working control it replaced.
  await park(page, '#offers', 0.2);
  await page.click(`.offer[data-coupon="${shown[0].code}"]`);

  await page.waitForFunction(
    (code) => document.getElementById('couponInput')?.value === code,
    shown[0].code,
    { timeout: 10000 }
  );

  await context.close();
});

test('the reviews are real rows, never the same voice twice running', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);
  await page.waitForSelector('.review', { timeout: 20000 });

  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('.review')].map((r) => ({
      text: r.querySelector('.review-text').textContent.trim(),
      author: r.querySelector('.review-foot strong').textContent.trim(),
      dish: r.querySelector('.review-item').textContent.replace(/^on /, '').trim(),
      stars: r.querySelector('.review-stars').getAttribute('aria-label'),
    })));

  const live = await page.evaluate(async () => {
    const res = await fetch('/api/menu/reviews/recent?limit=24');
    return (await res.json()).reviews;
  });

  assert.ok(shown.length > 0, 'no reviews were rendered');

  // Nothing on screen that is not in the database.
  for (const card of shown) {
    const match = live.find((r) => r.author === card.author && r.item_name === card.dish);
    assert.ok(match, `"${card.author} on ${card.dish}" is not a real review`);
    assert.equal(card.text.replace(/[\u201C\u201D]/g, ''), match.comment, 'the quote must be verbatim');
    assert.match(card.stars, /^[1-5] out of 5$/);
  }

  /*
   * A seeded database has only a handful of demo customers, so the
   * newest dozen reviews can easily be one name repeated. Adjacent
   * duplicates are what make that obvious.
   */
  for (let i = 1; i < shown.length; i++) {
    assert.notEqual(
      shown[i].author, shown[i - 1].author,
      `"${shown[i].author}" appears twice in a row`
    );
  }

  await context.close();
});

test('the kitchens are the real cuisines, with real counts', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);
  await page.waitForSelector('.kitchen');

  const data = await menuData(page);
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('.kitchen')].map((k) => ({
      name: k.querySelector('.kitchen-body h3').textContent.trim(),
      dishes: Number(k.querySelectorAll('.kitchen-facts dd')[0].textContent.trim()),
      rating: k.querySelectorAll('.kitchen-facts dd')[1].textContent.trim(),
    })));

  const counts = new Map();
  for (const item of data.items) {
    if (!item.cuisine) continue;
    counts.set(item.cuisine, (counts.get(item.cuisine) || 0) + 1);
  }

  assert.equal(shown.length, counts.size, 'every cuisine on the menu needs a card, and no more');
  assert.equal(
    shown.reduce((sum, k) => sum + k.dishes, 0),
    data.items.filter((i) => i.cuisine).length,
    'the dish counts must add up to the menu'
  );

  /*
   * No flag emoji. Windows ships no glyphs for regional-indicator
   * pairs, so every flag fell back to its bare letters and the cards
   * read "IT Italian" and "US American" for every Windows visitor.
   */
  for (const k of shown) {
    assert.doesNotMatch(
      k.name,
      /[\u{1F1E6}-\u{1F1FF}]/u,
      `"${k.name}" uses a flag emoji, which does not render on Windows`
    );
    assert.match(k.rating, /^★ \d\.\d$/, 'each kitchen shows a real average rating');
  }

  await context.close();
});

test('the finale counts its figures from the live menu', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScenes(page);
  await page.waitForSelector('.finale-stats li');

  const data = await menuData(page);
  const stats = await page.evaluate(() =>
    [...document.querySelectorAll('.finale-stats li')].map((li) => ({
      value: li.querySelector('strong').textContent.trim(),
      label: li.querySelector('span').textContent.trim(),
    })));

  const avg = data.items.reduce((sum, i) => sum + i.rating, 0) / data.items.length;
  const cuisines = new Set(data.items.map((i) => i.cuisine).filter(Boolean)).size;
  const quickest = Math.min(...data.items.map((i) => i.prep_minutes).filter(Boolean));

  const values = stats.map((s) => s.value);
  assert.ok(values.includes(String(data.items.length)), `dish count missing from ${values.join(', ')}`);
  assert.ok(values.includes(`★ ${avg.toFixed(1)}`), `average rating missing from ${values.join(', ')}`);
  assert.ok(values.includes(String(cuisines)), `cuisine count missing from ${values.join(', ')}`);
  assert.ok(values.includes(`${quickest} min`), `quickest prep missing from ${values.join(', ')}`);

  await context.close();
});

test('the burger comes back for the finale', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  // It is long gone by the middle of the page.
  await park(page, '#menu', 0.2);
  assert.equal(
    await page.evaluate(() => window.__qbHero.read().visible), false,
    'the burger should not be on stage over the menu'
  );

  const read = () => page.evaluate(() => ({
    fin: window.__qbHero.finale(),
    burger: window.__qbHero.read(),
  }));

  const samples = [];
  for (const t of [0.2, 0.5, 0.8]) {
    await parkInAct(page, 'finale', t);
    samples.push(await read());
  }

  assert.ok(samples.some((s) => s.burger.visible), 'the burger never returned for the finale');
  assert.ok(samples.at(-1).fin.blend > 0.9, 'the finale pose never fully took over');

  // It rises through the section rather than sitting still.
  const heights = samples.map((s) => s.fin.pose.fy);
  assert.ok(
    heights.at(-1) > heights[0] + 0.2,
    `the burger did not rise across the finale (${heights.join(' → ')})`
  );

  // And the closing act really is dark.
  assert.ok(samples.at(-1).fin.act2 > 0.5, 'the closing act backdrop was not drawn');

  await context.close();
});

/* ================================================================== */
/* Not working when there is nothing to show                           */
/* ================================================================== */

test('the renderer stops entirely once the cinematic act is behind us', skipIf(), async () => {
  const { context, page } = await openScene();
  await waitForScene(page);
  await waitForScenes(page);

  /*
   * Guards a defect that was invisible by inspection: an early-out was
   * lost in an edit and the scene carried on rendering a fully
   * transparent canvas, because a scene nobody can see looks identical
   * whether or not it is being drawn. Measured at the time: 145 full
   * scene renders in 1.2 seconds while parked over the menu, at every
   * viewport width.
   */
  await park(page, '#menu', 0.2);

  const before = await page.evaluate(() => window.__qbHero.frames());
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => window.__qbHero.frames());

  const alpha = await page.evaluate(() => window.__qbHero.read().alpha);

  assert.ok(alpha < 0.02, `the canvas should be invisible past the act, was ${alpha}`);
  assert.equal(
    after - before, 0,
    `${after - before} frames were rendered for an invisible canvas`
  );

  // And it comes back to life on the way up.
  await park(page, '#flavours', 0.2);
  const resumed0 = await page.evaluate(() => window.__qbHero.frames());
  await page.waitForTimeout(700);
  const resumed1 = await page.evaluate(() => window.__qbHero.frames());

  assert.ok(resumed1 - resumed0 > 10, 'the scene did not resume when scrolled back into view');

  await context.close();
});

/* ================================================================== */
/* Degrading honestly                                                  */
/* ================================================================== */

test('reduced motion keeps the flat hero and never starts WebGL', skipIf(), async () => {
  const { context, page } = await openScene({ width: 1440, height: 900 }, { reducedMotion: 'reduce' });
  // Give the boot script every chance to misbehave before asserting it did not.
  await page.waitForTimeout(2500);

  const state = await page.evaluate(() => ({
    scene: !!window.__qbHero,
    motion: !!window.__qbMotion,
    stage: !!document.querySelector('.stage3d'),
    cinematic: document.documentElement.classList.contains('qb-3d'),
    collage: !!document.querySelector('.hero-art') &&
      getComputedStyle(document.querySelector('.hero-art')).display !== 'none',
    dishes: document.querySelectorAll('.dish').length,
    flavours: document.querySelectorAll('.flavour').length,
    featuredHidden: document.getElementById('featured').hidden,
    cardOpacity: +getComputedStyle(document.querySelector('.flavour')).opacity,
  }));

  assert.equal(state.scene, false, 'the 3D scene must not start under reduced motion');
  assert.equal(state.stage, false, 'no WebGL stage should be inserted');
  assert.equal(state.cinematic, false, 'the cinematic class should not be applied');
  assert.equal(state.collage, true, 'the hero photo collage is the fallback and must stay visible');
  assert.ok(state.dishes > 0, 'and the real menu must still load');

  // Scenes 2 and 3 are content, not motion. They must be fully there.
  assert.equal(state.motion, false, 'the scroll choreography must not start either');
  assert.ok(state.flavours >= 4, `Scene 2 must still render its cards (got ${state.flavours})`);
  assert.equal(state.featuredHidden, false, 'Scene 3 must still be shown');
  assert.ok(state.cardOpacity > 0.99, `the cards must be fully visible, not left mid-animation (${state.cardOpacity})`);

  await context.close();
});

test('the page works fully when the 3D bundle cannot be fetched', skipIf(), async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Simulate a device or network that never gets the scene.
  await page.route('**/scene.bundle.js', (route) => route.abort());

  await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.dish');
  await page.waitForTimeout(2000);

  const state = await page.evaluate(() => ({
    cinematic: document.documentElement.classList.contains('qb-3d'),
    collage: getComputedStyle(document.querySelector('.hero-art')).display !== 'none',
    dishes: document.querySelectorAll('.dish').length,
    heading: document.querySelector('.hero h1').textContent.trim().length,
    flavours: document.querySelectorAll('.flavour').length,
    featuredHidden: document.getElementById('featured').hidden,
    motion: !!window.__qbMotion,
  }));

  assert.equal(state.cinematic, false, 'a failed bundle must not leave the page half-converted');
  assert.equal(state.collage, true, 'the flat hero must come back');
  assert.ok(state.dishes > 0, 'the menu must still render');
  assert.ok(state.heading > 0, 'the hero copy must still be there');
  assert.ok(state.flavours >= 4, 'Scene 2 must still render');
  assert.equal(state.featuredHidden, false, 'Scene 3 must still render');

  /*
   * And the point of splitting the bundles: losing Three.js costs the
   * WebGL world, not the scroll choreography.
   */
  assert.equal(state.motion, true, 'the DOM choreography should survive a missing 3D bundle');

  await context.close();
});

test('Scene 2 and Scene 3 work with no WebGL at all', skipIf(), async () => {
  /*
   * The honest test of "the page remains usable if WebGL fails": block
   * the WebGL bundle *and* assert the sections are not merely present
   * but operable.
   */
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.route('**/scene.bundle.js', (route) => route.abort());

  await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
  await waitForScenes(page);
  await page.waitForSelector('#categoryChips .chip');

  const before = await page.evaluate(() => document.querySelectorAll('.dish').length);
  const target = await page.evaluate(() => document.querySelectorAll('.flavour')[1].dataset.flavour);

  await page.click(`.flavour[data-flavour="${target}"]`);
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => ({
    dishes: document.querySelectorAll('.dish').length,
    chip: document.querySelector('#categoryChips .chip.is-active')?.dataset.category,
    cardVisible: +getComputedStyle(document.querySelector('.flavour')).opacity > 0.5,
  }));

  assert.equal(after.chip, target, 'the category filter must work without WebGL');
  assert.ok(after.dishes < before && after.dishes > 0, 'the menu must narrow without WebGL');
  assert.ok(after.cardVisible, 'the cards must be visible without WebGL');

  await context.close();
});

/* ================================================================== */
/* The committed bundle must match its source                          */
/* ================================================================== */

test('the committed 3D bundle is in sync with scene.js', () => {
  /*
   * `scene.bundle.js` is a build artefact that is committed so the app
   * runs straight from a clone. That only stays honest if the committed
   * file still matches the source it claims to be built from.
   */
  const bundle = path.join(__dirname, '..', 'public', 'js', 'cinematic', 'scene.bundle.js');
  assert.ok(fs.existsSync(bundle), 'scene.bundle.js is missing — run `npm run build:3d`');

  try {
    require.resolve('esbuild');
  } catch {
    return; // Nothing to check against without the bundler; the file exists.
  }

  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-cinematic.js'), '--check'], {
    stdio: 'pipe',
  });
});

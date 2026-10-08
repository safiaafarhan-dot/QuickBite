'use strict';

/**
 * Asset and licensing tests.
 *
 * CC BY and CC BY-SA oblige us to attribute every photograph we redistribute.
 * A partial `fetch-images.js --force` run once overwrote CREDITS.md with a
 * single row, leaving 29 photos unattributed — these tests make that loud.
 *
 * They are static checks over the repository, so they need no server, no
 * browser and no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MENU } = require('../server/data/menu');

const ROOT = path.join(__dirname, '..');
const DISHES = path.join(ROOT, 'public', 'images', 'dishes');
const CREDITS = path.join(DISHES, 'CREDITS.md');
const CREDITS_JSON = path.join(DISHES, 'credits.json');

/** Parses the markdown table into one object per row. */
function creditRows() {
  const text = fs.readFileSync(CREDITS, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Dish') && !l.startsWith('| ---'))
    .map((l) => {
      const [, dish, file, author, licence, source] = l.split('|').map((c) => c.trim());
      return { dish, file, author, licence, source };
    });
}

/* ================================================================== */

test('every dish on the menu has a photo file on disk', () => {
  const missing = [];
  const tiny = [];

  for (const dish of MENU) {
    const file = path.join(DISHES, `${dish.slug}.jpg`);
    if (!fs.existsSync(file)) { missing.push(dish.slug); continue; }
    // A truncated download would still "exist" but be useless.
    if (fs.statSync(file).size < 20_000) tiny.push(`${dish.slug} (${fs.statSync(file).size}B)`);
  }

  assert.deepEqual(missing, [], 'dishes with no photo');
  assert.deepEqual(tiny, [], 'dishes whose photo looks truncated');
});

test('the image path the database serves matches the file on disk', () => {
  for (const dish of MENU) {
    const served = `images/dishes/${dish.slug}.jpg`;
    assert.ok(
      fs.existsSync(path.join(ROOT, 'public', served)),
      `${dish.name} is served from ${served}, which does not exist`
    );
  }
});

test('every redistributed photo is attributed', () => {
  assert.ok(fs.existsSync(CREDITS), 'CREDITS.md is missing entirely');

  const rows = creditRows();
  const credited = new Set(rows.map((r) => r.dish));
  const uncredited = MENU.filter((d) => !credited.has(d.name)).map((d) => d.name);

  assert.deepEqual(
    uncredited, [],
    'these dishes are redistributed without attribution, which CC BY and CC BY-SA forbid'
  );
  assert.equal(rows.length, MENU.length, 'CREDITS.md row count does not match the menu');
});

test('each credit names an author, a licence and a source', () => {
  for (const row of creditRows()) {
    assert.ok(row.author && row.author !== 'Unknown', `${row.dish}: no author recorded`);
    assert.ok(row.licence, `${row.dish}: no licence recorded`);
    assert.match(row.source, /commons\.wikimedia\.org/, `${row.dish}: no Commons source link`);
    assert.ok(row.file, `${row.dish}: no source filename recorded`);
  }
});

test('every licence used actually permits redistribution', () => {
  // Anything outside this set must not be shipped in the repository.
  const allowed = /^(CC0|Public domain|PD[- ]|CC BY(-SA)? ?\d|CC BY(-SA)?$)/i;

  const bad = creditRows()
    .filter((r) => !allowed.test(r.licence))
    .map((r) => `${r.dish}: ${r.licence}`);

  assert.deepEqual(bad, [], 'photos under a licence that does not permit redistribution');
});

test('the credits sidecar stays in step with the rendered table', () => {
  assert.ok(fs.existsSync(CREDITS_JSON), 'credits.json is missing — CREDITS.md cannot be rebuilt');

  const stored = JSON.parse(fs.readFileSync(CREDITS_JSON, 'utf8'));
  const rows = creditRows();

  assert.equal(
    Object.keys(stored).length, rows.length,
    'credits.json and CREDITS.md disagree on how many photos there are'
  );

  for (const dish of MENU) {
    assert.ok(stored[dish.slug], `credits.json has no entry for ${dish.slug}`);
  }
});

test('no stale candidate images were left behind by a review run', () => {
  const strays = fs.readdirSync(DISHES).filter((f) => f.startsWith('_candidate-'));
  assert.deepEqual(strays, [], 'temporary candidate images are still in the repository');
});

test('the placeholder the fallback depends on exists', () => {
  const placeholder = path.join(ROOT, 'public', 'images', 'placeholder.svg');
  assert.ok(fs.existsSync(placeholder), 'images/placeholder.svg is missing');
  assert.ok(fs.statSync(placeholder).size > 200, 'the placeholder looks empty');
});

/* ================================================================== */
/* Guards for the CSP-related defects found during visual QA           */
/* ================================================================== */

test('no page carries an inline script or inline event handler', () => {
  // The CSP is `script-src 'self'`, so both are silently dead code.
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  const problems = [];

  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');

    // A <script> with no src= is an inline block.
    for (const tag of html.match(/<script\b[^>]*>/g) || []) {
      if (!/\bsrc=/.test(tag)) problems.push(`${page}: inline <script>`);
    }
    for (const handler of html.match(/\son(error|click|load|change|submit)=/g) || []) {
      problems.push(`${page}: inline ${handler.trim()} handler`);
    }
  }

  assert.deepEqual(problems, [], 'these are blocked by the Content-Security-Policy and will never run');
});

test('no client script emits an inline event handler into its markup', () => {
  const scripts = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js'));
  const problems = [];

  for (const file of scripts) {
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8');
    for (const handler of code.match(/\son(error|click|load|change|submit)=["']/g) || []) {
      problems.push(`${file}: renders an inline ${handler.trim()} handler`);
    }
  }

  assert.deepEqual(problems, [], 'inline handlers injected via innerHTML are blocked by the CSP');
});

test('the stylesheet forces [hidden] to win over component display rules', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');

  // Without this, `element.hidden = true` does nothing to anything styled as
  // flex or grid — which silently left the sign-in button and the kitchen link
  // on screen for signed-in customers.
  assert.match(
    css,
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    'style.css must contain `[hidden] { display: none !important; }`'
  );
});

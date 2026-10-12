#!/usr/bin/env node
'use strict';

/**
 * Bundles the cinematic layer.
 *
 * Why a build step exists in an otherwise build-free project: Three.js
 * ships only unminified ES modules (2.0 MB across `three.module.js` and
 * `three.core.js`), and the site is served under a strict
 * `script-src 'self'` CSP with no CDN. Shipping the raw modules would
 * mean serving 2 MB of uncompressed JavaScript; esbuild tree-shakes away
 * everything the scenes do not touch and minifies the rest.
 *
 * Two entry points, with code splitting:
 *
 *   motion.js  GSAP scroll choreography for the Scene 2 and Scene 3 DOM.
 *              Small, and loaded whenever motion is welcome.
 *   scene.js   The WebGL world. Large, and loaded only when the device
 *              can actually render it.
 *
 * Splitting is not only about bytes. Without it each bundle would carry
 * its own copy of GSAP, and two GSAP instances on one page means two
 * tickers, two scroll listeners and two separate ScrollTrigger
 * registries — so a refresh triggered by one could not reach the other's
 * triggers. The shared chunk keeps them on one instance.
 *
 * Outputs are committed, so cloning and `npm start` needs no build.
 * Re-run after editing either entry point:
 *
 *   npm run build:3d
 *
 * `--check` verifies the committed output matches the current source
 * instead of writing it, which is what the test suite uses.
 */

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'js', 'cinematic');

const ENTRIES = [path.join(SRC, 'scene.js'), path.join(SRC, 'motion.js')];

const options = {
  entryPoints: ENTRIES,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2020'],
  minify: true,
  entryNames: '[name].bundle',
  chunkNames: 'chunk-[hash]',
  // Keeps the Three.js and GSAP licence notices in the shipped files.
  legalComments: 'eof',
  charset: 'utf8',
  logLevel: 'warning',
};

/** Everything the build owns, so stale chunks never linger. */
function builtFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.bundle.js') || /^chunk-[A-Z0-9]+\.js$/i.test(f))
    .sort();
}

function snapshot(dir) {
  return builtFiles(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
}

async function main() {
  const check = process.argv.includes('--check');
  const outdir = check ? fs.mkdtempSync(path.join(os.tmpdir(), 'qb-scene-check-')) : SRC;

  if (!check) {
    // A chunk is named by content hash, so an edit leaves the old one behind.
    for (const f of builtFiles(SRC)) fs.rmSync(path.join(SRC, f), { force: true });
  }

  await esbuild.build({ ...options, outdir });

  if (check) {
    const expected = snapshot(outdir);
    const actual = snapshot(SRC);
    fs.rmSync(outdir, { recursive: true, force: true });

    const names = (list) => list.map(([f]) => f).join(', ');

    if (names(expected) !== names(actual)) {
      console.error(`✗ built files differ — expected [${names(expected)}], found [${names(actual)}]`);
      console.error('  run `npm run build:3d` and commit the result');
      process.exit(1);
    }

    for (let i = 0; i < expected.length; i++) {
      if (expected[i][1] !== actual[i][1]) {
        console.error(`✗ ${actual[i][0]} is stale — run \`npm run build:3d\` and commit the result`);
        process.exit(1);
      }
    }

    console.log(`✓ ${actual.length} built files match their source`);
    return;
  }

  for (const [name, code] of snapshot(SRC)) {
    console.log(`✓ ${name} — ${(Buffer.byteLength(code) / 1024).toFixed(0)} KB minified`);
  }
  console.log('  (both are lazy-loaded; neither blocks first paint)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

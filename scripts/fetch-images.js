'use strict';

/**
 * Downloads one openly-licensed photo per dish from Wikimedia Commons.
 *
 *   node scripts/fetch-images.js            # only dishes with no photo yet
 *   node scripts/fetch-images.js --force    # re-fetch everything
 *   node scripts/fetch-images.js margherita-pizza lava-cake   # specific slugs
 *   node scripts/fetch-images.js --candidates margherita-pizza  # save 4 options
 *
 * Only licences that allow redistribution are accepted, and every download is
 * recorded in public/images/dishes/CREDITS.md with its author and licence so the
 * attribution requirement is actually met.
 */

const fs = require('node:fs');
const path = require('node:path');
const { MENU } = require('../server/data/menu');

const OUT_DIR = path.join(__dirname, '..', 'public', 'images', 'dishes');
const CREDITS = path.join(OUT_DIR, 'CREDITS.md');
// Machine-readable record of what was downloaded. CREDITS.md is rendered from
// this, so fetching a single dish can never wipe out the other 29 attributions.
const CREDITS_DATA = path.join(OUT_DIR, 'credits.json');
const API = 'https://commons.wikimedia.org/w/api.php';

// Wikimedia asks every client to identify itself.
const USER_AGENT = 'QuickBite-Demo/1.0 (local teaching project; contact: local)';

/** Licences that permit redistribution. Anything else is skipped outright. */
const ALLOWED = [
  /^cc0/i, /^public domain/i, /^pd/i, /^cc[- ]by(-sa)?[- ]?\d/i, /^cc[- ]by(-sa)?$/i,
];

const MIN_WIDTH = 900;
const THUMB_WIDTH = 1000;

/**
 * Cards crop to 4:3, so panoramas and tall portraits lose the food. Anything
 * outside this band is rejected before it is ever considered.
 */
const MIN_RATIO = 0.80;
const MAX_RATIO = 1.90;
const IDEAL_RATIO = 4 / 3;

/**
 * Commons is full of packaged-product shots, buffet trays and shopfronts. These
 * words in a filename almost always mean the photo is not a plated dish.
 */
const BAD_WORDS = [
  'bottle', 'can ', 'canned', 'packet', 'package', 'packaging', 'label', 'logo',
  'supermarket', 'shop', 'store', 'shelf', 'buffet', 'menu', 'signboard', 'sign ',
  'factory', 'market', 'vendor', 'stall', 'advert', 'poster', 'box of', 'tin ',
  'child', 'kid', 'baby', 'girl', 'boy', 'woman', 'man ', 'portrait', 'people',
];

/**
 * Chain-restaurant photos carry someone else's trade dress, so they are never
 * appropriate for our own menu even when the licence allows reuse.
 */
const BRANDS = [
  'burger king', 'bk ', 'mcdonald', 'kfc', 'domino', 'pizza hut', 'subway',
  'starbucks', 'wendy', 'taco bell', 'nando', 'papa john', 'dunkin', 'hyatt',
  'marriott', 'costa coffee', 'cafe coffee day', 'ccd ', 'applebee',
];

const isAllowed = (licence) => Boolean(licence) && ALLOWED.some((re) => re.test(licence.trim()));

const strip = (html) =>
  String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Commons rate-limits bursts hard, so requests are paced and a 429 backs off
 * and retries rather than losing the dish.
 */
async function api(params, attempt = 1) {
  const url = `${API}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });

  if (res.status === 429 && attempt <= 5) {
    const wait = 4000 * attempt;
    process.stdout.write(`(rate-limited, waiting ${wait / 1000}s) `);
    await sleep(wait);
    return api(params, attempt + 1);
  }

  if (!res.ok) throw new Error(`Commons API ${res.status}`);
  return res.json();
}

/**
 * Looks up one exact Commons file. Used when a dish pins `image_file`, so a
 * reviewed photo never silently changes when search rankings move.
 */
async function fetchByTitle(fileName) {
  const data = await api({
    action: 'query',
    titles: `File:${fileName}`,
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata|mime',
    iiurlwidth: String(THUMB_WIDTH),
  });

  const page = Object.values(data?.query?.pages || {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) return null;

  const meta = info.extmetadata || {};
  const licence = strip(meta.LicenseShortName?.value);
  if (!isAllowed(licence)) throw new Error(`pinned file licence not permitted: ${licence}`);

  return {
    title: page.title.replace(/^File:/, ''),
    thumb: info.thumburl,
    descriptionUrl: info.descriptionurl,
    licence,
    author: strip(meta.Artist?.value) || 'Unknown',
    width: info.width,
    height: info.height,
    pinned: true,
  };
}

/** Returns up to `limit` redistributable candidates for a search phrase. */
async function search(query, avoid = [], limit = 14) {
  const data = await api({
    action: 'query',
    generator: 'search',
    gsrsearch: `filetype:bitmap ${query}`,
    gsrnamespace: '6',
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata|mime',
    iiurlwidth: String(THUMB_WIDTH),
  });

  const pages = Object.values(data?.query?.pages || {});
  const out = [];

  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info) continue;

    const meta = info.extmetadata || {};
    const licence = strip(meta.LicenseShortName?.value);
    if (!isAllowed(licence)) continue;
    if (!/^image\/(jpeg|png)$/.test(info.mime || '')) continue;
    if ((info.width || 0) < MIN_WIDTH) continue;

    const ratio = info.width / info.height;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) continue;

    const title = page.title.replace(/^File:/, '');
    const lower = title.toLowerCase();
    if (BAD_WORDS.some((word) => lower.includes(word))) continue;
    if (BRANDS.some((brand) => lower.includes(brand))) continue;
    if (avoid.some((word) => lower.includes(word))) continue;

    out.push({
      title,
      thumb: info.thumburl,
      descriptionUrl: info.descriptionurl,
      licence,
      author: strip(meta.Artist?.value) || 'Unknown',
      width: info.width,
      height: info.height,
      score: scoreCandidate(lower, ratio, query),
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

/**
 * Ranks a candidate: a filename that actually names the dish beats one that
 * merely mentions it, and a near-4:3 frame beats a wide one.
 */
function scoreCandidate(lowerTitle, ratio, query) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const matched = words.filter((w) => lowerTitle.includes(w)).length;

  let score = matched * 10;
  if (words.length > 0 && matched === words.length) score += 15; // every term present
  score -= Math.abs(ratio - IDEAL_RATIO) * 12;                   // closer to 4:3 is better
  score -= Math.min(lowerTitle.split(/[\s_-]+/).length, 14) * 0.6; // terse names are usually single-subject
  return score;
}

async function download(url, destination) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 8000) throw new Error('suspiciously small image');
  fs.writeFileSync(destination, buffer);
  return buffer.length;
}

/** Merges new attributions into the sidecar and re-renders CREDITS.md in full. */
function writeCredits(fresh) {
  let stored = {};
  if (fs.existsSync(CREDITS_DATA)) {
    try {
      stored = JSON.parse(fs.readFileSync(CREDITS_DATA, 'utf8'));
    } catch {
      stored = {};
    }
  }

  for (const entry of fresh) {
    stored[entry.slug] = {
      dish: entry.dish,
      file: entry.title,
      author: entry.author,
      licence: entry.licence,
      source: entry.descriptionUrl,
    };
  }

  fs.writeFileSync(CREDITS_DATA, `${JSON.stringify(stored, null, 2)}\n`);

  // Render in menu order so the table is easy to scan against the app.
  const ordered = MENU.map((d) => [d.slug, stored[d.slug]]).filter(([, v]) => v);
  const missing = MENU.filter((d) => !stored[d.slug]).map((d) => d.name);

  const header = [
    '# Photo credits',
    '',
    'Every dish photograph below comes from Wikimedia Commons under a licence that',
    'permits redistribution. CC BY and CC BY-SA require attribution, which this file',
    'provides. It is generated from `credits.json` by `scripts/fetch-images.js`; run',
    '`node scripts/fetch-images.js --credits-only` to rebuild it.',
    '',
    `${ordered.length} of ${MENU.length} dishes credited.`
      + (missing.length ? ` **Missing: ${missing.join(', ')}**` : ''),
    '',
    '| Dish | File | Author | Licence | Source |',
    '| --- | --- | --- | --- | --- |',
  ].join('\n');

  const rows = ordered
    .map(([, c]) => `| ${c.dish} | ${c.file} | ${c.author} | ${c.licence} | [Commons](${c.source}) |`)
    .join('\n');

  fs.writeFileSync(CREDITS, `${header}\n${rows}\n`);
  console.log(`\n  CREDITS.md rewritten — ${ordered.length}/${MENU.length} dishes credited`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const candidateMode = args.includes('--candidates');
  // Rebuild attributions from the pinned/queried sources without re-downloading
  // any image — used to repair CREDITS.md after a partial run.
  const creditsOnly = args.includes('--credits-only');
  const only = args.filter((a) => !a.startsWith('--'));

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const targets = MENU.filter((dish) => (only.length ? only.includes(dish.slug) : true));
  const credits = [];
  let fetched = 0;
  let skipped = 0;

  for (const dish of targets) {
    const file = path.join(OUT_DIR, `${dish.slug}.jpg`);

    if (!force && !candidateMode && !creditsOnly && fs.existsSync(file)) {
      skipped += 1;
      continue;
    }

    process.stdout.write(`${dish.slug.padEnd(24)} `);

    try {
      await sleep(1200); // stay well inside the Commons request budget
      const avoid = (dish.image_avoid || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

      const candidates = dish.image_file
        ? [await fetchByTitle(dish.image_file)].filter(Boolean)
        : await search(dish.image_query, avoid);

      if (candidates.length === 0) {
        console.log(dish.image_file ? '✗ pinned file not found' : '✗ no openly-licensed match');
        continue;
      }

      if (candidateMode) {
        // Save several options side by side so a human can pick the best one.
        for (const [i, candidate] of candidates.slice(0, 4).entries()) {
          await download(candidate.thumb, path.join(OUT_DIR, `_candidate-${dish.slug}-${i}.jpg`));
        }
        console.log(`saved ${Math.min(4, candidates.length)} candidates`);
        continue;
      }

      const pick = candidates[0];

      if (creditsOnly) {
        credits.push({ slug: dish.slug, dish: dish.name, ...pick });
        console.log(`· credit — ${pick.licence} — ${pick.title.slice(0, 46)}`);
        continue;
      }

      const bytes = await download(pick.thumb, file);
      credits.push({ slug: dish.slug, dish: dish.name, ...pick });
      fetched += 1;
      console.log(`${pick.pinned ? '📌' : '✓'} ${(bytes / 1024).toFixed(0)}KB  ${pick.licence}  — ${pick.title.slice(0, 50)}`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
    }
  }

  if (credits.length > 0) writeCredits(credits);

  console.log(`\nDone — ${fetched} downloaded, ${skipped} already present.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

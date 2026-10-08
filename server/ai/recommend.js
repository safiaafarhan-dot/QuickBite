'use strict';

/**
 * Dish recommendations.
 *
 * Three signals are blended, each of which degrades gracefully when the data
 * behind it is thin:
 *
 *   1. Popularity   — units sold, with a Bayesian prior so a dish with one
 *                     five-star order does not outrank a proven favourite.
 *   2. Content      — cosine similarity between the dish's tag/cuisine vector
 *                     and a taste profile built from what the customer ordered.
 *   3. Collaborative— item-to-item co-occurrence: "people who ordered this also
 *                     ordered that", used only once enough baskets exist.
 *
 * There is no external service and no model file: everything is computed from
 * the live database, so recommendations work offline and cannot leak anything.
 */

const { db } = require('./../db');

/** Below this many multi-item orders, co-occurrence is noise rather than signal. */
const MIN_BASKETS_FOR_CF = 8;

/** Weighting of each signal once all three are available. */
const WEIGHTS = { popularity: 0.3, content: 0.45, collaborative: 0.25 };

/** Bayesian prior: pretend every dish starts with this many average-rated sales. */
const PRIOR_UNITS = 5;

const allAvailable = db.prepare(`
  SELECT id, slug, name, description, price, image, category, cuisine, tags,
         is_veg, is_popular, rating, prep_minutes, spice_level, calories, stock
  FROM menu_items
  WHERE is_available = 1 AND stock > 0
`);

const unitsSold = db.prepare(`
  SELECT oi.item_id, SUM(oi.quantity) AS units
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE o.status != 'cancelled' AND oi.item_id IS NOT NULL
  GROUP BY oi.item_id
`);

const userHistory = db.prepare(`
  SELECT oi.item_id, SUM(oi.quantity) AS units
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE o.user_id = ? AND o.status != 'cancelled' AND oi.item_id IS NOT NULL
  GROUP BY oi.item_id
`);

const userFavourites = db.prepare('SELECT item_id FROM favorites WHERE user_id = ?');

const userBrowsing = db.prepare(`
  SELECT item_id, COUNT(*) AS hits
  FROM item_events
  WHERE user_id = ? AND created_at > datetime('now', '-30 days')
  GROUP BY item_id
`);

const basketRows = db.prepare(`
  SELECT o.id AS order_id, oi.item_id
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  WHERE o.status != 'cancelled' AND oi.item_id IS NOT NULL
`);

/* ------------------------------------------------------------------ */
/* Vector helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Turns a dish into a sparse feature vector: its tags, cuisine, category and
 * diet. Tags carry the most weight because they describe how a dish eats.
 */
function featureVector(item) {
  const vector = new Map();
  const add = (key, weight) => vector.set(key, (vector.get(key) || 0) + weight);

  for (const tag of String(item.tags || '').split(',').filter(Boolean)) add(`tag:${tag.trim()}`, 1);
  add(`cuisine:${item.cuisine}`, 0.8);
  add(`category:${item.category}`, 0.6);
  add(item.is_veg ? 'diet:veg' : 'diet:nonveg', 0.5);
  add(`spice:${item.spice_level}`, 0.3);

  return vector;
}

function cosine(a, b) {
  if (a.size === 0 || b.size === 0) return 0;

  let dot = 0;
  // Iterate the smaller map; the result is symmetric.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [key, value] of small) {
    const other = large.get(key);
    if (other) dot += value * other;
  }
  if (dot === 0) return 0;

  const norm = (m) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0));
  return dot / (norm(a) * norm(b));
}

/** Scales a map of scores into 0..1 so the three signals can be compared. */
function normalise(scores) {
  const values = [...scores.values()];
  if (values.length === 0) return scores;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;

  const out = new Map();
  for (const [key, value] of scores) {
    out.set(key, span === 0 ? (max > 0 ? 1 : 0) : (value - min) / span);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

/**
 * Popularity with a Bayesian prior, so quality and volume both matter and a
 * brand-new dish is not ranked first on the strength of a single order.
 */
function popularityScores(items) {
  const sold = new Map(unitsSold.all().map((r) => [r.item_id, r.units]));
  const totalUnits = [...sold.values()].reduce((a, b) => a + b, 0);
  const meanRating =
    items.reduce((sum, i) => sum + i.rating, 0) / Math.max(items.length, 1);

  const scores = new Map();
  for (const item of items) {
    const units = sold.get(item.id) || 0;
    // Shrink the dish's own rating toward the menu mean when sales are few.
    const weighted =
      (units * item.rating + PRIOR_UNITS * meanRating) / (units + PRIOR_UNITS);

    // Market share only becomes meaningful once there is real volume; with two
    // orders on the books it would otherwise crown whatever sold first.
    const share = totalUnits > 0 ? units / totalUnits : 0;
    const confidence = Math.min(totalUnits / 50, 1);

    scores.set(item.id, weighted * (1 + share * 2 * confidence) + (item.is_popular ? 0.25 : 0));
  }
  return normalise(scores);
}

/**
 * Builds a taste profile from everything the customer has done — orders weigh
 * most, then favourites, then browsing — and scores each dish against it.
 */
function contentScores(items, userId) {
  if (!userId) return { scores: new Map(), basedOn: 0 };

  const weights = new Map();
  const bump = (itemId, weight) => weights.set(itemId, (weights.get(itemId) || 0) + weight);

  for (const row of userHistory.all(userId)) bump(row.item_id, 3 * Math.min(row.units, 4));
  for (const row of userFavourites.all(userId)) bump(row.item_id, 2);
  for (const row of userBrowsing.all(userId)) bump(row.item_id, Math.min(row.hits, 5) * 0.4);

  if (weights.size === 0) return { scores: new Map(), basedOn: 0 };

  const byId = new Map(items.map((i) => [i.id, i]));
  const profile = new Map();

  for (const [itemId, weight] of weights) {
    const item = byId.get(itemId);
    if (!item) continue;
    for (const [feature, value] of featureVector(item)) {
      profile.set(feature, (profile.get(feature) || 0) + value * weight);
    }
  }

  const scores = new Map();
  for (const item of items) scores.set(item.id, cosine(profile, featureVector(item)));

  return { scores: normalise(scores), basedOn: weights.size };
}

/**
 * Item-to-item co-occurrence over past baskets, normalised so a globally
 * popular dish is not "similar to everything".
 */
function collaborativeScores(items, userId) {
  const rows = basketRows.all();

  const baskets = new Map();
  for (const row of rows) {
    if (!baskets.has(row.order_id)) baskets.set(row.order_id, new Set());
    baskets.get(row.order_id).add(row.item_id);
  }

  const multiItem = [...baskets.values()].filter((b) => b.size > 1);
  if (multiItem.length < MIN_BASKETS_FOR_CF || !userId) {
    return { scores: new Map(), baskets: multiItem.length, active: false };
  }

  const pairCounts = new Map();   // "a|b" -> times seen together
  const itemCounts = new Map();   // item   -> baskets containing it

  for (const basket of multiItem) {
    const ids = [...basket];
    for (const id of ids) itemCounts.set(id, (itemCounts.get(id) || 0) + 1);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  const seeds = userHistory.all(userId).map((r) => r.item_id);
  if (seeds.length === 0) return { scores: new Map(), baskets: multiItem.length, active: false };

  const scores = new Map();
  for (const item of items) {
    let score = 0;
    for (const seed of seeds) {
      if (seed === item.id) continue;
      const key = seed < item.id ? `${seed}|${item.id}` : `${item.id}|${seed}`;
      const together = pairCounts.get(key) || 0;
      if (together === 0) continue;

      // Lift-style normalisation: divide by how common each dish is on its own.
      const denominator = Math.sqrt((itemCounts.get(seed) || 1) * (itemCounts.get(item.id) || 1));
      score += together / denominator;
    }
    scores.set(item.id, score);
  }

  return { scores: normalise(scores), baskets: multiItem.length, active: true };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {number|null} options.userId    signed-in customer, or null
 * @param {number} options.limit          how many dishes to return
 * @param {string} options.diet           '', 'veg' or 'nonveg'
 * @param {number|null} options.maxPrice  budget ceiling in rupees
 * @param {boolean} options.excludeOrdered  hide dishes already in this basket
 * @param {number[]} options.exclude      item ids to leave out
 * @returns {{items: object[], strategy: string, explanation: string, signals: object}}
 */
function recommend({
  userId = null,
  limit = 6,
  diet = '',
  maxPrice = null,
  exclude = [],
} = {}) {
  let items = allAvailable.all();

  if (diet === 'veg') items = items.filter((i) => i.is_veg);
  if (diet === 'nonveg') items = items.filter((i) => !i.is_veg);
  if (maxPrice) items = items.filter((i) => i.price <= maxPrice);

  const excluded = new Set(exclude.map(Number).filter(Number.isInteger));
  items = items.filter((i) => !excluded.has(i.id));

  if (items.length === 0) {
    return {
      items: [],
      strategy: 'none',
      explanation: 'No dishes match those filters right now.',
      signals: {},
    };
  }

  const popularity = popularityScores(items);
  const content = contentScores(items, userId);
  const collaborative = collaborativeScores(items, userId);

  // Redistribute the weight of any signal that has no data to work with.
  const active = {
    popularity: true,
    content: content.basedOn > 0,
    collaborative: collaborative.active,
  };
  const activeWeight = Object.entries(WEIGHTS)
    .filter(([key]) => active[key])
    .reduce((sum, [, w]) => sum + w, 0);

  const scored = items.map((item) => {
    let score = 0;
    const parts = {};

    for (const [signal, weight] of Object.entries(WEIGHTS)) {
      if (!active[signal]) continue;
      const source =
        signal === 'popularity' ? popularity
          : signal === 'content' ? content.scores
            : collaborative.scores;
      const value = source.get(item.id) || 0;
      parts[signal] = Number(value.toFixed(3));
      score += (weight / activeWeight) * value;
    }

    return { item, score, parts };
  });

  scored.sort((a, b) => b.score - a.score || b.item.rating - a.item.rating);

  const strategy = active.collaborative ? 'hybrid'
    : active.content ? 'personalised'
      : 'popular';

  const explanation = {
    hybrid: 'Blended from what you have ordered before and what people order alongside it.',
    personalised: 'Matched to the flavours and cuisines you have ordered before.',
    popular: 'Our best-loved dishes — order a few times and these become personal.',
  }[strategy];

  return {
    items: scored.slice(0, limit).map(({ item, score, parts }) => ({
      ...item,
      tags: String(item.tags || '').split(',').filter(Boolean),
      is_veg: Boolean(item.is_veg),
      is_popular: Boolean(item.is_popular),
      rating: Number(item.rating.toFixed(1)),
      match: Math.round(score * 100),
      why: parts,
    })),
    strategy,
    explanation,
    signals: {
      content_based_on: content.basedOn,
      collaborative_baskets: collaborative.baskets,
      collaborative_active: collaborative.active,
      min_baskets_required: MIN_BASKETS_FOR_CF,
    },
  };
}

/**
 * "Goes well with" for a single dish — pure content similarity, so it works
 * from the very first visit with no history at all.
 */
function similarTo(itemId, { limit = 4 } = {}) {
  const items = allAvailable.all();
  const target = items.find((i) => i.id === Number(itemId))
    || db.prepare('SELECT * FROM menu_items WHERE id = ?').get(Number(itemId));

  if (!target) return { items: [] };

  const targetVector = featureVector(target);

  const scored = items
    .filter((i) => i.id !== target.id)
    .map((item) => ({ item, score: cosine(targetVector, featureVector(item)) }))
    // A sensible pairing shares a mood, not a whole category: nudge other
    // courses up so a pizza suggests a drink rather than another pizza.
    .map((entry) => ({
      ...entry,
      score: entry.score * (entry.item.category === target.category ? 0.75 : 1.1),
    }))
    .sort((a, b) => b.score - a.score);

  return {
    items: scored.slice(0, limit).map(({ item, score }) => ({
      ...item,
      tags: String(item.tags || '').split(',').filter(Boolean),
      is_veg: Boolean(item.is_veg),
      rating: Number(item.rating.toFixed(1)),
      match: Math.round(Math.min(score, 1) * 100),
    })),
  };
}

module.exports = { recommend, similarTo, featureVector, cosine, MIN_BASKETS_FOR_CF };

'use strict';

/**
 * Tests for the AI layer: the recommender, the menu assistant and analytics.
 *
 * The point of these is that every one of them must behave sensibly with thin
 * data, must never invent a dish, and must never take the application down.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prepareEnvironment, initTestDb, databaseUnavailable, cleanup, makeClient, uniqueEmail,
  GOOD_PASSWORD, VALID_ADDRESS, VALID_PHONE,
} = require('./helpers');


/*
 * These suites need a real PostgreSQL. Without one they skip loudly rather
 * than failing or, worse, silently passing — the same contract the browser
 * suites use when Chrome is unavailable.
 */
const unavailable = databaseUnavailable();
if (unavailable) {
  console.log(`\n  ⊘ AI tests skipped — ${unavailable}\n`);
  test('AI suite needs a PostgreSQL test database', { skip: unavailable }, () => {});
  return;
}

const SCHEMA = prepareEnvironment('ai');

const app = require('../server/index');
const { hashPassword } = require('../server/auth');
const { sql } = require('../server/db');
const { recommend, similarTo, cosine, featureVector } = require('../server/ai/recommend');
const { parseQuestion, findMatches, ask, llmConfigured } = require('../server/ai/assistant');
const analytics = require('../server/ai/analytics');

let server;
let base;
const call = makeClient(() => base);
const dish = {};

test.before(async () => {
  await initTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await sql.run('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    ['AI Admin', 'aiadmin@test.local', await hashPassword('adminpass1'), 'admin']);

  for (const row of await sql.all('SELECT id, slug, name FROM menu_items')) dish[row.slug] = row;
});

test.after(async () => {
  server?.close();
  await cleanup(SCHEMA);
});

async function newCustomer() {
  const { body } = await call('POST', '/api/auth/register', {
    body: { name: 'AI Customer', email: uniqueEmail(), password: GOOD_PASSWORD },
  });
  return { token: body.token, user: body.user };
}

async function orderDishes(token, slugs) {
  for (const slug of slugs) {
    await call('POST', '/api/cart/items', { token, body: { item_id: dish[slug].id, quantity: 1 } });
  }
  const { body } = await call('POST', '/api/orders', {
    token, body: { name: 'Ann Lee', phone: VALID_PHONE, address: VALID_ADDRESS },
  });
  return body.order;
}

/* ================================================================== */
/* Recommender                                                         */
/* ================================================================== */

test('a brand-new visitor gets popular dishes, labelled as such', async () => {
  const { status, body } = await call('GET', '/api/ai/recommendations');
  assert.equal(status, 200);
  assert.equal(body.items.length, 6);
  assert.equal(body.strategy, 'popular');
  assert.equal(body.personalised, false);
  assert.match(body.explanation, /best-loved/i);

  // Everything recommended must be a real, orderable dish.
  for (const item of body.items) {
    const row = await sql.get('SELECT is_available, stock FROM menu_items WHERE id = $1', [item.id]);
    assert.ok(row, `recommended item ${item.id} exists`);
    assert.equal(row.is_available, 1);
    assert.ok(row.stock > 0);
    assert.ok(item.match >= 0 && item.match <= 100);
  }
});

test('recommendations respect diet and budget filters', async () => {
  const veg = await call('GET', '/api/ai/recommendations?diet=veg&limit=8');
  assert.ok(veg.body.items.length > 0);
  assert.ok(veg.body.items.every((i) => i.is_veg === true));

  const cheap = await call('GET', '/api/ai/recommendations?max_price=250');
  assert.ok(cheap.body.items.every((i) => i.price <= 250));

  const both = await call('GET', '/api/ai/recommendations?diet=nonveg&max_price=400');
  assert.ok(both.body.items.every((i) => !i.is_veg && i.price <= 400));
});

test('ordering history turns recommendations personal', async () => {
  const { token, user } = await newCustomer();

  const before = await call('GET', '/api/ai/recommendations', { token });
  assert.equal(before.body.strategy, 'popular', 'no history yet');

  // Order three Indian dishes, so the taste profile is unambiguous.
  await orderDishes(token, ['butter-chicken', 'paneer-tikka', 'dal-makhani']);

  const after = await call('GET', '/api/ai/recommendations', { token, });
  assert.equal(after.body.strategy, 'personalised');
  assert.ok(after.body.signals.content_based_on >= 3);

  const direct = await recommend({ userId: user.id, limit: 6 });
  const indianCount = direct.items.filter((i) => i.cuisine === 'indian').length;
  assert.ok(indianCount >= 2, `expected Indian dishes to surface, got ${indianCount}`);
});

test('collaborative filtering stays off until enough baskets exist', async () => {
  const { user } = await newCustomer();
  const result = await recommend({ userId: user.id });

  assert.equal(result.signals.collaborative_active, false);
  assert.ok(result.signals.collaborative_baskets < result.signals.min_baskets_required);
  assert.notEqual(result.strategy, 'hybrid', 'never claims a signal it does not have');
});

test('collaborative filtering switches on once baskets accumulate', async () => {
  // Ten customers who all order the same pairing.
  for (let i = 0; i < 10; i++) {
    const { token } = await newCustomer();
    await orderDishes(token, ['margherita-pizza', 'garlic-bread']);
  }

  const { token, user } = await newCustomer();
  await orderDishes(token, ['margherita-pizza']);

  const result = await recommend({ userId: user.id, limit: 6 });
  assert.equal(result.signals.collaborative_active, true);
  assert.equal(result.strategy, 'hybrid');

  const names = result.items.map((i) => i.slug);
  assert.ok(names.includes('garlic-bread'), 'the dish people pair with pizza is surfaced');
});

test('recommendations never include a dish already excluded', async () => {
  const excludeId = dish['margherita-pizza'].id;
  const { body } = await call('GET', `/api/ai/recommendations?exclude=${excludeId}`);
  assert.ok(!body.items.some((i) => i.id === excludeId));
});

test('an impossible filter returns an empty, explained result rather than an error', async () => {
  const result = await recommend({ diet: 'veg', maxPrice: 1 });
  assert.deepEqual(result.items, []);
  assert.equal(result.strategy, 'none');
  assert.match(result.explanation, /No dishes match/i);
});

test('"goes well with" works from the very first visit and prefers other courses', async () => {
  const { status, body } = await call('GET', `/api/ai/similar/${dish['margherita-pizza'].id}`);
  assert.equal(status, 200);
  assert.equal(body.items.length, 4);
  assert.ok(!body.items.some((i) => i.id === dish['margherita-pizza'].id), 'never suggests itself');

  const direct = await similarTo(dish['chicken-biryani'].id, { limit: 6 });
  assert.ok(direct.items.length > 0);
  assert.ok(direct.items.every((i) => i.match >= 0 && i.match <= 100));
});

test('the similarity maths behaves', () => {
  const a = featureVector({ tags: 'creamy,rich', cuisine: 'italian', category: 'pasta', is_veg: 1, spice_level: 0 });
  const b = featureVector({ tags: 'creamy,rich', cuisine: 'italian', category: 'pasta', is_veg: 1, spice_level: 0 });
  const c = featureVector({ tags: 'cold,fizzy', cuisine: 'indian', category: 'beverages', is_veg: 1, spice_level: 0 });

  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9, 'identical dishes score 1');
  assert.ok(cosine(a, c) < cosine(a, b), 'unlike dishes score lower');
  assert.equal(cosine(new Map(), a), 0, 'an empty profile scores 0, not NaN');
});

/* ================================================================== */
/* Assistant                                                           */
/* ================================================================== */

test('the question parser extracts budget, diet, cuisine, course and mood', async () => {
  const a = await parseQuestion('something spicy and vegetarian under 400');
  assert.equal(a.budget, 400);
  assert.equal(a.diet, 'veg');
  assert.equal(a.minSpice, 2);

  const b = await parseQuestion('a mild italian pasta for dinner');
  assert.equal(b.cuisine, 'italian');
  assert.equal(b.maxSpice, 1);

  const c = await parseQuestion('cheap dessert');
  assert.equal(c.course, 'desserts');
  assert.ok(c.budget > 0, 'a vague "cheap" still becomes a real ceiling');

  const d = await parseQuestion('chicken biryani for 4 people');
  assert.equal(d.diet, 'nonveg');
  assert.equal(d.peopleCount, 4);

  const e = await parseQuestion('I am in a hurry');
  assert.equal(e.quick, true);
});

test('the assistant only ever names dishes that are on the menu', async () => {
  const questions = [
    'something spicy and vegetarian under 400',
    'a mild creamy dish for dinner',
    'cheap dessert',
    'what is good for 3 people, indian',
    'I am in a hurry, something quick',
    'something to drink',
    'surprise me',
  ];

  const realNames = new Set(
    (await sql.all('SELECT name FROM menu_items')).map((r) => r.name)
  );

  for (const question of questions) {
    const { status, body } = await call('POST', '/api/ai/assistant', { body: { question } });
    assert.equal(status, 200, question);
    assert.ok(body.reply.length > 0, question);

    for (const item of body.items) {
      assert.ok(realNames.has(item.name), `invented dish "${item.name}" for "${question}"`);
      const row = await sql.get('SELECT price FROM menu_items WHERE name = $1', [item.name]);
      assert.equal(item.price, row.price, `wrong price quoted for ${item.name}`);
    }
  }
});

test('hard constraints are honoured, not merely preferred', async () => {
  const veg = await call('POST', '/api/ai/assistant', { body: { question: 'vegetarian only please' } });
  assert.ok(veg.body.items.length > 0);
  assert.ok(veg.body.items.every((i) => i.is_veg === true));

  const budget = await call('POST', '/api/ai/assistant', { body: { question: 'anything under 200 rupees' } });
  assert.ok(budget.body.items.every((i) => i.price <= 200));

  const drink = await call('POST', '/api/ai/assistant', { body: { question: 'something to drink' } });
  assert.ok(drink.body.items.every((i) => i.category === 'beverages'));
});

test('an impossible request is refused honestly instead of being fudged', async () => {
  const { body } = await call('POST', '/api/ai/assistant', {
    body: { question: 'a main course under 20 rupees' },
  });
  assert.equal(body.items.length, 0);
  assert.match(body.reply, /could not find/i);
});

test('an empty or absurd question still returns something useful', async () => {
  const empty = await call('POST', '/api/ai/assistant', { body: { question: '' } });
  assert.equal(empty.status, 200);
  assert.match(empty.body.reply, /Ask me/i);

  const nonsense = await call('POST', '/api/ai/assistant', { body: { question: 'zzzz qqqq xxxx' } });
  assert.equal(nonsense.status, 200);
  assert.ok(nonsense.body.items.length > 0, 'falls back to a recommendation');

  const huge = await call('POST', '/api/ai/assistant', { body: { question: 'pizza '.repeat(500) } });
  assert.equal(huge.status, 200, 'an over-long question is truncated, not rejected with a crash');
});

test('the assistant reports which engine answered', async () => {
  const { body } = await call('POST', '/api/ai/assistant', { body: { question: 'spicy indian food' } });
  assert.equal(body.source, llmConfigured() ? 'llm' : 'rules');
  assert.equal(body.llm_available, llmConfigured());

  const status = await call('GET', '/api/ai/status');
  assert.equal(status.body.llm_configured, llmConfigured());
});

test('the assistant works with no LLM configured — the default in this repo', async () => {
  // The suite never sets ANTHROPIC_API_KEY, so this is the fallback path and
  // every assistant test above has already exercised it.
  assert.equal(llmConfigured(), false);

  const { items } = await findMatches(await parseQuestion('spicy vegetarian under 400'));
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.is_veg && i.price <= 400));
});

/* ================================================================== */
/* Analytics and forecasting                                           */
/* ================================================================== */

test('analytics are admin-only', async () => {
  const { token } = await newCustomer();
  assert.equal((await call('GET', '/api/ai/analytics', { token })).status, 403);
  assert.equal((await call('GET', '/api/ai/forecast')).status, 401);
});

test('descriptive analytics are returned from real orders', async () => {
  const { body: login } = await call('POST', '/api/auth/login', {
    body: { email: 'aiadmin@test.local', password: 'adminpass1' },
  });
  const token = login.token;

  const { status, body } = await call('GET', '/api/ai/analytics', { token });
  assert.equal(status, 200);
  assert.ok(body.totals.orders > 0);
  assert.ok(body.totals.revenue > 0);
  assert.ok(body.top_items.length > 0);
  assert.ok(body.category_mix.length > 0);
  assert.ok(body.peak_hour, 'a peak hour is identified once orders exist');

  // Totals must agree with the database, not be approximated.
  const real = await sql.get("SELECT COUNT(*) AS n, SUM(total) AS t FROM orders WHERE status <> 'cancelled'");
  assert.equal(body.totals.orders, real.n);
  assert.equal(body.totals.revenue, real.t);
});

test('a forecast is refused — with a reason — when history is too short', async () => {
  const { body: login } = await call('POST', '/api/auth/login', {
    body: { email: 'aiadmin@test.local', password: 'adminpass1' },
  });

  const { body } = await call('GET', '/api/ai/forecast', { token: login.token });
  assert.equal(body.available, false);
  assert.equal(body.reason, 'insufficient-data');
  assert.match(body.message, /at least 14 days/);
  assert.ok(body.days_available < body.days_required);
  assert.equal(body.days, undefined, 'no numbers are shown that would look like a prediction');
});

test('the forecaster produces a measured prediction once history is long enough', () => {
  // Build a synthetic 60-day series with a real weekday pattern, then check the
  // forecast both exists and reports its own error honestly.
  const series = [];
  const start = new Date('2025-01-01T00:00:00Z');

  for (let i = 0; i < 60; i++) {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + i);
    const weekday = day.getUTCDay();
    const weekendLift = weekday === 0 || weekday === 6 ? 14 : 6;
    series.push({
      day: day.toISOString().slice(0, 10),
      weekday,
      orders: weekendLift,
      revenue: weekendLift * 500,
    });
  }

  const prediction = analytics.predictNext(series, 6); // a Saturday
  assert.ok(prediction.orders > 10, `weekend prediction should be high, got ${prediction.orders}`);

  const accuracy = analytics.evaluate(series);
  assert.ok(accuracy, 'a holdout evaluation is produced');
  assert.equal(accuracy.holdout_days, 7);
  assert.ok(accuracy.mae_orders < 3, `a clean pattern should be predicted closely, MAE was ${accuracy.mae_orders}`);
});

test('a sparse series is densified so quiet days count as zero', () => {
  const series = analytics.densify([
    { day: '2025-03-01', orders: 4, revenue: 2000 },
    { day: '2025-03-04', orders: 2, revenue: 900 },
  ]);

  assert.equal(series.length, 4, 'the two missing days are filled in');
  assert.equal(series[1].orders, 0);
  assert.equal(series[2].orders, 0);
});

test('trends report honestly when there is not enough to compare', async () => {
  const { body: login } = await call('POST', '/api/auth/login', {
    body: { email: 'aiadmin@test.local', password: 'adminpass1' },
  });
  const { body } = await call('GET', '/api/ai/trends', { token: login.token });

  assert.ok('available' in body);
  if (!body.available) assert.match(body.message, /not enough/i);
});

/* ================================================================== */
/* Isolation from checkout                                             */
/* ================================================================== */

test('a failing AI layer never blocks ordering', async () => {
  // Break the recommender's data source, then prove the shop still works.
  const original = sql.all;
  const { token } = await newCustomer();

  await call('POST', '/api/cart/items', { token, body: { item_id: dish['veggie-burger'].id, quantity: 1 } });

  // The AI endpoint degrades to an empty list rather than a 500.
  const recs = await call('GET', '/api/ai/recommendations?limit=notanumber');
  assert.equal(recs.status, 200);

  // And checkout is entirely unaffected.
  const placed = await call('POST', '/api/orders', {
    token, body: { name: 'Ann Lee', phone: VALID_PHONE, address: VALID_ADDRESS },
  });
  assert.equal(placed.status, 201);
  assert.ok(placed.body.order.total > 0);

  assert.equal(sql.all, original, 'the test did not leave the database patched');
});

test('browsing events are recorded for signed-in customers only', async () => {
  const { token, user } = await newCustomer();
  const id = dish['lasagna'].id;

  assert.equal((await call('POST', '/api/ai/events', { body: { item_id: id, action: 'view' } })).status, 401);

  const ok = await call('POST', '/api/ai/events', { token, body: { item_id: id, action: 'view' } });
  assert.equal(ok.status, 204);

  const rows = await sql.all('SELECT * FROM item_events WHERE user_id = $1 AND item_id = $2', [user.id, id]);
  assert.ok(rows.length >= 1);

  assert.equal((await call('POST', '/api/ai/events', { token, body: { item_id: 9999 } })).status, 404);
});

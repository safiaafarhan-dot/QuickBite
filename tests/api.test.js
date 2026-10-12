'use strict';

/**
 * End-to-end API tests: auth, authorization boundaries, cart maths, coupon
 * rules, checkout, stock, idempotency, the order lifecycle and admin routes.
 *
 * Runs against a throwaway SQLite file — see tests/helpers.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prepareEnvironment, cleanup, makeClient, uniqueEmail,
  GOOD_PASSWORD, VALID_ADDRESS, VALID_PHONE,
} = require('./helpers');

const DB_FILE = prepareEnvironment('api');

const app = require('../server/index');
const { hashPassword } = require('../server/auth');
const { db } = require('../server/db');

let server;
let base;
const call = makeClient(() => base);

/** Dish ids are resolved by slug so the tests survive menu changes. */
const dish = {};

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
    'Test Admin', 'admin@test.local', await hashPassword('adminpass1'), 'admin'
  );

  for (const row of db.prepare('SELECT id, slug, price FROM menu_items').all()) {
    dish[row.slug] = row;
  }
});

test.after(() => {
  server?.close();
  db.close();
  cleanup(DB_FILE);
});

async function newCustomer() {
  const email = uniqueEmail();
  const { body } = await call('POST', '/api/auth/register', {
    body: { name: 'Test Customer', email, password: GOOD_PASSWORD },
  });
  return { token: body.token, user: body.user, email };
}

async function adminToken() {
  const { body } = await call('POST', '/api/auth/login', {
    body: { email: 'admin@test.local', password: 'adminpass1' },
  });
  return body.token;
}

/** Places an order for a fresh customer and returns it. */
async function placeOrder(token, { itemSlug = 'margherita-pizza', quantity = 1, coupon } = {}) {
  await call('POST', '/api/cart/items', {
    token, body: { item_id: dish[itemSlug].id, quantity },
  });
  const { body, status } = await call('POST', '/api/orders', {
    token,
    body: { name: 'Ann Lee', phone: VALID_PHONE, address: VALID_ADDRESS, coupon },
  });
  return { order: body.order, status, error: body.error };
}

/* ================================================================== */
/* Health and menu                                                     */
/* ================================================================== */

test('health check reports the database, migrations and menu size', async () => {
  const { status, body } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.migrations >= 8, 'every migration has run');
  assert.equal(body.menu_items, 30);
});

test('menu lists 30 dishes across 8 categories with full attributes', async () => {
  const { status, body } = await call('GET', '/api/menu');
  assert.equal(status, 200);
  assert.equal(body.items.length, 30);
  assert.equal(body.categories.length, 8);

  const pizza = body.items.find((i) => i.slug === 'margherita-pizza');
  assert.equal(pizza.is_veg, true);
  assert.equal(pizza.cuisine, 'italian');
  assert.ok(Array.isArray(pizza.tags) && pizza.tags.length > 0);
  assert.ok(pizza.calories > 0);
  assert.ok(typeof pizza.spice_level === 'number');
  assert.ok(pizza.image.startsWith('images/dishes/'));
});

test('menu supports search, diet, cuisine, budget, spice and sort', async () => {
  const search = await call('GET', '/api/menu?q=biryani');
  assert.ok(search.body.items.length >= 2);
  assert.ok(search.body.items.every((i) => /biryani/i.test(`${i.name} ${i.description}`)));

  const veg = await call('GET', '/api/menu?diet=veg');
  assert.ok(veg.body.items.every((i) => i.is_veg === true));
  assert.ok(veg.body.items.length < 30, 'the veg filter actually removes dishes');

  const indian = await call('GET', '/api/menu?cuisine=indian');
  assert.ok(indian.body.items.every((i) => i.cuisine === 'indian'));

  const budget = await call('GET', '/api/menu?max_price=250');
  assert.ok(budget.body.items.every((i) => i.price <= 250));
  assert.ok(budget.body.items.length > 0);

  const mild = await call('GET', '/api/menu?spice=1');
  assert.ok(mild.body.items.every((i) => i.spice_level <= 1));

  const cheap = await call('GET', '/api/menu?sort=price-asc');
  const prices = cheap.body.items.map((i) => i.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  const quickest = await call('GET', '/api/menu?sort=quickest');
  assert.ok(quickest.body.items[0].prep_minutes <= quickest.body.items.at(-1).prep_minutes);
});

test('a dish can be fetched by slug as well as id, with its reviews', async () => {
  const bySlug = await call('GET', '/api/menu/margherita-pizza');
  assert.equal(bySlug.status, 200);
  assert.equal(bySlug.body.item.slug, 'margherita-pizza');
  assert.ok('count' in bySlug.body.reviews);

  const byId = await call('GET', `/api/menu/${dish['margherita-pizza'].id}`);
  assert.equal(byId.body.item.id, bySlug.body.item.id);

  assert.equal((await call('GET', '/api/menu/no-such-dish')).status, 404);
});

/* ================================================================== */
/* Authentication and authorization                                    */
/* ================================================================== */

test('registration validates name, email and password strength', async () => {
  const cases = [
    [{ name: 'A', email: uniqueEmail(), password: GOOD_PASSWORD }, /name/i],
    [{ name: 'Valid Name', email: 'not-an-email', password: GOOD_PASSWORD }, /email/i],
    [{ name: 'Valid Name', email: uniqueEmail(), password: 'short1' }, /8 characters/i],
    [{ name: 'Valid Name', email: uniqueEmail(), password: 'allletters' }, /letter and one number/i],
    [{ name: 'Valid Name', email: uniqueEmail(), password: 'password1' }, /too common/i],
  ];

  for (const [body, pattern] of cases) {
    const res = await call('POST', '/api/auth/register', { body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.match(res.body.error, pattern);
  }
});

test('registration refuses duplicate emails and never returns the hash', async () => {
  const email = uniqueEmail();
  const first = await call('POST', '/api/auth/register', {
    body: { name: 'First User', email, password: GOOD_PASSWORD },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.user.password_hash, undefined);

  const dupe = await call('POST', '/api/auth/register', {
    body: { name: 'Second User', email, password: GOOD_PASSWORD },
  });
  assert.equal(dupe.status, 409);
});

test('an account cannot make itself an admin at registration', async () => {
  const { body } = await call('POST', '/api/auth/register', {
    body: { name: 'Sneaky User', email: uniqueEmail(), password: GOOD_PASSWORD, role: 'admin' },
  });
  assert.equal(body.user.role, 'customer');
  assert.equal((await call('GET', '/api/admin/stats', { token: body.token })).status, 403);
});

test('login succeeds with the right password and fails with the wrong one', async () => {
  const email = uniqueEmail();
  await call('POST', '/api/auth/register', { body: { name: 'Login Test', email, password: GOOD_PASSWORD } });

  const ok = await call('POST', '/api/auth/login', { body: { email, password: GOOD_PASSWORD } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);

  const bad = await call('POST', '/api/auth/login', { body: { email, password: 'wrongpass1' } });
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /incorrect/);

  const missing = await call('POST', '/api/auth/login', {
    body: { email: 'nobody@test.local', password: GOOD_PASSWORD },
  });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, bad.body.error, 'the same message for both, so accounts cannot be enumerated');
});

test('protected routes reject missing, malformed and forged tokens', async () => {
  for (const route of ['/api/cart', '/api/orders', '/api/addresses']) {
    assert.equal((await call('GET', route)).status, 401, route);
    assert.equal((await call('GET', route, { token: 'not.a.token' })).status, 401, route);
  }

  // A token signed with a different secret must not be accepted.
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ sub: 1, role: 'admin' }, 'a-different-secret');
  assert.equal((await call('GET', '/api/admin/stats', { token: forged })).status, 401);
});

test('a customer may update only their own profile', async () => {
  const { token } = await newCustomer();

  const updated = await call('PATCH', '/api/auth/me', {
    token, body: { name: 'Renamed Person', phone: VALID_PHONE },
  });
  assert.equal(updated.body.user.name, 'Renamed Person');

  const bad = await call('PATCH', '/api/auth/me', { token, body: { phone: 'not-a-phone!!' } });
  assert.equal(bad.status, 400);
});

/* ================================================================== */
/* Cart                                                                */
/* ================================================================== */

test('cart add, update, remove and clear keep totals server-authoritative', async () => {
  const { token } = await newCustomer();
  const pizza = dish['margherita-pizza'];   // ₹450

  const added = await call('POST', '/api/cart/items', {
    token, body: { item_id: pizza.id, quantity: 2 },
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.count, 2);
  assert.equal(added.body.subtotal, 900);
  assert.equal(added.body.delivery_fee, 0);       // free above ₹500
  assert.equal(added.body.small_order_fee, 0);
  assert.equal(added.body.tax, 45);               // 5% GST
  assert.equal(added.body.total, 945);

  const one = await call('PATCH', `/api/cart/items/${pizza.id}`, { token, body: { quantity: 1 } });
  assert.equal(one.body.subtotal, 450);
  assert.equal(one.body.delivery_fee, 40);        // below the free-delivery threshold
  assert.equal(one.body.total, 450 + 40 + 23);

  const removed = await call('PATCH', `/api/cart/items/${pizza.id}`, { token, body: { quantity: 0 } });
  assert.equal(removed.body.items.length, 0);
  assert.equal(removed.body.total, 0);

  await call('POST', '/api/cart/items', { token, body: { item_id: pizza.id, quantity: 1 } });
  const cleared = await call('DELETE', '/api/cart', { token });
  assert.equal(cleared.body.count, 0);
});

test('a small basket picks up the small-order fee', async () => {
  const { token } = await newCustomer();
  const chai = dish['masala-chai'];   // ₹90

  const { body } = await call('POST', '/api/cart/items', { token, body: { item_id: chai.id, quantity: 1 } });
  assert.equal(body.subtotal, 90);
  assert.equal(body.small_order_fee, 20);
  assert.equal(body.delivery_fee, 40);
  assert.equal(body.total, 90 + 20 + 40 + 5);
});

test('cart rejects unknown items and out-of-range quantities', async () => {
  const { token } = await newCustomer();
  const id = dish['margherita-pizza'].id;

  assert.equal((await call('POST', '/api/cart/items', { token, body: { item_id: 9999, quantity: 1 } })).status, 404);
  assert.equal((await call('POST', '/api/cart/items', { token, body: { item_id: id, quantity: 0 } })).status, 400);
  assert.equal((await call('POST', '/api/cart/items', { token, body: { item_id: id, quantity: -3 } })).status, 400);
  assert.equal((await call('PATCH', `/api/cart/items/${id}`, { token, body: { quantity: 999 } })).status, 400);
});

test('one customer can never see or change another customer cart', async () => {
  const a = await newCustomer();
  const b = await newCustomer();

  await call('POST', '/api/cart/items', { token: a.token, body: { item_id: dish['lasagna'].id, quantity: 2 } });

  const theirs = await call('GET', '/api/cart', { token: b.token });
  assert.equal(theirs.body.count, 0, "B must not see A's basket");

  await call('DELETE', '/api/cart', { token: b.token });
  const mine = await call('GET', '/api/cart', { token: a.token });
  assert.equal(mine.body.count, 2, "B clearing their cart must not touch A's");
});

test('merging a guest cart folds quantities into the account cart', async () => {
  const { token } = await newCustomer();
  const pizza = dish['margherita-pizza'];
  const pasta = dish['arrabbiata'];

  await call('POST', '/api/cart/items', { token, body: { item_id: pizza.id, quantity: 1 } });

  const merged = await call('POST', '/api/cart/merge', {
    token,
    body: {
      items: [
        { item_id: pizza.id, quantity: 2 },
        { item_id: pasta.id, quantity: 1 },
        { item_id: 9999, quantity: 5 },
      ],
    },
  });

  assert.equal(merged.body.items.find((l) => l.item_id === pizza.id).quantity, 3);
  assert.equal(merged.body.items.length, 2, 'the unknown item is ignored');
});

test('guest quote prices a basket without storing a cart', async () => {
  const pizza = dish['margherita-pizza'];   // ₹450
  const burger = dish['veggie-burger'];     // ₹400

  const { status, body } = await call('POST', '/api/menu/quote', {
    body: { items: [{ item_id: pizza.id, quantity: 1 }, { item_id: burger.id, quantity: 1 }], coupon: 'QUICK10' },
  });

  assert.equal(status, 200);
  assert.equal(body.subtotal, 850);
  assert.equal(body.discount, 85);
  assert.equal(body.coupon.code, 'QUICK10');

  const junk = await call('POST', '/api/menu/quote', { body: { items: [{ item_id: 9999, quantity: 3 }] } });
  assert.equal(junk.body.items.length, 0, 'unknown items are dropped, not priced');
});

/* ================================================================== */
/* Coupons                                                             */
/* ================================================================== */

test('coupons apply, cap, and refuse under the minimum subtotal', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: dish['chicken-biryani'].id, quantity: 2 } }); // ₹1440

  const capped = await call('GET', '/api/cart?coupon=QUICK10', { token });
  assert.equal(capped.body.discount, 100, '10% of ₹1440 is capped at ₹100');

  const flat = await call('GET', '/api/cart?coupon=BITE50', { token });
  assert.equal(flat.body.discount, 50);

  const bogus = await call('GET', '/api/cart?coupon=NOPE', { token });
  assert.equal(bogus.body.discount, 0);
  assert.match(bogus.body.coupon_error, /not valid/);

  const { token: small } = await newCustomer();
  await call('POST', '/api/cart/items', { token: small, body: { item_id: dish['masala-chai'].id, quantity: 1 } });
  const tooSmall = await call('GET', '/api/cart?coupon=BITE50', { token: small });
  assert.match(tooSmall.body.coupon_error, /at least/);
  assert.equal(tooSmall.body.discount, 0);
});

test('an expired coupon is refused', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: dish['margherita-pizza'].id, quantity: 1 } });

  const { body } = await call('GET', '/api/cart?coupon=EXPIRED5', { token });
  assert.match(body.coupon_error, /expired/i);
  assert.equal(body.discount, 0);
});

test('a once-per-account coupon cannot be used twice', async () => {
  const { token } = await newCustomer();

  const first = await placeOrder(token, { itemSlug: 'chicken-biryani', coupon: 'WELCOME20' });
  assert.equal(first.status, 201);
  assert.ok(first.order.discount > 0);
  assert.equal(first.order.coupon_code, 'WELCOME20');

  const second = await placeOrder(token, { itemSlug: 'chicken-biryani', coupon: 'WELCOME20' });
  assert.equal(second.status, 400);
  assert.match(second.error, /once per account/i);
});

test('a redemption is recorded exactly once per order', async () => {
  const { token, user } = await newCustomer();
  const { order } = await placeOrder(token, { itemSlug: 'butter-chicken', coupon: 'BITE50' });

  const rows = db.prepare('SELECT * FROM coupon_redemptions WHERE order_id = ?').all(order.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'BITE50');
  assert.equal(rows[0].user_id, user.id);
  assert.equal(rows[0].amount_off, order.discount);
});

test('the public coupon list hides expired and exhausted codes', async () => {
  const { body } = await call('GET', '/api/menu/coupons');
  const codes = body.coupons.map((c) => c.code);
  assert.ok(codes.includes('QUICK10'));
  assert.ok(!codes.includes('EXPIRED5'), 'an expired coupon is not advertised');
});

test('recent reviews are public, capped, and only ever real ones', async () => {
  /*
   * Added for the reviews section on the home page. Everything it
   * returns was already public one dish at a time through
   * GET /api/menu/:slug — this is the same data, across dishes.
   */
  const { body, status } = await call('GET', '/api/menu/reviews/recent');
  assert.equal(status, 200, 'the endpoint is public');
  assert.ok(Array.isArray(body.reviews));

  for (const r of body.reviews) {
    assert.ok(r.rating >= 1 && r.rating <= 5, `rating out of range: ${r.rating}`);
    assert.notEqual(r.comment, '', 'a blank comment has nothing to show');
    assert.ok(r.author, 'every review names its author');
    assert.ok(r.item_name && r.item_slug, 'every review names the dish it is about');
  }

  // The cap holds in both directions, so a caller cannot ask for the lot.
  const few = await call('GET', '/api/menu/reviews/recent?limit=2');
  assert.ok(few.body.reviews.length <= 2);

  const greedy = await call('GET', '/api/menu/reviews/recent?limit=5000');
  assert.ok(greedy.body.reviews.length <= 24, 'the limit is capped server-side');

  const nonsense = await call('GET', '/api/menu/reviews/recent?limit=abc');
  assert.equal(nonsense.status, 200, 'a junk limit falls back rather than erroring');
});

test('adding the reviews route did not shadow a dish slug', async () => {
  /*
   * `/:idOrSlug` sits directly below the new route. A dish called
   * "reviews" could never resolve, but more importantly every existing
   * slug still has to.
   */
  const { status, body } = await call('GET', '/api/menu/margherita-pizza');
  assert.equal(status, 200);
  assert.equal(body.item.slug, 'margherita-pizza');

  const coupons = await call('GET', '/api/menu/coupons');
  assert.equal(coupons.status, 200, 'the sibling routes still resolve');
});

/* ================================================================== */
/* Checkout                                                            */
/* ================================================================== */

test('checkout empties the cart and records server-computed totals', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', {
    token, body: { item_id: dish['margherita-pizza'].id, quantity: 2 },
  });

  const placed = await call('POST', '/api/orders', {
    token,
    body: {
      name: 'Test Customer',
      phone: VALID_PHONE,
      address: VALID_ADDRESS,
      coupon: 'QUICK10',
      payment_method: 'upi',
      total: 1,          // a lying client
      subtotal: 1,
      discount: 999999,
    },
  });

  assert.equal(placed.status, 201);
  const order = placed.body.order;
  assert.match(order.code, /^QB-[0-9A-F]{6}$/);
  assert.equal(order.subtotal, 900);
  assert.equal(order.discount, 90);
  assert.equal(order.total, 851, 'the total comes from the server, not the request body');
  assert.equal(order.status, 'placed');
  assert.equal(order.payment_status, 'pending', 'an online payment starts unpaid');

  const cart = await call('GET', '/api/cart', { token });
  assert.equal(cart.body.count, 0);
});

test('cash on delivery is marked for settlement on delivery, not paid', async () => {
  const { token } = await newCustomer();
  const { order } = await placeOrder(token);
  assert.equal(order.payment_method, 'cod');
  assert.equal(order.payment_status, 'on_delivery');
});

test('checkout validates delivery details and an empty cart', async () => {
  const { token } = await newCustomer();

  const empty = await call('POST', '/api/orders', {
    token, body: { name: 'Ann Lee', phone: VALID_PHONE, address: VALID_ADDRESS },
  });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /empty/i);

  await call('POST', '/api/cart/items', { token, body: { item_id: dish['margherita-pizza'].id, quantity: 1 } });

  const badPhone = await call('POST', '/api/orders', {
    token, body: { name: 'Ann Lee', phone: '123', address: VALID_ADDRESS },
  });
  assert.equal(badPhone.status, 400);

  const badAddress = await call('POST', '/api/orders', {
    token, body: { name: 'Ann Lee', phone: VALID_PHONE, address: 'home' },
  });
  assert.equal(badAddress.status, 400);
});

test('replaying a checkout with the same Idempotency-Key returns one order', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: dish['lasagna'].id, quantity: 1 } });

  const key = `test-key-${Date.now()}`;
  const payload = { name: 'Ann Lee', phone: VALID_PHONE, address: VALID_ADDRESS };

  const first = await call('POST', '/api/orders', { token, body: payload, headers: { 'Idempotency-Key': key } });
  assert.equal(first.status, 201);

  const replay = await call('POST', '/api/orders', { token, body: payload, headers: { 'Idempotency-Key': key } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.order.id, first.body.order.id, 'the same order comes back');

  const mine = await call('GET', '/api/orders', { token });
  assert.equal(mine.body.orders.length, 1, 'only one order was ever created');
});

test('two different keys from the same customer create two orders', async () => {
  const { token } = await newCustomer();
  const payload = { name: 'Ann Lee', phone: VALID_PHONE, address: VALID_ADDRESS };

  for (const key of ['key-a', 'key-b']) {
    await call('POST', '/api/cart/items', { token, body: { item_id: dish['alfredo'].id, quantity: 1 } });
    const res = await call('POST', '/api/orders', { token, body: payload, headers: { 'Idempotency-Key': key } });
    assert.equal(res.status, 201);
  }

  const mine = await call('GET', '/api/orders', { token });
  assert.equal(mine.body.orders.length, 2);
});

/* ================================================================== */
/* Stock                                                               */
/* ================================================================== */

test('checkout decrements stock and refuses to oversell', async () => {
  const admin = await adminToken();
  const target = dish['gulab-jamun'];

  await call('PATCH', `/api/admin/menu/${target.id}`, { token: admin, body: { stock: 3 } });

  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: target.id, quantity: 2 } });

  const ok = await call('POST', '/api/orders', {
    token, body: { name: 'Ann Lee', phone: VALID_PHONE, address: VALID_ADDRESS },
  });
  assert.equal(ok.status, 201);

  const after = db.prepare('SELECT stock FROM menu_items WHERE id = ?').get(target.id).stock;
  assert.equal(after, 1, 'two portions were taken out of stock');

  // Asking for more than is left is refused at the cart, before checkout.
  const { token: other } = await newCustomer();
  const tooMany = await call('POST', '/api/cart/items', { token: other, body: { item_id: target.id, quantity: 1 } });
  assert.equal(tooMany.status, 201);
  const bump = await call('PATCH', `/api/cart/items/${target.id}`, { token: other, body: { quantity: 5 } });
  assert.equal(bump.status, 409);
  assert.match(bump.body.error, /Only 1/);

  await call('PATCH', `/api/admin/menu/${target.id}`, { token: admin, body: { stock: 100 } });
});

test('a sold-out dish cannot be added to the cart', async () => {
  const admin = await adminToken();
  const target = dish['tiramisu'];
  await call('PATCH', `/api/admin/menu/${target.id}`, { token: admin, body: { stock: 0 } });

  const { token } = await newCustomer();
  const res = await call('POST', '/api/cart/items', { token, body: { item_id: target.id, quantity: 1 } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /sold out/i);

  await call('PATCH', `/api/admin/menu/${target.id}`, { token: admin, body: { stock: 100 } });
});

test('cancelling an order puts its stock back', async () => {
  const admin = await adminToken();
  const target = dish['spring-rolls'];
  await call('PATCH', `/api/admin/menu/${target.id}`, { token: admin, body: { stock: 10 } });

  const { token } = await newCustomer();
  const { order } = await placeOrder(token, { itemSlug: 'spring-rolls', quantity: 3 });

  assert.equal(db.prepare('SELECT stock FROM menu_items WHERE id = ?').get(target.id).stock, 7);

  await call('POST', `/api/orders/${order.id}/cancel`, { token });
  assert.equal(
    db.prepare('SELECT stock FROM menu_items WHERE id = ?').get(target.id).stock, 10,
    'the cancelled portions are available again'
  );

  await call('PATCH', `/api/admin/menu/${target.id}`, { token: admin, body: { stock: 100 } });
});

/* ================================================================== */
/* Orders and lifecycle                                                */
/* ================================================================== */

test('customers see only their own orders', async () => {
  const a = await newCustomer();
  const b = await newCustomer();
  const { order } = await placeOrder(a.token);

  assert.equal((await call('GET', `/api/orders/${order.id}`, { token: a.token })).status, 200);
  assert.equal(
    (await call('GET', `/api/orders/${order.id}`, { token: b.token })).status, 404,
    "another customer's order is not readable"
  );

  // Nor can they act on it.
  assert.equal((await call('POST', `/api/orders/${order.id}/cancel`, { token: b.token })).status, 404);
  assert.equal((await call('POST', `/api/orders/${order.id}/reorder`, { token: b.token })).status, 404);
});

test('order history paginates', async () => {
  const { token } = await newCustomer();
  for (let i = 0; i < 3; i++) await placeOrder(token, { itemSlug: 'masala-chai' });

  const firstPage = await call('GET', '/api/orders?limit=2', { token });
  assert.equal(firstPage.body.orders.length, 2);
  assert.equal(firstPage.body.page.total, 3);
  assert.equal(firstPage.body.page.has_more, true);

  const secondPage = await call('GET', '/api/orders?limit=2&offset=2', { token });
  assert.equal(secondPage.body.orders.length, 1);
  assert.equal(secondPage.body.page.has_more, false);
});

test('cancel works while the order is new and is refused once cooking starts', async () => {
  const { token } = await newCustomer();
  const { order } = await placeOrder(token);

  const cancelled = await call('POST', `/api/orders/${order.id}/cancel`, { token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.order.status, 'cancelled');
  assert.equal(cancelled.body.order.can_cancel, false);

  assert.equal((await call('POST', `/api/orders/${order.id}/cancel`, { token })).status, 409);

  const second = await placeOrder(token);
  db.prepare("UPDATE orders SET status = 'preparing' WHERE id = ?").run(second.order.id);

  const tooLate = await call('POST', `/api/orders/${second.order.id}/cancel`, { token });
  assert.equal(tooLate.status, 409);
  assert.match(tooLate.body.error, /being prepared/);
});

test('orders auto-advance through the lifecycle as time passes', async () => {
  const { token } = await newCustomer();
  const { order } = await placeOrder(token);

  db.prepare("UPDATE orders SET placed_at = datetime('now', '-120 minutes') WHERE id = ?").run(order.id);

  const after = await call('GET', `/api/orders/${order.id}`, { token });
  assert.equal(after.body.order.status, 'delivered');
  assert.equal(after.body.order.minutes_remaining, 0);

  const stages = after.body.order.events.map((e) => e.status);
  for (const stage of ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered']) {
    assert.ok(stages.includes(stage), `timeline is missing the "${stage}" step`);
  }
});

test('reorder puts a past order back into the cart', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: dish['carbonara'].id, quantity: 2 } });
  const { body } = await call('POST', '/api/orders', {
    token, body: { name: 'Ann Lee', phone: VALID_PHONE, address: VALID_ADDRESS },
  });

  const again = await call('POST', `/api/orders/${body.order.id}/reorder`, { token });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.skipped, []);

  const cart = await call('GET', '/api/cart', { token });
  assert.equal(cart.body.items[0].item_id, dish['carbonara'].id);
  assert.equal(cart.body.items[0].quantity, 2);
});

/* ================================================================== */
/* Favourites, reviews and addresses                                   */
/* ================================================================== */

test('favourites toggle per user', async () => {
  const { token } = await newCustomer();
  const id = dish['pepperoni-pizza'].id;

  assert.equal((await call('POST', `/api/menu/${id}/favorite`, { token })).body.is_favorite, true);
  const listed = await call('GET', '/api/menu', { token });
  assert.equal(listed.body.items.find((i) => i.id === id).is_favorite, true);
  assert.equal((await call('POST', `/api/menu/${id}/favorite`, { token })).body.is_favorite, false);
});

test('a dish can only be reviewed after it has been delivered to you', async () => {
  const { token } = await newCustomer();
  const id = dish['lava-cake'].id;

  const early = await call('POST', `/api/menu/${id}/reviews`, { token, body: { rating: 5 } });
  assert.equal(early.status, 403);
  assert.match(early.body.error, /delivered/i);

  const { order } = await placeOrder(token, { itemSlug: 'lava-cake' });
  db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(order.id);

  const review = await call('POST', `/api/menu/${id}/reviews`, {
    token, body: { rating: 5, comment: 'Molten in the middle, exactly right.' },
  });
  assert.equal(review.status, 201);
  assert.equal(review.body.summary.count, 1);

  const detail = await call('GET', `/api/menu/${id}`);
  assert.equal(detail.body.reviews.count, 1);
  assert.equal(detail.body.item.rating, 5, 'the headline rating now reflects real reviews');

  const bad = await call('POST', `/api/menu/${id}/reviews`, { token, body: { rating: 9 } });
  assert.equal(bad.status, 400);
});

test('saved addresses are per-customer and keep exactly one default', async () => {
  const a = await newCustomer();
  const b = await newCustomer();

  const home = await call('POST', '/api/addresses', {
    token: a.token,
    body: { label: 'Home', recipient: 'Ann Lee', phone: VALID_PHONE, line1: '12 Rose Apartments, Indiranagar', city: 'Bengaluru', pincode: '560038' },
  });
  assert.equal(home.status, 201);
  assert.equal(home.body.address.is_default, true, 'the first address becomes the default');

  const work = await call('POST', '/api/addresses', {
    token: a.token,
    body: { label: 'Work', recipient: 'Ann Lee', phone: VALID_PHONE, line1: '4th Floor, Tech Park, Whitefield', city: 'Bengaluru', pincode: '560066', is_default: true },
  });
  assert.equal(work.body.address.is_default, true);

  const list = await call('GET', '/api/addresses', { token: a.token });
  assert.equal(list.body.addresses.filter((x) => x.is_default).length, 1);

  // B sees nothing and cannot touch A's address.
  assert.equal((await call('GET', '/api/addresses', { token: b.token })).body.addresses.length, 0);
  assert.equal((await call('DELETE', `/api/addresses/${home.body.address.id}`, { token: b.token })).status, 404);

  const invalid = await call('POST', '/api/addresses', {
    token: a.token, body: { recipient: 'X', phone: VALID_PHONE, line1: 'short' },
  });
  assert.equal(invalid.status, 400);

  // Deleting the default promotes another address.
  await call('DELETE', `/api/addresses/${work.body.address.id}`, { token: a.token });
  const after = await call('GET', '/api/addresses', { token: a.token });
  assert.equal(after.body.addresses.filter((x) => x.is_default).length, 1);
});

/* ================================================================== */
/* Admin                                                               */
/* ================================================================== */

test('admin routes are closed to customers and open to admins', async () => {
  const { token: customerToken } = await newCustomer();
  assert.equal((await call('GET', '/api/admin/orders', { token: customerToken })).status, 403);
  assert.equal((await call('GET', '/api/admin/stats')).status, 401);
  assert.equal((await call('GET', '/api/ai/analytics', { token: customerToken })).status, 403);

  const admin = await adminToken();
  const orders = await call('GET', '/api/admin/orders?status=all', { token: admin });
  assert.equal(orders.status, 200);
  assert.ok(orders.body.orders.length > 0);
  assert.ok(orders.body.orders[0].user_email);

  const stats = await call('GET', '/api/admin/stats', { token: admin });
  assert.ok(stats.body.stats.orders > 0);
  assert.ok(Array.isArray(stats.body.top_items));
  assert.ok(Array.isArray(stats.body.low_stock));
});

test('admin status changes follow the lifecycle and refuse invalid jumps', async () => {
  const admin = await adminToken();
  const { token } = await newCustomer();
  const { order } = await placeOrder(token, { itemSlug: 'paneer-tikka' });

  const forward = await call('PATCH', `/api/admin/orders/${order.id}`, {
    token: admin, body: { status: 'preparing' },
  });
  assert.equal(forward.status, 200);
  assert.equal(forward.body.order.status, 'preparing');
  assert.equal(forward.body.order.auto_advance, 0, 'a manual change stops the simulated clock');

  // Backwards is refused.
  const backwards = await call('PATCH', `/api/admin/orders/${order.id}`, {
    token: admin, body: { status: 'placed' },
  });
  assert.equal(backwards.status, 409);
  assert.match(backwards.body.error, /cannot go from/);

  // Skipping a stage is refused.
  const skip = await call('PATCH', `/api/admin/orders/${order.id}`, {
    token: admin, body: { status: 'delivered' },
  });
  assert.equal(skip.status, 409);

  // Unknown statuses are refused.
  assert.equal(
    (await call('PATCH', `/api/admin/orders/${order.id}`, { token: admin, body: { status: 'teleporting' } })).status,
    409
  );

  // A delivered order is terminal.
  await call('PATCH', `/api/admin/orders/${order.id}`, { token: admin, body: { status: 'out_for_delivery' } });
  await call('PATCH', `/api/admin/orders/${order.id}`, { token: admin, body: { status: 'delivered' } });
  const terminal = await call('PATCH', `/api/admin/orders/${order.id}`, {
    token: admin, body: { status: 'cancelled' },
  });
  assert.equal(terminal.status, 409);
});

test('admin can change a price and take a dish off the menu', async () => {
  const admin = await adminToken();
  const target = dish['cold-brew'];

  const priced = await call('PATCH', `/api/admin/menu/${target.id}`, { token: admin, body: { price: 250 } });
  assert.equal(priced.body.item.price, 250);

  const bad = await call('PATCH', `/api/admin/menu/${target.id}`, { token: admin, body: { price: -5 } });
  assert.equal(bad.status, 400);

  await call('PATCH', `/api/admin/menu/${target.id}`, { token: admin, body: { is_available: false } });
  const menu = await call('GET', '/api/menu');
  assert.ok(!menu.body.items.some((i) => i.id === target.id));

  const { token } = await newCustomer();
  assert.equal(
    (await call('POST', '/api/cart/items', { token, body: { item_id: target.id, quantity: 1 } })).status, 404
  );

  await call('PATCH', `/api/admin/menu/${target.id}`, {
    token: admin, body: { is_available: true, price: target.price },
  });
});

/* ================================================================== */
/* Transport                                                           */
/* ================================================================== */

test('unknown API routes answer with JSON, not the HTML page', async () => {
  const { status, body } = await call('GET', '/api/nope');
  assert.equal(status, 404);
  assert.match(body.error, /Unknown API endpoint/);
});

test('the static site is served and unknown pages 404', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /QuickBite/);

  assert.equal((await fetch(`${base}/no-such-page`)).status, 404);
});

test('malformed JSON is rejected cleanly', async () => {
  const res = await fetch(`${base}/api/menu/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Malformed JSON/);
});

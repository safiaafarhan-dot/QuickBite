'use strict';

/**
 * End-to-end API tests. Each run uses a throwaway SQLite file so the tests
 * never touch the development database.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(os.tmpdir(), `quickbite-test-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.JWT_SECRET = 'test-secret';

const app = require('../server/index');
const { hashPassword } = require('../server/auth');
const { db } = require('../server/db');

let base;
let server;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
    'Test Admin', 'admin@test.local', await hashPassword('admin123'), 'admin'
  );
});

test.after(() => {
  server?.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${TMP_DB}${suffix}`, { force: true });
    } catch {
      /* Windows can hold the file briefly; a stale temp file is harmless. */
    }
  }
});

/** Thin fetch helper that returns { status, body }. */
async function call(method, route, { token, body } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const uniqueEmail = () => `user${Date.now()}${Math.random().toString(16).slice(2, 7)}@test.local`;

async function newCustomer() {
  const email = uniqueEmail();
  const { body } = await call('POST', '/api/auth/register', {
    body: { name: 'Test Customer', email, password: 'secret123' },
  });
  return { token: body.token, user: body.user, email };
}

/* ================================================================== */

test('health check reports the database in use', async () => {
  const { status, body } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('menu seeds six dishes and supports search, filter and sort', async () => {
  const all = await call('GET', '/api/menu');
  assert.equal(all.status, 200);
  assert.equal(all.body.items.length, 6);

  const search = await call('GET', '/api/menu?q=pizza');
  assert.equal(search.body.items.length, 1);
  assert.match(search.body.items[0].name, /Pizza/);

  const veg = await call('GET', '/api/menu?diet=veg');
  assert.ok(veg.body.items.every((i) => i.is_veg === true));

  const cheap = await call('GET', '/api/menu?sort=price-asc');
  const prices = cheap.body.items.map((i) => i.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test('registration rejects bad input and duplicate emails', async () => {
  const short = await call('POST', '/api/auth/register', {
    body: { name: 'A', email: 'a@test.local', password: 'secret123' },
  });
  assert.equal(short.status, 400);

  const weak = await call('POST', '/api/auth/register', {
    body: { name: 'Valid Name', email: uniqueEmail(), password: '123' },
  });
  assert.equal(weak.status, 400);

  const email = uniqueEmail();
  const first = await call('POST', '/api/auth/register', {
    body: { name: 'First User', email, password: 'secret123' },
  });
  assert.equal(first.status, 201);

  const dupe = await call('POST', '/api/auth/register', {
    body: { name: 'Second User', email, password: 'secret123' },
  });
  assert.equal(dupe.status, 409);
});

test('login succeeds with the right password and fails with the wrong one', async () => {
  const email = uniqueEmail();
  await call('POST', '/api/auth/register', { body: { name: 'Login Test', email, password: 'secret123' } });

  const ok = await call('POST', '/api/auth/login', { body: { email, password: 'secret123' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(ok.body.user.password_hash, undefined, 'password hash must never be returned');

  const bad = await call('POST', '/api/auth/login', { body: { email, password: 'wrong-password' } });
  assert.equal(bad.status, 401);
});

test('protected routes reject missing and forged tokens', async () => {
  assert.equal((await call('GET', '/api/cart')).status, 401);
  assert.equal((await call('GET', '/api/orders')).status, 401);
  assert.equal((await call('GET', '/api/cart', { token: 'not.a.token' })).status, 401);
});

test('cart add, update, remove and clear keep totals server-authoritative', async () => {
  const { token } = await newCustomer();

  const added = await call('POST', '/api/cart/items', { token, body: { item_id: 1, quantity: 2 } });
  assert.equal(added.status, 201);
  assert.equal(added.body.count, 2);
  assert.equal(added.body.subtotal, 900);           // 2 × ₹450
  assert.equal(added.body.delivery_fee, 0);         // free above ₹500
  assert.equal(added.body.tax, 45);                 // 5% GST
  assert.equal(added.body.total, 945);

  const patched = await call('PATCH', '/api/cart/items/1', { token, body: { quantity: 1 } });
  assert.equal(patched.body.subtotal, 450);
  assert.equal(patched.body.delivery_fee, 40);      // below the free-delivery threshold
  assert.equal(patched.body.total, 450 + 40 + 23);

  const removed = await call('PATCH', '/api/cart/items/1', { token, body: { quantity: 0 } });
  assert.equal(removed.body.items.length, 0);
  assert.equal(removed.body.total, 0);

  await call('POST', '/api/cart/items', { token, body: { item_id: 2, quantity: 1 } });
  const cleared = await call('DELETE', '/api/cart', { token });
  assert.equal(cleared.body.count, 0);
});

test('cart rejects unknown items and out-of-range quantities', async () => {
  const { token } = await newCustomer();

  assert.equal((await call('POST', '/api/cart/items', { token, body: { item_id: 9999, quantity: 1 } })).status, 404);
  assert.equal((await call('POST', '/api/cart/items', { token, body: { item_id: 1, quantity: 0 } })).status, 400);
  assert.equal((await call('PATCH', '/api/cart/items/1', { token, body: { quantity: 999 } })).status, 400);
});

test('coupons apply, cap and refuse under the minimum subtotal', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: 5, quantity: 2 } }); // ₹1440

  const capped = await call('GET', '/api/cart?coupon=QUICK10', { token });
  assert.equal(capped.body.discount, 100, '10% of ₹1440 is capped at ₹100');

  const flat = await call('GET', '/api/cart?coupon=BITE50', { token });
  assert.equal(flat.body.discount, 50);

  const bogus = await call('GET', '/api/cart?coupon=NOPE', { token });
  assert.equal(bogus.body.discount, 0);
  assert.match(bogus.body.coupon_error, /not valid/);

  const { token: token2 } = await newCustomer();
  await call('POST', '/api/cart/items', { token: token2, body: { item_id: 6, quantity: 1 } }); // ₹310
  const tooSmall = await call('GET', '/api/cart?coupon=BITE50', { token: token2 });
  assert.match(tooSmall.body.coupon_error, /at least/);
  assert.equal(tooSmall.body.discount, 0);
});

test('guest quote prices a basket without storing a cart', async () => {
  const { status, body } = await call('POST', '/api/menu/quote', {
    body: { items: [{ item_id: 1, quantity: 1 }, { item_id: 4, quantity: 1 }], coupon: 'QUICK10' },
  });
  assert.equal(status, 200);
  assert.equal(body.subtotal, 850);
  assert.equal(body.discount, 85);
  assert.equal(body.coupon.code, 'QUICK10');

  const junk = await call('POST', '/api/menu/quote', { body: { items: [{ item_id: 9999, quantity: 3 }] } });
  assert.equal(junk.body.items.length, 0, 'unknown items are dropped, not priced');
});

test('merging a guest cart folds quantities into the account cart', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: 1, quantity: 1 } });

  const merged = await call('POST', '/api/cart/merge', {
    token,
    body: { items: [{ item_id: 1, quantity: 2 }, { item_id: 3, quantity: 1 }, { item_id: 9999, quantity: 5 }] },
  });
  const pizza = merged.body.items.find((l) => l.item_id === 1);
  assert.equal(pizza.quantity, 3);
  assert.equal(merged.body.items.length, 2, 'the unknown item is ignored');
});

test('checkout empties the cart and records the order with server totals', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: 1, quantity: 2 } });

  const placed = await call('POST', '/api/orders', {
    token,
    body: {
      name: 'Test Customer',
      phone: '+91 90000 00000',
      address: '42 Test Street, Example Area, Bengaluru 560001',
      coupon: 'QUICK10',
      payment_method: 'upi',
      total: 1,                       // a lying client
    },
  });

  assert.equal(placed.status, 201);
  const order = placed.body.order;
  assert.match(order.code, /^QB-[0-9A-F]{6}$/);
  assert.equal(order.subtotal, 900);
  assert.equal(order.discount, 90);
  assert.equal(order.total, 851, 'the total comes from the server, not the request body');
  assert.equal(order.status, 'placed');
  assert.equal(order.items.length, 1);

  const cart = await call('GET', '/api/cart', { token });
  assert.equal(cart.body.count, 0, 'the cart is emptied by checkout');
});

test('checkout validates the delivery details and an empty cart', async () => {
  const { token } = await newCustomer();

  const empty = await call('POST', '/api/orders', {
    token,
    body: { name: 'Test', phone: '+91 90000 00000', address: '42 Test Street, Bengaluru 560001' },
  });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /empty/i);

  await call('POST', '/api/cart/items', { token, body: { item_id: 1, quantity: 1 } });

  const badPhone = await call('POST', '/api/orders', {
    token,
    body: { name: 'Test', phone: '123', address: '42 Test Street, Bengaluru 560001' },
  });
  assert.equal(badPhone.status, 400);

  const badAddress = await call('POST', '/api/orders', {
    token,
    body: { name: 'Test', phone: '+91 90000 00000', address: 'home' },
  });
  assert.equal(badAddress.status, 400);
});

test('customers see only their own orders', async () => {
  const a = await newCustomer();
  const b = await newCustomer();

  await call('POST', '/api/cart/items', { token: a.token, body: { item_id: 1, quantity: 1 } });
  const { body } = await call('POST', '/api/orders', {
    token: a.token,
    body: { name: 'Ann Lee', phone: '+91 90000 00000', address: '42 Test Street, Bengaluru 560001' },
  });

  const mine = await call('GET', `/api/orders/${body.order.id}`, { token: a.token });
  assert.equal(mine.status, 200);

  const theirs = await call('GET', `/api/orders/${body.order.id}`, { token: b.token });
  assert.equal(theirs.status, 404, "another customer's order is not readable");
});

test('cancel works while the order is new and is refused once cooking starts', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: 1, quantity: 1 } });
  const { body } = await call('POST', '/api/orders', {
    token,
    body: { name: 'Ann Lee', phone: '+91 90000 00000', address: '42 Test Street, Bengaluru 560001' },
  });
  const orderId = body.order.id;

  const cancelled = await call('POST', `/api/orders/${orderId}/cancel`, { token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.order.status, 'cancelled');

  const again = await call('POST', `/api/orders/${orderId}/cancel`, { token });
  assert.equal(again.status, 409);

  // A second order pushed into "preparing" can no longer be cancelled.
  await call('POST', '/api/cart/items', { token, body: { item_id: 1, quantity: 1 } });
  const second = await call('POST', '/api/orders', {
    token,
    body: { name: 'Ann Lee', phone: '+91 90000 00000', address: '42 Test Street, Bengaluru 560001' },
  });
  db.prepare("UPDATE orders SET status = 'preparing' WHERE id = ?").run(second.body.order.id);

  const tooLate = await call('POST', `/api/orders/${second.body.order.id}/cancel`, { token });
  assert.equal(tooLate.status, 409);
  assert.match(tooLate.body.error, /being prepared/);
});

test('orders auto-advance through the lifecycle as time passes', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: 1, quantity: 1 } });
  const { body } = await call('POST', '/api/orders', {
    token,
    body: { name: 'Ann Lee', phone: '+91 90000 00000', address: '42 Test Street, Bengaluru 560001' },
  });
  const orderId = body.order.id;

  // Backdate the order past its ETA; the next read should settle on "delivered".
  db.prepare("UPDATE orders SET placed_at = datetime('now', '-120 minutes') WHERE id = ?").run(orderId);

  const after = await call('GET', `/api/orders/${orderId}`, { token });
  assert.equal(after.body.order.status, 'delivered');
  assert.equal(after.body.order.minutes_remaining, 0);

  const stages = after.body.order.events.map((e) => e.status);
  for (const stage of ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered']) {
    assert.ok(stages.includes(stage), `timeline is missing the "${stage}" step`);
  }
});

test('reorder puts a past order back into the cart', async () => {
  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: 2, quantity: 2 } });
  const { body } = await call('POST', '/api/orders', {
    token,
    body: { name: 'Ann Lee', phone: '+91 90000 00000', address: '42 Test Street, Bengaluru 560001' },
  });

  const again = await call('POST', `/api/orders/${body.order.id}/reorder`, { token });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.skipped, []);

  const cart = await call('GET', '/api/cart', { token });
  assert.equal(cart.body.items[0].item_id, 2);
  assert.equal(cart.body.items[0].quantity, 2);
});

test('favourites toggle per user', async () => {
  const { token } = await newCustomer();

  const on = await call('POST', '/api/menu/1/favorite', { token });
  assert.equal(on.body.is_favorite, true);

  const listed = await call('GET', '/api/menu', { token });
  assert.equal(listed.body.items.find((i) => i.id === 1).is_favorite, true);

  const off = await call('POST', '/api/menu/1/favorite', { token });
  assert.equal(off.body.is_favorite, false);
});

test('admin routes are closed to customers and open to admins', async () => {
  const { token: customerToken } = await newCustomer();
  assert.equal((await call('GET', '/api/admin/orders', { token: customerToken })).status, 403);
  assert.equal((await call('GET', '/api/admin/stats')).status, 401);

  const login = await call('POST', '/api/auth/login', {
    body: { email: 'admin@test.local', password: 'admin123' },
  });
  const adminToken = login.body.token;

  const orders = await call('GET', '/api/admin/orders?status=all', { token: adminToken });
  assert.equal(orders.status, 200);
  assert.ok(orders.body.orders.length > 0);
  assert.ok(orders.body.orders[0].user_email);

  const stats = await call('GET', '/api/admin/stats', { token: adminToken });
  assert.ok(stats.body.stats.orders > 0);
  assert.ok(Array.isArray(stats.body.top_items));
});

test('admin can move an order status and take a dish off the menu', async () => {
  const login = await call('POST', '/api/auth/login', {
    body: { email: 'admin@test.local', password: 'admin123' },
  });
  const adminToken = login.body.token;

  const { token } = await newCustomer();
  await call('POST', '/api/cart/items', { token, body: { item_id: 3, quantity: 1 } });
  const { body } = await call('POST', '/api/orders', {
    token,
    body: { name: 'Ann Lee', phone: '+91 90000 00000', address: '42 Test Street, Bengaluru 560001' },
  });

  const moved = await call('PATCH', `/api/admin/orders/${body.order.id}`, {
    token: adminToken,
    body: { status: 'out_for_delivery' },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.order.status, 'out_for_delivery');
  assert.equal(moved.body.order.auto_advance, 0, 'a manual change stops the simulated clock');

  const bogus = await call('PATCH', `/api/admin/orders/${body.order.id}`, {
    token: adminToken,
    body: { status: 'teleporting' },
  });
  assert.equal(bogus.status, 400);

  // Hiding a dish removes it from the public menu and blocks adding it.
  await call('PATCH', '/api/admin/menu/6', { token: adminToken, body: { is_available: false } });
  const menu = await call('GET', '/api/menu');
  assert.ok(!menu.body.items.some((i) => i.id === 6));
  assert.equal((await call('POST', '/api/cart/items', { token, body: { item_id: 6, quantity: 1 } })).status, 404);

  await call('PATCH', '/api/admin/menu/6', { token: adminToken, body: { is_available: true } });
});

test('unknown API routes answer with JSON, not the HTML page', async () => {
  const { status, body } = await call('GET', '/api/nope');
  assert.equal(status, 404);
  assert.match(body.error, /Unknown API endpoint/);
});

test('the static site is served', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /QuickBite/);

  const missing = await fetch(`${base}/no-such-page`);
  assert.equal(missing.status, 404);
});

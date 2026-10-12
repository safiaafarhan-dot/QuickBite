'use strict';

/**
 * Front-end tests. The real HTML pages are loaded into jsdom and pointed at a
 * live server, so these exercise exactly the code a browser runs: the menu
 * renders, filters work, the cart updates, the assistant answers, checkout
 * places an order, tracking works and the admin gate holds.
 *
 * jsdom is not a browser — it does not lay out or paint. Visual appearance and
 * responsive breakpoints are NOT covered here; see the README for what remains
 * unverified.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const {
  prepareEnvironment, cleanup, makeClient,
  GOOD_PASSWORD, VALID_ADDRESS, VALID_PHONE,
} = require('./helpers');

const DB_FILE = prepareEnvironment('ui');

const app = require('../server/index');
const { hashPassword } = require('../server/auth');
const { db } = require('../server/db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let server;
let base;
const call = makeClient(() => base);
const dish = {};

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  db.prepare('INSERT INTO users (name, email, password_hash, phone, address, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('Uma Patel', 'ui@test.local', await hashPassword(GOOD_PASSWORD), VALID_PHONE, VALID_ADDRESS, 'customer');
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run('Kitchen Admin', 'uiadmin@test.local', await hashPassword('adminpass1'), 'admin');

  for (const row of db.prepare('SELECT id, slug, name, price FROM menu_items').all()) dish[row.slug] = row;
});

test.after(() => {
  server?.close();
  db.close();
  cleanup(DB_FILE);
});

/* ================================================================== */
/* jsdom harness                                                       */
/* ================================================================== */

/**
 * Loads one of the real HTML pages with its scripts running against the test
 * server. Pass `token` to boot the page as a signed-in customer.
 */
async function loadPage(file, { token, search = '' } = {}) {
  const html = fs
    .readFileSync(path.join(PUBLIC_DIR, file), 'utf8')
    .replace(/<link[^>]+stylesheet[^>]*>/g, '');   // jsdom does not need the CSS

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    if (!/Could not parse CSS|Not implemented/.test(err.message)) throw err;
  });

  const dom = new JSDOM(html, {
    url: `${base}/${file}${search}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;
  window.fetch = (input, init) => fetch(new URL(input, base), init);
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.crypto.randomUUID) {
    window.crypto.randomUUID = () => `uuid-${Math.random().toString(16).slice(2)}`;
  }

  // Each jsdom window has its own localStorage, so a signed-in page needs the
  // token seeded before the scripts boot.
  if (token) window.localStorage.setItem('qb_token', token);

  for (const tag of [...window.document.querySelectorAll('script[src]')]) {
    window.eval(fs.readFileSync(path.join(PUBLIC_DIR, tag.getAttribute('src')), 'utf8'));
  }

  return { dom, window, doc: window.document };
}

/** Waits until `fn()` returns something truthy, or fails after `timeout` ms. */
async function waitFor(fn, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try { value = fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const click = (window, node) =>
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

const submit = (window, form) =>
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

const change = (window, node) =>
  node.dispatchEvent(new window.Event('change', { bubbles: true }));

const input = (window, node, value) => {
  node.value = value;
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
};

async function customerToken() {
  const { body } = await call('POST', '/api/auth/login', {
    body: { email: 'ui@test.local', password: GOOD_PASSWORD },
  });
  return body.token;
}

async function adminToken() {
  const { body } = await call('POST', '/api/auth/login', {
    body: { email: 'uiadmin@test.local', password: 'adminpass1' },
  });
  return body.token;
}

/* ================================================================== */
/* Home page                                                           */
/* ================================================================== */

test('the home page renders the whole menu from the API', async () => {
  const { window, doc } = await loadPage('index.html');

  const cards = await waitFor(
    () => (doc.querySelectorAll('.dish').length === 30 ? doc.querySelectorAll('.dish') : null),
    'all 30 dish cards'
  );

  const names = [...cards].map((c) => c.querySelector('.dish-name-btn').textContent.trim());
  assert.ok(names.includes('Classic Margherita Pizza'));
  assert.ok(names.includes('Chicken Biryani'));
  assert.ok(names.includes('Masala Chai'));

  // Category chips come from the server, not a hard-coded list: 8 + All + Popular.
  assert.equal(doc.querySelectorAll('#categoryChips .chip').length, 10);

  // Headline figures are computed from the real menu.
  assert.equal(doc.getElementById('statDishes').textContent, '30');
  assert.match(doc.getElementById('statRating').textContent, /^\d\.\d★$/);

  // Every card carries a real price and an image path that exists on disk.
  for (const card of [...cards].slice(0, 5)) {
    assert.match(card.querySelector('.price').textContent, /₹\d/);
    const src = card.querySelector('img').getAttribute('src');
    assert.match(src, /^images\/dishes\/[\w-]+\.jpg$/);
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, src)), `${src} is missing from disk`);
  }

  window.close();
});

test('skeletons are shown while the menu loads, then replaced', async () => {
  const { window, doc } = await loadPage('index.html');

  // The grid is filled with skeletons synchronously during boot. Scope the
  // assertions to the menu grid — the recommendation rail loads independently
  // and has skeletons of its own.
  assert.ok(doc.querySelector('#menuGrid .skeleton-card'), 'a loading skeleton is rendered immediately');
  assert.equal(doc.getElementById('menuGrid').getAttribute('aria-busy'), 'true');

  await waitFor(() => doc.querySelector('.dish'), 'real cards');
  assert.equal(doc.querySelector('#menuGrid .skeleton-card'), null, 'skeletons are gone once data arrives');
  assert.equal(doc.getElementById('menuGrid').getAttribute('aria-busy'), 'false');

  window.close();
});

test('category, diet and price filters narrow the grid', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelectorAll('.dish').length === 30, 'the full menu');

  const desserts = [...doc.querySelectorAll('#categoryChips .chip')]
    .find((c) => c.dataset.category === 'desserts');
  click(window, desserts);
  await waitFor(() => {
    const n = doc.querySelectorAll('.dish').length;
    return n > 0 && n < 30;
  }, 'the desserts filter to apply');
  const dessertCount = doc.querySelectorAll('.dish').length;
  assert.ok(dessertCount >= 3 && dessertCount < 10, `expected a handful of desserts, got ${dessertCount}`);

  click(window, [...doc.querySelectorAll('#categoryChips .chip')].find((c) => c.dataset.category === 'all'));
  await waitFor(() => doc.querySelectorAll('.dish').length === 30, 'the full menu again');

  click(window, doc.querySelector('[data-diet="veg"]'));
  await waitFor(() => {
    const n = doc.querySelectorAll('.dish').length;
    return n > 0 && n < 30;
  }, 'the veg filter');
  assert.equal(
    doc.querySelectorAll('.dish .diet-dot--nonveg').length, 0,
    'no non-veg dish survives the veg filter'
  );

  // The "clear filters" affordance appears once something is filtered.
  assert.equal(doc.getElementById('resetFilters').hidden, false);
  click(window, doc.getElementById('resetFilters'));
  await waitFor(() => doc.querySelectorAll('.dish').length === 30, 'filters to clear');

  window.close();
});

test('searching filters the menu and an empty result is explained', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelectorAll('.dish').length === 30, 'the menu');

  input(window, doc.getElementById('searchInput'), 'biryani');
  await waitFor(() => {
    const n = doc.querySelectorAll('.dish').length;
    return n > 0 && n < 10;
  }, 'the search to apply');
  const names = [...doc.querySelectorAll('.dish-name-btn')].map((n) => n.textContent);
  assert.ok(names.every((n) => /biryani/i.test(n)), `unexpected results: ${names}`);

  input(window, doc.getElementById('searchInput'), 'zzzzzznothing');
  const state = await waitFor(() => doc.querySelector('#menuGrid .state'), 'the empty state');
  assert.match(state.textContent, /Nothing matches/i);
  assert.ok(state.querySelector('#clearFromEmpty'), 'the empty state offers a way out');

  click(window, state.querySelector('#clearFromEmpty'));
  await waitFor(() => doc.querySelectorAll('.dish').length === 30, 'the grid to recover');

  window.close();
});

test('a quick chip applies a preset and narrows the menu', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelectorAll('.dish').length === 30, 'the menu');

  click(window, doc.querySelector('[data-quick="under300"]'));
  await waitFor(() => {
    const n = doc.querySelectorAll('.dish').length;
    return n > 0 && n < 30;
  }, 'the budget preset');

  const prices = [...doc.querySelectorAll('.dish .price')]
    .map((p) => Number(p.textContent.replace(/[^\d]/g, '')));
  assert.ok(prices.length > 0);
  assert.ok(prices.every((p) => p <= 300), `a dish above ₹300 slipped through: ${prices}`);

  window.close();
});

/* ================================================================== */
/* Cart                                                                */
/* ================================================================== */

test('a guest can add to the cart and sees server-priced totals', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu');

  const pizza = await waitFor(
    () => [...doc.querySelectorAll('.dish')]
      .find((c) => c.querySelector('.dish-name-btn').textContent.trim() === 'Classic Margherita Pizza'),
    'the pizza card'
  );

  click(window, pizza.querySelector('[data-step="1"]'));
  assert.equal(pizza.querySelector('.qty-input').value, '2');
  click(window, pizza.querySelector('[data-add]'));

  await waitFor(() => doc.getElementById('cartCount').textContent === '2', 'the cart badge');

  const lines = doc.querySelectorAll('.cart-line');
  assert.equal(lines.length, 1);
  assert.match(lines[0].querySelector('.cart-line-total').textContent, /900/);

  const totals = doc.getElementById('cartTotals').textContent;
  assert.match(totals, /Subtotal/);
  assert.match(totals, /945/, '₹900 + 5% GST, free delivery');

  // The basket survives a reload because it lives in localStorage.
  assert.equal(JSON.parse(window.localStorage.getItem('qb_guest_cart'))[0].quantity, 2);

  window.close();
});

test('cart quantities can be changed and lines removed from the drawer', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu');

  click(window, doc.querySelector('[data-add]'));
  await waitFor(() => doc.querySelectorAll('.cart-line').length === 1, 'a cart line');

  click(window, doc.querySelector('[data-line-step="1"]'));
  await waitFor(() => doc.querySelector('.qty-value')?.textContent === '2', 'the quantity to increase');

  click(window, doc.querySelector('[data-line-remove]'));
  await waitFor(() => doc.getElementById('cartCount').textContent === '0', 'the line to be removed');
  assert.match(doc.getElementById('cartBody').textContent, /cart is empty/i);

  window.close();
});

test('a coupon typed into the drawer is validated by the server', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu');

  click(window, doc.querySelector('[data-add]'));
  await waitFor(() => doc.querySelectorAll('.cart-line').length === 1, 'a cart line');

  doc.getElementById('couponInput').value = 'QUICK10';
  submit(window, doc.getElementById('couponForm'));

  const msg = await waitFor(
    () => (doc.getElementById('couponMsg').hidden === false ? doc.getElementById('couponMsg') : null),
    'the coupon message'
  );
  assert.match(msg.textContent, /QUICK10 applied/);
  assert.match(doc.getElementById('cartTotals').textContent, /Discount/);

  doc.getElementById('couponInput').value = 'FAKECODE';
  submit(window, doc.getElementById('couponForm'));
  await waitFor(() => /not valid/.test(doc.getElementById('couponMsg').textContent), 'the rejection');

  window.close();
});

/* ================================================================== */
/* Dish detail                                                         */
/* ================================================================== */

test('the dish detail modal shows facts, pairings and reviews', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu');

  click(window, doc.querySelector('.dish-name-btn'));
  await waitFor(() => doc.getElementById('detailModal').classList.contains('is-open'), 'the modal');
  await waitFor(() => doc.querySelector('.detail-facts'), 'the facts panel');

  const content = doc.getElementById('detailContent');
  assert.match(content.textContent, /₹/, 'a price');
  assert.match(content.textContent, /to cook/, 'a prep time');
  assert.ok(content.querySelector('.detail-tags .badge'), 'a veg/non-veg badge');

  await waitFor(() => content.querySelector('.pairing-card'), '"goes well with" suggestions');
  assert.ok(content.querySelector('.reviews'), 'a reviews section');

  click(window, content.querySelector('[data-detail-add]'));
  await waitFor(() => doc.getElementById('cartCount').textContent === '1', 'the item to reach the cart');
  assert.equal(doc.getElementById('detailModal').classList.contains('is-open'), false);

  window.close();
});

/* ================================================================== */
/* Recommendations and assistant                                       */
/* ================================================================== */

test('the recommendation rail renders real dishes', async () => {
  const { window, doc } = await loadPage('index.html');

  await waitFor(() => doc.querySelectorAll('.rail-card').length > 0, 'recommendations');

  const cards = doc.querySelectorAll('.rail-card');
  assert.ok(cards.length >= 4);
  assert.match(doc.getElementById('picksExplanation').textContent, /\w/);

  const realNames = new Set(db.prepare('SELECT name FROM menu_items').all().map((r) => r.name));
  for (const card of cards) {
    assert.ok(realNames.has(card.querySelector('h3').textContent.trim()), 'every pick is a real dish');
  }

  window.close();
});

test('the assistant answers in the panel and its picks can be added', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu');

  click(window, doc.getElementById('assistantFab'));
  assert.equal(doc.getElementById('assistant').classList.contains('is-open'), true);
  await waitFor(() => doc.querySelector('.bubble--bot'), 'the greeting');

  input(window, doc.getElementById('assistantInput'), 'something spicy and vegetarian under 400');
  submit(window, doc.getElementById('assistantForm'));

  await waitFor(() => doc.querySelector('.bubble--user'), 'the question to echo');
  await waitFor(() => doc.querySelectorAll('.bubble--bot').length >= 2, 'the answer');
  await waitFor(() => doc.querySelector('.pick'), 'the suggested dishes');

  const realNames = new Set(db.prepare('SELECT name FROM menu_items').all().map((r) => r.name));
  for (const pick of doc.querySelectorAll('.pick strong')) {
    assert.ok(realNames.has(pick.textContent.trim()), `invented dish: ${pick.textContent}`);
  }

  click(window, doc.querySelector('[data-assistant-add]'));
  await waitFor(() => doc.getElementById('cartCount').textContent !== '0', 'the pick to reach the cart');

  window.close();
});

/* ================================================================== */
/* Auth and checkout                                                   */
/* ================================================================== */

test('signing in adopts the guest cart and reveals the account menu', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu');

  click(window, doc.querySelector('[data-add]'));
  await waitFor(() => doc.getElementById('cartCount').textContent === '1', 'one guest item');

  click(window, doc.getElementById('signInBtn'));
  const form = doc.getElementById('authForm');
  form.elements.email.value = 'ui@test.local';
  form.elements.password.value = GOOD_PASSWORD;
  submit(window, form);

  await waitFor(() => doc.getElementById('signInBtn').hidden === true, 'sign-in to complete');
  assert.equal(doc.getElementById('accountEmail').textContent, 'ui@test.local');
  assert.equal(doc.getElementById('accountName').textContent, 'Uma');

  /*
   * Adopting the guest basket is a second request that lands after the
   * session is established, so the sign-in button hides before the cart
   * has caught up. Asserting straight after the button disappeared was
   * a race, and it lost under the parallel load of the full suite. The
   * claim is unchanged — it is just no longer checked early.
   */
  await waitFor(
    () => doc.getElementById('cartCount').textContent === '1',
    'the guest basket to be adopted'
  );
  assert.equal(doc.getElementById('cartCount').textContent, '1', 'the guest basket moved across');
  assert.equal(window.localStorage.getItem('qb_guest_cart'), null);

  window.close();
});

test('a wrong password is reported in the form, not swallowed', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu');

  click(window, doc.getElementById('signInBtn'));
  const form = doc.getElementById('authForm');
  form.elements.email.value = 'ui@test.local';
  form.elements.password.value = 'definitelywrong1';
  submit(window, form);

  const error = await waitFor(
    () => (doc.getElementById('authError').hidden === false ? doc.getElementById('authError') : null),
    'the error message'
  );
  assert.match(error.textContent, /incorrect/i);
  assert.equal(doc.getElementById('signInBtn').hidden, false, 'still signed out');

  window.close();
});

test('checkout places a real order and shows the confirmation', async () => {
  const token = await customerToken();
  const { window, doc } = await loadPage('index.html', { token });
  await waitFor(() => doc.querySelector('.dish'), 'the menu');
  await waitFor(() => doc.getElementById('signInBtn').hidden === true, 'the signed-in header');

  click(window, doc.querySelector('[data-add]'));
  await waitFor(() => doc.querySelectorAll('.cart-line').length >= 1, 'a cart line');

  click(window, doc.getElementById('checkoutBtn'));
  await waitFor(() => doc.getElementById('checkoutModal').classList.contains('is-open'), 'the checkout modal');
  await waitFor(() => doc.getElementById('checkoutSummary').textContent.includes('Total'), 'the summary');

  const checkout = doc.getElementById('checkoutForm');
  if (doc.getElementById('savedAddresses').hidden) {
    checkout.elements.name.value = 'Uma Patel';
    checkout.elements.phone.value = VALID_PHONE;
    checkout.elements.address.value = VALID_ADDRESS;
  }
  submit(window, checkout);

  await waitFor(() => doc.getElementById('successModal').classList.contains('is-open'), 'the confirmation');
  assert.match(doc.getElementById('successText').textContent, /QB-/);
  assert.match(doc.getElementById('trackOrderLink').href, /orders\.html\?order=\d+/);
  assert.equal(doc.getElementById('cartCount').textContent, '0', 'the cart empties');

  window.close();
});

/* ================================================================== */
/* Orders page                                                         */
/* ================================================================== */

test('the orders page tracks a live order and can cancel it', async () => {
  const token = await customerToken();

  await call('POST', '/api/cart/items', { token, body: { item_id: dish['lasagna'].id, quantity: 1 } });
  const { body } = await call('POST', '/api/orders', {
    token, body: { name: 'Uma Patel', phone: VALID_PHONE, address: VALID_ADDRESS },
  });
  const order = body.order;

  const { window, doc } = await loadPage('orders.html', { token, search: `?order=${order.id}` });
  await waitFor(() => doc.querySelector('.order-card'), 'an order card');

  const card = await waitFor(() => doc.querySelector(`[data-order="${order.id}"]`), 'the new order');
  assert.equal(card.querySelector('.order-code').textContent, order.code);
  assert.ok(card.querySelector('.tracker-fill'), 'a progress bar');
  assert.ok(card.querySelector('[data-cancel]'), 'a fresh order can be cancelled');
  assert.ok(card.querySelector('[data-reorder]'));
  assert.match(doc.getElementById('ordersSubtitle').textContent, /in progress/);

  click(window, card.querySelector('[data-cancel]'));
  await waitFor(
    () => /Cancelled/.test(doc.querySelector(`[data-order="${order.id}"]`)?.textContent || ''),
    'the cancelled state'
  );

  window.close();
});

test('a delivered order offers a rating dialog that posts a review', async () => {
  const token = await customerToken();

  await call('POST', '/api/cart/items', { token, body: { item_id: dish['tiramisu'].id, quantity: 1 } });
  const { body } = await call('POST', '/api/orders', {
    token, body: { name: 'Uma Patel', phone: VALID_PHONE, address: VALID_ADDRESS },
  });
  db.prepare("UPDATE orders SET status = 'delivered', auto_advance = 0 WHERE id = ?").run(body.order.id);

  const { window, doc } = await loadPage('orders.html', { token });
  const rateBtn = await waitFor(
    () => doc.querySelector(`[data-order="${body.order.id}"] [data-rate]`),
    'a rate button on the delivered order'
  );

  click(window, rateBtn);
  await waitFor(() => doc.getElementById('reviewModal').classList.contains('is-open'), 'the review modal');
  assert.equal(doc.getElementById('reviewDish').textContent, 'Classic Tiramisu');

  // Submitting without a rating is refused in the form, before any request.
  submit(window, doc.getElementById('reviewForm'));
  await waitFor(() => doc.getElementById('reviewError').hidden === false, 'the missing-rating error');

  click(window, doc.querySelector('[data-star="5"]'));
  doc.getElementById('reviewForm').elements.comment.value = 'Lovely, properly bitter cocoa.';
  submit(window, doc.getElementById('reviewForm'));

  await waitFor(
    () => doc.getElementById('reviewModal').classList.contains('is-open') === false,
    'the modal to close on success'
  );

  const stored = db.prepare('SELECT * FROM reviews WHERE item_id = ?').get(dish['tiramisu'].id);
  assert.ok(stored, 'the review reached the database');
  assert.equal(stored.rating, 5);

  window.close();
});

test('the orders page asks a signed-out visitor to sign in', async () => {
  const { window, doc } = await loadPage('orders.html');
  await waitFor(() => doc.querySelector('.gate'), 'the sign-in prompt');
  assert.match(doc.querySelector('.gate h2').textContent, /Sign in/i);
  window.close();
});

/* ================================================================== */
/* Admin dashboard                                                     */
/* ================================================================== */

test('the admin page refuses a customer account', async () => {
  const token = await customerToken();
  const { window, doc } = await loadPage('admin.html', { token });

  await waitFor(() => /required/i.test(doc.getElementById('gateTitle').textContent), 'the admin gate');
  assert.equal(doc.getElementById('adminMain').hidden, true);

  window.close();
});

test('the admin dashboard renders stats, orders and menu controls', async () => {
  const token = await adminToken();
  const { window, doc } = await loadPage('admin.html', { token });

  await waitFor(() => doc.getElementById('adminMain').hidden === false, 'the dashboard to unlock');
  await waitFor(() => doc.querySelectorAll('.stat-card').length === 6, 'the stat cards');
  await waitFor(() => doc.querySelectorAll('.menu-admin-row').length === 30, 'a row per dish');

  assert.match(doc.getElementById('whoami').textContent, /uiadmin@test\.local/);
  assert.match(doc.getElementById('statGrid').textContent, /Revenue/);

  // Every menu row exposes price, stock and availability.
  const row = doc.querySelector('.menu-admin-row');
  assert.ok(row.querySelector('[data-price-for]'));
  assert.ok(row.querySelector('[data-stock-for]'));
  assert.ok(row.querySelector('[data-available-for]'));

  window.close();
});

test('the kitchen can move an order along the lifecycle from the dashboard', async () => {
  const customer = await customerToken();
  await call('POST', '/api/cart/items', { token: customer, body: { item_id: dish['alfredo'].id, quantity: 1 } });
  const { body } = await call('POST', '/api/orders', {
    token: customer, body: { name: 'Uma Patel', phone: VALID_PHONE, address: VALID_ADDRESS },
  });

  const token = await adminToken();
  const { window, doc } = await loadPage('admin.html', { token });

  await waitFor(() => doc.getElementById('adminMain').hidden === false, 'the dashboard');
  const select = await waitFor(
    () => doc.querySelector(`[data-order="${body.order.id}"] [data-status-for]`),
    'a status dropdown for the new order'
  );

  // Only legal next statuses are offered — "delivered" is not reachable yet.
  const options = [...select.options].map((o) => o.value);
  assert.ok(options.includes('confirmed'));
  assert.ok(!options.includes('delivered'), 'an illegal jump is not even offered');

  select.value = 'confirmed';
  change(window, select);

  await waitFor(
    () => db.prepare('SELECT status FROM orders WHERE id = ?').get(body.order.id).status === 'confirmed',
    'the status change to persist'
  );

  window.close();
});

test('the analytics tab renders charts and an honest forecast verdict', async () => {
  const token = await adminToken();
  const { window, doc } = await loadPage('admin.html', { token });
  await waitFor(() => doc.getElementById('adminMain').hidden === false, 'the dashboard');

  click(window, doc.querySelector('[data-view="analytics"]'));
  assert.equal(doc.getElementById('viewAnalytics').hidden, false);

  await waitFor(() => doc.getElementById('forecastPanel').textContent.trim().length > 0, 'the forecast panel');

  // This suite's database holds only today's orders, so the honest answer is
  // "not enough history" rather than a fabricated prediction.
  assert.match(doc.getElementById('forecastPanel').textContent, /Not enough history|Method:/);

  await waitFor(() => doc.getElementById('hourChart').children.length > 0, 'the hourly chart');

  window.close();
});

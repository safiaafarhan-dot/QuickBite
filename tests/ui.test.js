'use strict';

/**
 * Front-end smoke tests. The real pages are loaded into jsdom and pointed at a
 * live server, so these exercise the same code the browser runs: the menu
 * renders, the cart drawer updates, sign-in works and checkout places an order.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const TMP_DB = path.join(os.tmpdir(), `quickbite-ui-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.JWT_SECRET = 'test-secret';

const app = require('../server/index');
const { hashPassword } = require('../server/auth');
const { db } = require('../server/db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
    'Uma Patel', 'ui@test.local', await hashPassword('secret123'), 'customer'
  );
});

test.after(() => {
  server?.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${TMP_DB}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
});

/**
 * Loads one of the real HTML pages into jsdom with its scripts running against
 * the test server.
 */
async function loadPage(file, { token, search = '' } = {}) {
  const html = fs
    .readFileSync(path.join(PUBLIC_DIR, file), 'utf8')
    .replace(/<link[^>]+stylesheet[^>]*>/g, ''); // jsdom does not need the CSS

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    if (!/Could not parse CSS|Not implemented/.test(err.message)) throw err;
  });

  const dom = new JSDOM(html, {
    url: `${base}/${file}${search}`,
    runScripts: 'dangerously',
    resources: undefined, // scripts are injected manually below
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;
  window.fetch = (input, init) => fetch(new URL(input, base), init);
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  // Each jsdom window gets its own localStorage, so a signed-in page needs the
  // token seeded before the scripts boot.
  if (token) window.localStorage.setItem('qb_token', token);

  // Run the page's own scripts in document order.
  for (const tag of [...window.document.querySelectorAll('script[src]')]) {
    const code = fs.readFileSync(path.join(PUBLIC_DIR, tag.getAttribute('src')), 'utf8');
    window.eval(code);
  }

  return { dom, window, doc: window.document };
}

/** Waits until `fn()` returns a truthy value, or fails after `timeout` ms. */
async function waitFor(fn, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const click = (window, node) =>
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

/* ================================================================== */

test('home page renders the menu from the API', async () => {
  const { window, doc } = await loadPage('index.html');

  const cards = await waitFor(
    () => (doc.querySelectorAll('.dish').length === 6 ? doc.querySelectorAll('.dish') : null),
    'six dish cards to render'
  );

  const names = [...cards].map((c) => c.querySelector('h3').textContent);
  assert.ok(names.includes('Classic Margherita Pizza'));
  assert.ok(names.includes('Chicken Biryani'));

  // Prices and the category chips come from the server too.
  assert.match(cards[0].querySelector('.price').textContent, /₹/);
  assert.ok(doc.querySelectorAll('#categoryChips .chip').length >= 3);

  window.close();
});

test('a guest can add to the cart and sees server-priced totals', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu to render');

  const pizza = [...doc.querySelectorAll('.dish')].find(
    (c) => c.querySelector('h3').textContent === 'Classic Margherita Pizza'
  );

  // Bump the stepper to 2, then add.
  click(window, pizza.querySelector('[data-step="1"]'));
  assert.equal(pizza.querySelector('.qty-input').value, '2');
  click(window, pizza.querySelector('[data-add]'));

  await waitFor(() => doc.getElementById('cartCount').textContent === '2', 'the cart badge to show 2');

  const lines = doc.querySelectorAll('.cart-line');
  assert.equal(lines.length, 1);
  assert.match(lines[0].querySelector('.cart-line-total').textContent, /900/);

  const totals = doc.getElementById('cartTotals').textContent;
  assert.match(totals, /Subtotal/);
  assert.match(totals, /945/, 'the grand total is ₹900 + 5% GST with free delivery');

  // The basket survives a reload because it lives in localStorage.
  assert.equal(JSON.parse(window.localStorage.getItem('qb_guest_cart'))[0].quantity, 2);

  window.close();
});

test('a coupon typed into the drawer is validated by the server', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu to render');

  click(window, doc.querySelector('[data-add]'));
  await waitFor(() => doc.querySelectorAll('.cart-line').length === 1, 'a cart line');

  doc.getElementById('couponInput').value = 'QUICK10';
  doc.getElementById('couponForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const msg = await waitFor(
    () => (doc.getElementById('couponMsg').hidden === false ? doc.getElementById('couponMsg') : null),
    'the coupon message'
  );
  assert.match(msg.textContent, /QUICK10 applied/);

  doc.getElementById('couponInput').value = 'FAKECODE';
  doc.getElementById('couponForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(
    () => /not valid/.test(doc.getElementById('couponMsg').textContent),
    'the invalid-coupon message'
  );

  window.close();
});

test('signing in adopts the guest cart and reveals the account menu', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu to render');

  click(window, doc.querySelector('[data-add]'));
  await waitFor(() => doc.getElementById('cartCount').textContent === '1', 'one item in the guest cart');

  click(window, doc.getElementById('signInBtn'));
  const form = doc.getElementById('authForm');
  form.elements.email.value = 'ui@test.local';
  form.elements.password.value = 'secret123';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitFor(() => doc.getElementById('signInBtn').hidden === true, 'the sign-in button to disappear');
  assert.equal(doc.getElementById('accountEmail').textContent, 'ui@test.local');
  assert.equal(doc.getElementById('accountName').textContent, 'Uma');

  // The guest basket moved onto the account.
  assert.equal(doc.getElementById('cartCount').textContent, '1');
  assert.equal(window.localStorage.getItem('qb_guest_cart'), null);

  window.close();
});

test('checkout places a real order and shows the confirmation', async () => {
  const { window, doc } = await loadPage('index.html');
  await waitFor(() => doc.querySelector('.dish'), 'the menu to render');

  click(window, doc.querySelector('[data-add]'));
  await waitFor(() => doc.querySelectorAll('.cart-line').length === 1, 'a cart line');

  click(window, doc.getElementById('signInBtn'));
  const auth = doc.getElementById('authForm');
  auth.elements.email.value = 'ui@test.local';
  auth.elements.password.value = 'secret123';
  auth.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => doc.getElementById('signInBtn').hidden === true, 'sign-in to complete');

  click(window, doc.getElementById('checkoutBtn'));
  await waitFor(() => doc.getElementById('checkoutModal').classList.contains('is-open'), 'the checkout modal');

  const checkout = doc.getElementById('checkoutForm');
  checkout.elements.name.value = 'Uma Patel';
  checkout.elements.phone.value = '+91 98765 43210';
  checkout.elements.address.value = '9 Jasmine Lane, Koramangala, Bengaluru 560034';
  checkout.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitFor(
    () => doc.getElementById('successModal').classList.contains('is-open'),
    'the order confirmation'
  );
  assert.match(doc.getElementById('successText').textContent, /QB-/);
  assert.match(doc.getElementById('trackOrderLink').href, /orders\.html\?order=\d+/);

  // The cart is emptied once the order lands.
  assert.equal(doc.getElementById('cartCount').textContent, '0');

  window.close();
});

test('the orders page tracks a live order', async () => {
  // Place an order over the API, then open the real page as that customer.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ui@test.local', password: 'secret123' }),
  }).then((r) => r.json());

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  await fetch(`${base}/api/cart/items`, {
    method: 'POST', headers: auth, body: JSON.stringify({ item_id: 2, quantity: 1 }),
  });
  const { order } = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'Uma Patel',
      phone: '+91 98765 43210',
      address: '9 Jasmine Lane, Koramangala, Bengaluru 560034',
    }),
  }).then((r) => r.json());

  const { window, doc } = await loadPage('orders.html', {
    token: login.token,
    search: `?order=${order.id}`,
  });

  await waitFor(() => doc.querySelector('.order-card'), 'an order card');

  const card = doc.querySelector(`[data-order="${order.id}"]`);
  assert.ok(card, 'the order just placed is listed');
  assert.equal(card.querySelector('.order-code').textContent, order.code);
  assert.ok(card.querySelector('.tracker-fill'), 'the progress bar renders');
  assert.match(card.querySelector('.status-pill').textContent, /Order placed|Restaurant confirmed/);
  assert.ok(card.querySelector('[data-cancel]'), 'a fresh order can still be cancelled');
  assert.ok(card.querySelector('[data-reorder]'));
  assert.match(doc.getElementById('ordersSubtitle').textContent, /in progress/);

  // Cancelling through the page updates the card.
  click(window, card.querySelector('[data-cancel]'));
  await waitFor(
    () => /Cancelled/.test(doc.querySelector(`[data-order="${order.id}"]`)?.textContent || ''),
    'the cancelled state'
  );

  window.close();
});

test('the orders page asks a signed-out visitor to sign in', async () => {
  const { window, doc } = await loadPage('orders.html');
  await waitFor(() => doc.querySelector('.gate'), 'the sign-in prompt');
  assert.match(doc.querySelector('.gate h2').textContent, /Sign in/i);
  window.close();
});

test('the admin page refuses a customer account', async () => {
  const { window, doc } = await loadPage('admin.html');

  await waitFor(
    () => /required/i.test(doc.getElementById('gateTitle').textContent),
    'the admin gate'
  );
  assert.equal(doc.getElementById('adminMain').hidden, true);

  window.close();
});

test('the admin dashboard renders stats, orders and menu controls', async () => {
  const { hashPassword: hash } = require('../server/auth');
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
    'Kitchen Admin', 'kitchen@test.local', await hash('admin123'), 'admin'
  );

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'kitchen@test.local', password: 'admin123' }),
  }).then((r) => r.json());

  const { window, doc } = await loadPage('admin.html', { token: login.token });

  await waitFor(() => doc.getElementById('adminMain').hidden === false, 'the dashboard to unlock');
  await waitFor(() => doc.querySelectorAll('.stat-card').length === 5, 'the stat cards');
  await waitFor(() => doc.querySelectorAll('.menu-admin-row').length === 6, 'the menu rows');

  assert.match(doc.getElementById('whoami').textContent, /kitchen@test\.local/);
  assert.match(doc.getElementById('statGrid').textContent, /Revenue/);

  // Every live order offers a status dropdown the kitchen can drive.
  const select = await waitFor(() => doc.querySelector('[data-status-for]'), 'an order status dropdown');
  assert.ok([...select.options].some((o) => o.value === 'out_for_delivery'));

  window.close();
});

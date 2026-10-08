'use strict';

/**
 * Creates the demo accounts (and one sample delivered order) so the app has
 * something to show on a fresh database. Safe to re-run.
 *
 *   npm run seed
 */

const { db } = require('../server/db');
const { hashPassword } = require('../server/auth');

const DEMO = [
  { name: 'QuickBite Admin', email: 'admin@quickbite.test', password: 'admin123', role: 'admin', phone: '+91 98765 43210', address: 'QuickBite Kitchen, MG Road, Bengaluru 560001' },
  { name: 'Priya Sharma', email: 'demo@quickbite.test', password: 'demo123', role: 'customer', phone: '+91 91234 56780', address: '12B Rose Apartments, Indiranagar, Bengaluru 560038' },
];

async function main() {
  const findByEmail = db.prepare('SELECT id FROM users WHERE email = ?');
  const insertUser = db.prepare(
    'INSERT INTO users (name, email, password_hash, phone, address, role) VALUES (?, ?, ?, ?, ?, ?)'
  );

  for (const user of DEMO) {
    if (findByEmail.get(user.email)) {
      console.log(`· ${user.email} already exists — skipped`);
      continue;
    }
    const hash = await hashPassword(user.password);
    insertUser.run(user.name, user.email, hash, user.phone, user.address, user.role);
    console.log(`✓ created ${user.role.padEnd(8)} ${user.email}  (password: ${user.password})`);
  }

  const customer = findByEmail.get('demo@quickbite.test');
  const hasOrders = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(customer.id).n;

  if (hasOrders === 0) {
    const lines = db.prepare('SELECT * FROM menu_items ORDER BY is_popular DESC LIMIT 2').all();
    const subtotal = lines.reduce((s, l) => s + l.price, 0);
    const tax = Math.round(subtotal * 0.05);
    const total = subtotal + tax;

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO orders (code, user_id, status, subtotal, discount, delivery_fee, tax, total,
                          customer_name, phone, address, payment_method, eta_minutes, auto_advance,
                          placed_at, updated_at)
      VALUES (?, ?, 'delivered', ?, 0, 0, ?, ?, ?, ?, ?, 'upi', 35, 0,
              datetime('now', '-2 days'), datetime('now', '-2 days'))
    `).run('QB-DEMO01', customer.id, subtotal, tax, total, 'Priya Sharma', '+91 91234 56780',
           '12B Rose Apartments, Indiranagar, Bengaluru 560038');

    const orderId = Number(lastInsertRowid);
    const insertItem = db.prepare(
      'INSERT INTO order_items (order_id, item_id, name, image, price, quantity) VALUES (?, ?, ?, ?, ?, 1)'
    );
    for (const l of lines) insertItem.run(orderId, l.id, l.name, l.image, l.price);

    const insertEvent = db.prepare(
      "INSERT INTO order_events (order_id, status, note, at) VALUES (?, ?, '', datetime('now', ?))"
    );
    const stages = ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];
    for (const status of stages) insertEvent.run(orderId, status, '-2 days');

    console.log('✓ created sample past order QB-DEMO01 for demo@quickbite.test');
  }

  console.log('\nDone. Start the app with `npm start` and sign in with one of the accounts above.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

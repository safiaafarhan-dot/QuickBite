'use strict';

/**
 * Seeds demo accounts and a synthetic order history.
 *
 *   npm run seed              # accounts + 45 days of demo orders
 *   npm run seed -- --accounts-only
 *
 * The order history is CLEARLY SYNTHETIC: it exists so the kitchen dashboard's
 * analytics and demand forecast have something real to compute over. Every
 * generated order is placed by one of the demo customers below. Running this
 * against a database with real orders adds to it rather than replacing it, so
 * do not run it in production.
 */

const { sql, transaction, initDb, closeDb } = require('../server/db');
const { hashPassword } = require('../server/auth');

const DEMO_USERS = [
  {
    name: 'QuickBite Admin', email: 'admin@quickbite.test', password: 'admin1234', role: 'admin',
    phone: '+91 98765 43210', address: 'QuickBite Kitchen, MG Road, Bengaluru 560001',
  },
  {
    name: 'Priya Sharma', email: 'demo@quickbite.test', password: 'demo1234', role: 'customer',
    phone: '+91 91234 56780', address: '12B Rose Apartments, Indiranagar, Bengaluru 560038',
  },
  {
    name: 'Rahul Nair', email: 'rahul@quickbite.test', password: 'demo1234', role: 'customer',
    phone: '+91 98111 22334', address: '7 Lakeview Residency, Koramangala, Bengaluru 560034',
  },
  {
    name: 'Aisha Khan', email: 'aisha@quickbite.test', password: 'demo1234', role: 'customer',
    phone: '+91 97000 11223', address: '301 Palm Court, Whitefield, Bengaluru 560066',
  },
];

/** Dish groups that realistically get ordered together. */
const BASKET_PATTERNS = [
  ['margherita-pizza', 'garlic-bread', 'cold-brew'],
  ['pepperoni-pizza', 'chicken-wings'],
  ['chicken-biryani', 'gulab-jamun', 'masala-chai'],
  ['butter-chicken', 'dal-makhani'],
  ['paneer-butter-masala', 'veg-biryani', 'mango-lassi'],
  ['carbonara', 'tiramisu'],
  ['alfredo', 'garlic-bread'],
  ['veggie-burger', 'orange-juice'],
  ['chicken-burger', 'chicken-wings'],
  ['hakka-noodles', 'spring-rolls'],
  ['chicken-fried-rice', 'pad-thai'],
  ['lasagna', 'lava-cake'],
  ['paneer-tikka', 'masala-chai'],
  ['farmhouse-pizza', 'vanilla-ice-cream'],
  ['arrabbiata', 'garlic-bread', 'cold-brew'],
  ['bbq-burger', 'cold-brew'],
];

/* Deterministic pseudo-random, so re-seeding produces comparable data. */
let seedValue = 20250101;
function random() {
  seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
  return seedValue / 2147483648;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + Math.floor(random() * (max - min + 1));

function makeCode(n) {
  return `QB-D${String(n).padStart(5, '0')}`;
}

async function ensureUsers() {
  const users = [];

  for (const user of DEMO_USERS) {
    const existing = await sql.get('SELECT id, role FROM users WHERE email = $1', [user.email]);
    if (existing) {
      console.log(`· ${user.email.padEnd(26)} already exists`);
      users.push({ ...user, id: existing.id });
      continue;
    }

    const hash = await hashPassword(user.password);
    /*
     * `ON CONFLICT (email) DO NOTHING` so two seeds running at once — or a
     * seed racing a real registration — cannot fail on the unique index. When
     * nothing is returned the row already exists and is read back below.
     */
    const inserted = await sql.run(`
      INSERT INTO users (name, email, password_hash, phone, address, role)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `, [user.name, user.email, hash, user.phone, user.address, user.role]);

    const id = inserted.row
      ? inserted.row.id
      : (await sql.get('SELECT id FROM users WHERE email = $1', [user.email])).id;

    users.push({ ...user, id });
    console.log(`✓ ${user.email.padEnd(26)} created  (${user.role}, password: ${user.password})`);
  }

  return users;
}

async function seedAddresses(users) {
  const { n: count } = await sql.get('SELECT COUNT(*) AS n FROM addresses');
  if (count > 0) return;

  const INSERT = `
    INSERT INTO addresses (user_id, label, recipient, phone, line1, city, pincode, is_default)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `;

  for (const user of users.filter((u) => u.role === 'customer')) {
    const [line1, city, pincode] = user.address.split(',').map((s) => s.trim());
    await sql.run(INSERT, [user.id, 'Home', user.name, user.phone, line1, city || 'Bengaluru',
      (pincode || '').replace(/\D/g, '').slice(0, 6) || '560001', 1]);
  }
  console.log('✓ saved a Home address for each demo customer');
}

/**
 * Generates `days` of order history ending yesterday, with a realistic weekday
 * pattern (weekends busier) and lunch/dinner peaks.
 */
async function seedOrderHistory(users, days = 45) {
  const { n: existing } = await sql.get("SELECT COUNT(*) AS n FROM orders WHERE code LIKE 'QB-D%'");
  if (existing > 0) {
    console.log(`· ${existing} synthetic orders already present — skipped`);
    return 0;
  }

  const customers = users.filter((u) => u.role === 'customer');
  const menuRows = await sql.all('SELECT id, slug, name, price, image, prep_minutes FROM menu_items');
  const menu = new Map(menuRows.map((r) => [r.slug, r]));

  /*
   * The timestamps below are generated as UTC and handed over with an explicit
   * `+00` offset, so the demo history lands in the same hour buckets the
   * analytics queries read it back from whatever zone the server runs in.
   */
  const INSERT_ORDER = `
    INSERT INTO orders (code, user_id, status, subtotal, discount, delivery_fee, tax, total,
                        coupon_code, customer_name, phone, address, notes, payment_method,
                        payment_status, eta_minutes, auto_advance, placed_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '', $13, $14, $15, 0,
            $16::timestamptz, $17::timestamptz)
    RETURNING id
  `;
  const INSERT_ITEM =
    'INSERT INTO order_items (order_id, item_id, name, image, price, quantity) VALUES ($1, $2, $3, $4, $5, $6)';
  const INSERT_EVENT =
    'INSERT INTO order_events (order_id, status, note, at) VALUES ($1, $2, $3, $4::timestamptz)';
  const INSERT_REDEMPTION =
    'INSERT INTO coupon_redemptions (code, user_id, order_id, amount_off, redeemed_at) VALUES ($1, $2, $3, $4, $5::timestamptz)';

  let created = 0;

  await transaction(async (tx) => {
    for (let dayOffset = days; dayOffset >= 1; dayOffset--) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - dayOffset);
      const weekday = date.getUTCDay();

      // Weekends are roughly twice as busy as a Tuesday.
      const base = weekday === 0 || weekday === 6 ? between(7, 11) : between(3, 6);

      for (let n = 0; n < base; n++) {
        const customer = pick(customers);
        const pattern = pick(BASKET_PATTERNS);

        const lines = pattern
          .map((slug) => menu.get(slug))
          .filter(Boolean)
          .map((item) => ({ item, quantity: random() > 0.78 ? 2 : 1 }));

        if (lines.length === 0) continue;

        const subtotal = lines.reduce((sum, l) => sum + l.item.price * l.quantity, 0);
        const useCoupon = random() > 0.78 && subtotal >= 300;
        const discount = useCoupon ? Math.min(Math.round(subtotal * 0.1), 100) : 0;
        const deliveryFee = subtotal >= 500 ? 0 : 40;
        const tax = Math.round(((subtotal - discount) * 5) / 100);
        const total = subtotal - discount + deliveryFee + tax;

        // Lunch (12–14) and dinner (19–22) peaks.
        const hour = random() > 0.45 ? between(19, 22) : between(12, 14);
        date.setUTCHours(hour, between(0, 59), between(0, 59), 0);
        const placedAt = `${date.toISOString().slice(0, 19).replace('T', ' ')}+00`;

        const cancelled = random() > 0.94;
        const status = cancelled ? 'cancelled' : 'delivered';
        const paymentMethod = pick(['cod', 'upi', 'card']);
        const eta = Math.max(...lines.map((l) => l.item.prep_minutes)) + 15;

        const inserted = await tx.run(INSERT_ORDER, [
          makeCode(++created), customer.id, status,
          subtotal, discount, deliveryFee, tax, total,
          useCoupon ? 'QUICK10' : null,
          customer.name, customer.phone, customer.address,
          paymentMethod, paymentMethod === 'cod' ? 'on_delivery' : 'paid',
          eta, placedAt, placedAt,
        ]);

        const orderId = inserted.row.id;
        for (const line of lines) {
          await tx.run(INSERT_ITEM,
            [orderId, line.item.id, line.item.name, line.item.image, line.item.price, line.quantity]);
        }

        const stages = cancelled
          ? ['placed', 'cancelled']
          : ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];
        for (const stage of stages) await tx.run(INSERT_EVENT, [orderId, stage, 'demo data', placedAt]);

        if (useCoupon) {
          await tx.run(INSERT_REDEMPTION, ['QUICK10', customer.id, orderId, discount, placedAt]);
          await tx.run('UPDATE coupons SET times_used = times_used + 1 WHERE code = $1', ['QUICK10']);
        }
      }
    }
  });

  console.log(`✓ generated ${created} synthetic orders across ${days} days (codes start QB-D)`);
  return created;
}

/** A few reviews so the menu shows real ratings rather than only seeded ones. */
async function seedReviews(users) {
  if ((await sql.get('SELECT COUNT(*) AS n FROM reviews')).n > 0) return;

  const customers = users.filter((u) => u.role === 'customer');
  // `ON CONFLICT DO NOTHING` is SQLite's INSERT OR IGNORE; the unique index on
  // (user_id, item_id) is what it defers to.
  const INSERT = `
    INSERT INTO reviews (user_id, item_id, order_id, rating, comment, created_at)
    VALUES ($1, $2, $3, $4, $5, now() - interval '3 days')
    ON CONFLICT (user_id, item_id) DO NOTHING
  `;

  const comments = [
    [5, 'Arrived hot and the base was perfect.'],
    [5, 'Easily the best version of this I have ordered.'],
    [4, 'Really good — I would have liked a little more spice.'],
    [4, 'Generous portion and quick delivery.'],
    [5, 'Ordered it twice in one week. No regrets.'],
  ];

  let added = 0;
  for (const customer of customers) {
    const delivered = await sql.all(`
      SELECT DISTINCT oi.item_id, o.id AS order_id
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = $1 AND o.status = 'delivered' AND oi.item_id IS NOT NULL
      LIMIT 4
    `, [customer.id]);

    for (const row of delivered) {
      const [rating, comment] = pick(comments);
      await sql.run(INSERT, [customer.id, row.item_id, row.order_id, rating, comment]);
      added += 1;
    }
  }

  /*
   * Recompute the headline rating for anything that now has real opinions.
   * `AVG` is numeric, and `rating` is double precision, so the result is cast
   * rather than relying on an implicit conversion.
   */
  await sql.exec(`
    UPDATE menu_items
    SET rating = ROUND(sub.avg_rating, 2)::float8
    FROM (SELECT item_id, AVG(rating) AS avg_rating FROM reviews GROUP BY item_id) sub
    WHERE sub.item_id = menu_items.id
  `);

  console.log(`✓ added ${added} dish reviews from the demo customers`);
}

async function main() {
  const accountsOnly = process.argv.includes('--accounts-only');

  console.log('\nSeeding QuickBite…\n');

  // Connect, migrate and load the menu before anything references a table.
  await initDb({ log: true });

  const users = await ensureUsers();
  await seedAddresses(users);

  if (!accountsOnly) {
    await seedOrderHistory(users);
    await seedReviews(users);
  }

  const counts = {
    users: (await sql.get('SELECT COUNT(*) AS n FROM users')).n,
    dishes: (await sql.get('SELECT COUNT(*) AS n FROM menu_items WHERE is_available = 1')).n,
    orders: (await sql.get('SELECT COUNT(*) AS n FROM orders')).n,
    reviews: (await sql.get('SELECT COUNT(*) AS n FROM reviews')).n,
  };

  console.log('\n──────────────────────────────────────────────');
  console.log(`  ${counts.dishes} dishes · ${counts.users} users · ${counts.orders} orders · ${counts.reviews} reviews`);
  console.log('──────────────────────────────────────────────');
  console.log('\n  Sign in with:');
  console.log('    customer  demo@quickbite.test  / demo1234');
  console.log('    kitchen   admin@quickbite.test / admin1234');
  console.log('\n  Start the app with `npm start`.\n');

  if (!accountsOnly) {
    console.log('  Note: order history is SYNTHETIC demo data generated by this');
    console.log('  script so the dashboard analytics have something to show.\n');
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err.help || err);
    await closeDb().catch(() => {});
    process.exit(1);
  });

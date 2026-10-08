'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(DATA_DIR, 'quickbite.db');

const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  phone         TEXT,
  address       TEXT,
  role          TEXT    NOT NULL DEFAULT 'customer',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS menu_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  description   TEXT    NOT NULL DEFAULT '',
  price         INTEGER NOT NULL,
  image         TEXT    NOT NULL DEFAULT 'images/placeholder.svg',
  category      TEXT    NOT NULL DEFAULT 'mains',
  is_veg        INTEGER NOT NULL DEFAULT 1,
  is_popular    INTEGER NOT NULL DEFAULT 0,
  rating        REAL    NOT NULL DEFAULT 4.5,
  prep_minutes  INTEGER NOT NULL DEFAULT 20,
  is_available  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cart_items (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  quantity  INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  code          TEXT PRIMARY KEY,
  description   TEXT    NOT NULL,
  percent_off   INTEGER NOT NULL DEFAULT 0,
  flat_off      INTEGER NOT NULL DEFAULT 0,
  free_delivery INTEGER NOT NULL DEFAULT 0,
  min_subtotal  INTEGER NOT NULL DEFAULT 0,
  max_discount  INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT    NOT NULL DEFAULT 'placed',
  subtotal       INTEGER NOT NULL,
  discount       INTEGER NOT NULL DEFAULT 0,
  delivery_fee   INTEGER NOT NULL DEFAULT 0,
  tax            INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL,
  coupon_code    TEXT,
  customer_name  TEXT    NOT NULL,
  phone          TEXT    NOT NULL,
  address        TEXT    NOT NULL,
  notes          TEXT    NOT NULL DEFAULT '',
  payment_method TEXT    NOT NULL DEFAULT 'cod',
  eta_minutes    INTEGER NOT NULL DEFAULT 35,
  auto_advance   INTEGER NOT NULL DEFAULT 1,
  placed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id  INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  name     TEXT    NOT NULL,
  image    TEXT    NOT NULL DEFAULT 'images/placeholder.svg',
  price    INTEGER NOT NULL,
  quantity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status   TEXT    NOT NULL,
  note     TEXT    NOT NULL DEFAULT '',
  at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, id);
`);

/* ------------------------------------------------------------------ */
/* Seed data                                                           */
/* ------------------------------------------------------------------ */

const MENU_SEED = [
  {
    name: 'Classic Margherita Pizza',
    description: 'Hand-stretched base, San Marzano tomato, fior di latte and fresh basil.',
    price: 450, image: 'images/pizza.jpeg', category: 'pizza',
    is_veg: 1, is_popular: 1, rating: 4.7, prep_minutes: 18,
  },
  {
    name: 'Spaghetti Carbonara',
    description: 'Silky egg-and-parmesan sauce with crisp pancetta and cracked pepper.',
    price: 520, image: 'images/carbonara.jpeg', category: 'pasta',
    is_veg: 0, is_popular: 1, rating: 4.6, prep_minutes: 22,
  },
  {
    name: 'Penne Arrabbiata',
    description: 'Fiery tomato sugo with garlic, red chilli and a drizzle of olive oil.',
    price: 380, image: 'images/pasta.jpeg', category: 'pasta',
    is_veg: 1, is_popular: 0, rating: 4.4, prep_minutes: 20,
  },
  {
    name: 'Veggie Burger',
    description: 'Charred vegetable patty, smoked cheddar and house burger sauce.',
    price: 400, image: 'images/burger.webp', category: 'burgers',
    is_veg: 1, is_popular: 1, rating: 4.5, prep_minutes: 15,
  },
  {
    name: 'Chicken Biryani',
    description: 'Dum-cooked basmati layered with marinated chicken, saffron and fried onion.',
    price: 720, image: 'images/biriyani.jpg', category: 'mains',
    is_veg: 0, is_popular: 1, rating: 4.8, prep_minutes: 30,
  },
  {
    name: 'Vanilla Bean Ice Cream',
    description: 'Slow-churned Madagascar vanilla, scooped to order.',
    price: 310, image: 'images/icecream.jpeg', category: 'desserts',
    is_veg: 1, is_popular: 0, rating: 4.3, prep_minutes: 5,
  },
];

const COUPON_SEED = [
  { code: 'QUICK10', description: '10% off your order (max ₹100)', percent_off: 10, flat_off: 0, free_delivery: 0, min_subtotal: 300, max_discount: 100 },
  { code: 'FREEDEL', description: 'Free delivery on orders above ₹400', percent_off: 0, flat_off: 0, free_delivery: 1, min_subtotal: 400, max_discount: 0 },
  { code: 'BITE50', description: 'Flat ₹50 off above ₹600', percent_off: 0, flat_off: 50, free_delivery: 0, min_subtotal: 600, max_discount: 0 },
];

function seed() {
  const insertItem = db.prepare(`
    INSERT INTO menu_items (name, description, price, image, category, is_veg, is_popular, rating, prep_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      price       = excluded.price,
      image       = excluded.image,
      category    = excluded.category,
      is_veg      = excluded.is_veg,
      is_popular  = excluded.is_popular,
      rating      = excluded.rating,
      prep_minutes= excluded.prep_minutes
  `);
  for (const m of MENU_SEED) {
    insertItem.run(m.name, m.description, m.price, m.image, m.category, m.is_veg, m.is_popular, m.rating, m.prep_minutes);
  }

  const insertCoupon = db.prepare(`
    INSERT INTO coupons (code, description, percent_off, flat_off, free_delivery, min_subtotal, max_discount)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      description   = excluded.description,
      percent_off   = excluded.percent_off,
      flat_off      = excluded.flat_off,
      free_delivery = excluded.free_delivery,
      min_subtotal  = excluded.min_subtotal,
      max_discount  = excluded.max_discount
  `);
  for (const c of COUPON_SEED) {
    insertCoupon.run(c.code, c.description, c.percent_off, c.flat_off, c.free_delivery, c.min_subtotal, c.max_discount);
  }
}

seed();

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

let depth = 0;

/**
 * Wraps `fn` so every statement inside it commits or rolls back together.
 * `node:sqlite` has no transaction helper of its own, and nesting is handled
 * with savepoints so a wrapped function can safely call another one.
 *
 * @returns {Function} the wrapped function, callable with the same arguments
 */
function transaction(fn) {
  return (...args) => {
    const savepoint = `sp_${depth}`;
    db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const result = fn(...args);
      depth -= 1;
      db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      depth -= 1;
      db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
      throw err;
    }
  };
}

module.exports = { db, transaction, DB_FILE };

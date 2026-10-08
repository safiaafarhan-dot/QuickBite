'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const { migrate } = require('./migrations');
const { MENU } = require('./data/menu');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(DATA_DIR, 'quickbite.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL');   // readers never block the writer
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');  // wait rather than fail under contention

migrate(db, { log: process.env.NODE_ENV !== 'test' });

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
    db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
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

/* ------------------------------------------------------------------ */
/* Seed: menu and coupons                                              */
/* ------------------------------------------------------------------ */

const COUPONS = [
  {
    code: 'QUICK10', description: '10% off your order (max ₹100)',
    percent_off: 10, flat_off: 0, free_delivery: 0,
    min_subtotal: 300, max_discount: 100,
    expires_at: null, usage_limit: 0, per_user_limit: 0,
  },
  {
    code: 'FREEDEL', description: 'Free delivery on orders above ₹400',
    percent_off: 0, flat_off: 0, free_delivery: 1,
    min_subtotal: 400, max_discount: 0,
    expires_at: null, usage_limit: 0, per_user_limit: 0,
  },
  {
    code: 'BITE50', description: 'Flat ₹50 off above ₹600',
    percent_off: 0, flat_off: 50, free_delivery: 0,
    min_subtotal: 600, max_discount: 0,
    expires_at: null, usage_limit: 0, per_user_limit: 0,
  },
  {
    code: 'WELCOME20', description: '20% off your first order (max ₹150, once per account)',
    percent_off: 20, flat_off: 0, free_delivery: 0,
    min_subtotal: 250, max_discount: 150,
    expires_at: null, usage_limit: 0, per_user_limit: 1,
  },
  {
    code: 'EXPIRED5', description: 'Expired demo coupon — used to prove the expiry check works',
    percent_off: 5, flat_off: 0, free_delivery: 0,
    min_subtotal: 0, max_discount: 0,
    expires_at: '2020-01-01 00:00:00', usage_limit: 0, per_user_limit: 0,
  },
];

/**
 * Brings the menu and coupon tables in line with the source files.
 *
 * Prices and availability are *not* overwritten for dishes that already exist:
 * an operator may have changed them from the admin dashboard, and a restart
 * must not silently undo that.
 */
function seedReferenceData() {
  const insertItem = db.prepare(`
    INSERT INTO menu_items
      (name, slug, description, price, image, category, cuisine, tags,
       is_veg, is_popular, rating, prep_minutes, spice_level, calories, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      slug         = excluded.slug,
      description  = excluded.description,
      image        = excluded.image,
      category     = excluded.category,
      cuisine      = excluded.cuisine,
      tags         = excluded.tags,
      is_veg       = excluded.is_veg,
      is_popular   = excluded.is_popular,
      prep_minutes = excluded.prep_minutes,
      spice_level  = excluded.spice_level,
      calories     = excluded.calories,
      sort_order   = excluded.sort_order
  `);

  const insertCoupon = db.prepare(`
    INSERT INTO coupons
      (code, description, percent_off, flat_off, free_delivery,
       min_subtotal, max_discount, expires_at, usage_limit, per_user_limit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      description    = excluded.description,
      percent_off    = excluded.percent_off,
      flat_off       = excluded.flat_off,
      free_delivery  = excluded.free_delivery,
      min_subtotal   = excluded.min_subtotal,
      max_discount   = excluded.max_discount,
      expires_at     = excluded.expires_at,
      usage_limit    = excluded.usage_limit,
      per_user_limit = excluded.per_user_limit
  `);

  transaction(() => {
    MENU.forEach((dish, index) => {
      insertItem.run(
        dish.name, dish.slug, dish.description, dish.price,
        `images/dishes/${dish.slug}.jpg`,
        dish.category, dish.cuisine, dish.tags,
        dish.is_veg, dish.is_popular, dish.rating, dish.prep_minutes,
        dish.spice_level ?? 0, dish.calories ?? 0, index
      );
    });

    for (const c of COUPONS) {
      insertCoupon.run(
        c.code, c.description, c.percent_off, c.flat_off, c.free_delivery,
        c.min_subtotal, c.max_discount, c.expires_at, c.usage_limit, c.per_user_limit
      );
    }

    // A dish dropped from the menu file is hidden, never deleted — past orders
    // and reviews still point at it.
    const names = MENU.map((d) => d.name);
    const placeholders = names.map(() => '?').join(',');
    db.prepare(
      `UPDATE menu_items SET is_available = 0 WHERE name NOT IN (${placeholders})`
    ).run(...names);
  })();
}

seedReferenceData();

module.exports = { db, transaction, DB_FILE };

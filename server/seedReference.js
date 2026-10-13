'use strict';

/**
 * Reference data: the menu and the coupon catalogue.
 *
 * This runs on every boot and must be safe to run repeatedly — on Render that
 * is every deploy, and on a free instance every cold start. Both upserts key on
 * a natural unique column (`menu_items.name`, `coupons.code`), so a restart
 * updates the rows it already created rather than inserting duplicates.
 *
 * Prices, stock and availability are deliberately *not* overwritten for dishes
 * that already exist: an operator may have changed them from the admin
 * dashboard, and a restart must not silently undo that.
 */

const { sql, transaction } = require('./db');
const { MENU } = require('./data/menu');

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
    expires_at: '2020-01-01 00:00:00+00', usage_limit: 0, per_user_limit: 0,
  },
];

const INSERT_ITEM = `
  INSERT INTO menu_items
    (name, slug, description, price, image, category, cuisine, tags,
     is_veg, is_popular, rating, prep_minutes, spice_level, calories, sort_order)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  ON CONFLICT (name) DO UPDATE SET
    slug         = EXCLUDED.slug,
    description  = EXCLUDED.description,
    image        = EXCLUDED.image,
    category     = EXCLUDED.category,
    cuisine      = EXCLUDED.cuisine,
    tags         = EXCLUDED.tags,
    is_veg       = EXCLUDED.is_veg,
    is_popular   = EXCLUDED.is_popular,
    prep_minutes = EXCLUDED.prep_minutes,
    spice_level  = EXCLUDED.spice_level,
    calories     = EXCLUDED.calories,
    sort_order   = EXCLUDED.sort_order
`;

const INSERT_COUPON = `
  INSERT INTO coupons
    (code, description, percent_off, flat_off, free_delivery,
     min_subtotal, max_discount, expires_at, usage_limit, per_user_limit)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10)
  ON CONFLICT (code) DO UPDATE SET
    description    = EXCLUDED.description,
    percent_off    = EXCLUDED.percent_off,
    flat_off       = EXCLUDED.flat_off,
    free_delivery  = EXCLUDED.free_delivery,
    min_subtotal   = EXCLUDED.min_subtotal,
    max_discount   = EXCLUDED.max_discount,
    expires_at     = EXCLUDED.expires_at,
    usage_limit    = EXCLUDED.usage_limit,
    per_user_limit = EXCLUDED.per_user_limit
`;

/** Brings the menu and coupon tables in line with the source files. */
async function seedReferenceData() {
  await transaction(async (tx) => {
    for (const [index, dish] of MENU.entries()) {
      await tx.run(INSERT_ITEM, [
        dish.name, dish.slug, dish.description, dish.price,
        `images/dishes/${dish.slug}.jpg`,
        dish.category, dish.cuisine, dish.tags,
        dish.is_veg, dish.is_popular, dish.rating, dish.prep_minutes,
        dish.spice_level ?? 0, dish.calories ?? 0, index,
      ]);
    }

    for (const c of COUPONS) {
      await tx.run(INSERT_COUPON, [
        c.code, c.description, c.percent_off, c.flat_off, c.free_delivery,
        c.min_subtotal, c.max_discount, c.expires_at, c.usage_limit, c.per_user_limit,
      ]);
    }

    /*
     * A dish dropped from the menu file is hidden, never deleted — past orders
     * and reviews still point at it. One array parameter rather than a
     * generated list of placeholders, which is both safer and lets the
     * statement be reused whatever the menu's length.
     */
    await tx.run('UPDATE menu_items SET is_available = 0 WHERE name <> ALL($1::text[])', [
      MENU.map((d) => d.name),
    ]);
  });
}

module.exports = { seedReferenceData, COUPONS };

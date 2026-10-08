'use strict';

/**
 * Forward-only schema migrations.
 *
 * Each entry runs once, inside a transaction, and is recorded in
 * `schema_migrations`. Migrations must be additive and safe to run against a
 * database that already holds real orders and accounts — never DROP or rewrite
 * a table that holds user data.
 */

/** True when `table` already has a column called `column`. */
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function hasTable(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

/** Adds a column only if it is missing, so re-running is harmless. */
function addColumn(db, table, column, definition) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const MIGRATIONS = [
  {
    name: '001-baseline',
    up(db) {
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
    },
  },

  {
    name: '002-menu-attributes',
    up(db) {
      // Richer dish metadata: drives filters, the detail view and the recommender.
      addColumn(db, 'menu_items', 'slug', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'menu_items', 'cuisine', "TEXT NOT NULL DEFAULT 'other'");
      addColumn(db, 'menu_items', 'tags', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'menu_items', 'spice_level', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'menu_items', 'calories', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'menu_items', 'stock', 'INTEGER NOT NULL DEFAULT 100');
      addColumn(db, 'menu_items', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');

      db.exec('CREATE INDEX IF NOT EXISTS idx_menu_category ON menu_items(category, is_available)');
      // A dish may legitimately have no slug yet; only filled slugs must be unique.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_slug
               ON menu_items(slug) WHERE slug != ''`);
    },
  },

  {
    name: '003-coupon-limits',
    up(db) {
      addColumn(db, 'coupons', 'expires_at', 'TEXT');
      addColumn(db, 'coupons', 'usage_limit', 'INTEGER NOT NULL DEFAULT 0');     // 0 = unlimited
      addColumn(db, 'coupons', 'per_user_limit', 'INTEGER NOT NULL DEFAULT 0');  // 0 = unlimited
      addColumn(db, 'coupons', 'times_used', 'INTEGER NOT NULL DEFAULT 0');

      db.exec(`
        CREATE TABLE IF NOT EXISTS coupon_redemptions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          code        TEXT    NOT NULL REFERENCES coupons(code) ON DELETE CASCADE,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          amount_off  INTEGER NOT NULL,
          redeemed_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_redemption_order ON coupon_redemptions(order_id);
        CREATE INDEX IF NOT EXISTS idx_redemption_user ON coupon_redemptions(code, user_id);
      `);
    },
  },

  {
    name: '004-saved-addresses',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS addresses (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          label      TEXT    NOT NULL DEFAULT 'Home',
          recipient  TEXT    NOT NULL,
          phone      TEXT    NOT NULL,
          line1      TEXT    NOT NULL,
          city       TEXT    NOT NULL DEFAULT '',
          pincode    TEXT    NOT NULL DEFAULT '',
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id, is_default DESC, id DESC);
      `);
    },
  },

  {
    name: '005-reviews',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reviews (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          item_id    INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
          order_id   INTEGER REFERENCES orders(id) ON DELETE SET NULL,
          rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
          comment    TEXT    NOT NULL DEFAULT '',
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_review_once ON reviews(user_id, item_id);
        CREATE INDEX IF NOT EXISTS idx_reviews_item ON reviews(item_id);
      `);
    },
  },

  {
    name: '006-idempotency-and-payments',
    up(db) {
      // Replaying a checkout with the same key returns the first order rather
      // than creating a second one.
      db.exec(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          key        TEXT    NOT NULL,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          scope      TEXT    NOT NULL,
          order_id   INTEGER REFERENCES orders(id) ON DELETE CASCADE,
          created_at TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (key, user_id, scope)
        );
      `);

      addColumn(db, 'orders', 'payment_status', "TEXT NOT NULL DEFAULT 'pending'");
      addColumn(db, 'orders', 'payment_reference', 'TEXT');

      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          provider   TEXT    NOT NULL DEFAULT 'sandbox',
          reference  TEXT    NOT NULL,
          status     TEXT    NOT NULL,
          amount     INTEGER NOT NULL,
          raw        TEXT    NOT NULL DEFAULT '',
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_reference ON payment_events(reference);
      `);
    },
  },

  {
    name: '007-recommendation-events',
    up(db) {
      // Lightweight behavioural signal for the recommender. Deliberately stores
      // an item id and an action, never anything identifying beyond user_id.
      db.exec(`
        CREATE TABLE IF NOT EXISTS item_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
          item_id    INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
          action     TEXT    NOT NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_item_events_user ON item_events(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_item_events_item ON item_events(item_id, action);
      `);
    },
  },

  {
    name: '008-order-indexes',
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id DESC);
        CREATE INDEX IF NOT EXISTS idx_orders_placed ON orders(placed_at);
      `);
    },
  },
];

/**
 * Applies every migration that has not run yet.
 * @returns {string[]} names of the migrations applied during this call
 */
function migrate(db, { log = false } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  const ran = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;

    db.exec('BEGIN');
    try {
      migration.up(db);
      record.run(migration.name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.name} failed: ${err.message}`);
    }

    ran.push(migration.name);
    if (log) console.log(`  ↑ ${migration.name}`);
  }

  return ran;
}

module.exports = { migrate, MIGRATIONS, hasColumn, hasTable };

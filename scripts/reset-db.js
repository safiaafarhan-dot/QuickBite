'use strict';

/**
 * Drops every QuickBite table and rebuilds the schema from scratch.
 *
 *   npm run reset -- --yes        # drop, migrate, seed reference data
 *   npm run reset -- --yes --seed # and the demo accounts and history
 *
 * Under SQLite this was `rm -rf data/`. There is no file to delete now, so the
 * equivalent has to actually drop tables — which makes it far more dangerous
 * than the command it replaces. Hence the deliberate friction:
 *
 *   - `--yes` is required; without it this only prints what it would drop;
 *   - it refuses outright when NODE_ENV=production.
 *
 * This destroys orders, accounts and reviews. It is a development command.
 */

const { sql, initDb, closeDb, describeConnection, CONNECTION_HELP } = require('../server/db');

const confirmed = process.argv.includes('--yes');
const withSeed = process.argv.includes('--seed');

/* Dropped children-first, mirroring the order the schema creates them. */
const TABLES = [
  'item_events', 'payment_events', 'idempotency_keys', 'coupon_redemptions',
  'reviews', 'addresses', 'favorites', 'cart_items',
  'order_events', 'order_items', 'orders',
  'coupons', 'menu_items', 'users',
  'schema_migrations',
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(CONNECTION_HELP);
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production') {
    console.error('\n  ✗ Refusing to reset a production database.\n');
    console.error('    If you really mean to, unset NODE_ENV for this command — and take');
    console.error('    a backup first:  pg_dump "$DATABASE_URL" > backup.sql\n');
    process.exit(1);
  }

  console.log(`\n  Target: ${describeConnection()}`);

  if (!confirmed) {
    console.log('\n  This would DROP the following tables and all their data:\n');
    for (const table of TABLES) console.log(`    · ${table}`);
    console.log('\n  Nothing has been changed. Re-run with --yes to go ahead.\n');
    return;
  }

  console.log('\n  Dropping tables…');
  // One statement, so the foreign keys between them cannot block the order.
  await sql.exec(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);

  console.log('  Rebuilding schema…\n');
  await initDb({ log: true });

  const { n } = await sql.get('SELECT COUNT(*) AS n FROM menu_items');
  console.log(`\n  ✓ schema rebuilt, ${n} dishes loaded.`);

  if (withSeed) {
    console.log('  Seeding demo data…\n');
    // The seed script opens its own pool, so this one is closed first.
    await closeDb();
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, [require('node:path').join(__dirname, 'seed.js')], {
      stdio: 'inherit',
    });
  } else {
    console.log('    Run `npm run seed` for demo accounts and order history.\n');
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(`\n  ✗ ${err.message}\n`);
    await closeDb().catch(() => {});
    process.exit(1);
  });

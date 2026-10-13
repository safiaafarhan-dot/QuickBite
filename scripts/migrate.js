'use strict';

/**
 * Runs pending database migrations and reports the schema state.
 *
 *   npm run migrate              # apply anything outstanding
 *   npm run migrate -- --status  # report only, change nothing
 *
 * This is the command to run on deploy, before starting the server. It is safe
 * to run repeatedly: each migration is applied at most once, and a PostgreSQL
 * advisory lock keeps two instances deploying at the same time from racing.
 *
 * `--backup` is gone. Under SQLite it copied a file; a managed PostgreSQL has
 * no file to copy, and pretending otherwise would be worse than saying so.
 * Supabase takes its own daily backups, and `pg_dump "$DATABASE_URL"` is the
 * command for an on-demand one — see DEPLOYMENT.md.
 */

const { sql, initDb, closeDb, describeConnection, CONNECTION_HELP } = require('../server/db');
const { MIGRATIONS, hasTable } = require('../server/migrations');

const statusOnly = process.argv.includes('--status');

if (process.argv.includes('--backup')) {
  console.error('\n  ✗ --backup is not available for PostgreSQL.');
  console.error('    Take one with:  pg_dump "$DATABASE_URL" > quickbite-backup.sql\n');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(CONNECTION_HELP);
  process.exit(1);
}

/** Reports what has run without applying anything. */
async function status() {
  // Touch the pool without migrating, so a status run really is read-only.
  const applied = new Set();

  if (await hasTable(sql, 'schema_migrations')) {
    const rows = await sql.all('SELECT name FROM schema_migrations');
    for (const row of rows) applied.add(row.name);
  }

  console.log(`\nDatabase: ${describeConnection()}\n`);
  for (const migration of MIGRATIONS) {
    console.log(`  ${applied.has(migration.name) ? '✓' : '·'} ${migration.name}`);
  }

  const pending = MIGRATIONS.filter((m) => !applied.has(m.name)).length;
  console.log(`\n${pending === 0 ? 'Up to date.' : `${pending} migration(s) pending.`}\n`);
}

async function main() {
  if (statusOnly) return status();

  console.log(`\nMigrating ${describeConnection()}\n`);

  // `initDb` applies the migrations and then brings the menu and coupons in
  // line with the source files — the same work the server does on boot.
  await initDb({ log: true });

  const applied = await sql.all('SELECT name, applied_at FROM schema_migrations ORDER BY name');
  console.log(`\n✓ schema is at ${applied.length} migration(s); latest: ${applied.at(-1)?.name ?? 'none'}\n`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(`\n  ✗ ${err.message}`);
    if (err.help) console.error(err.help);
    await closeDb().catch(() => {});
    process.exit(1);
  });

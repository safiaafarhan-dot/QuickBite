'use strict';

/**
 * Runs pending database migrations and reports the schema state.
 *
 *   npm run migrate            # apply anything outstanding
 *   npm run migrate -- --status  # report only, change nothing
 *   npm run migrate -- --backup  # copy the database file first
 *
 * This is the command to run on deploy, before starting the server. It is safe
 * to run repeatedly: each migration is applied at most once.
 */

const fs = require('node:fs');
const path = require('node:path');

const statusOnly = process.argv.includes('--status');
const wantBackup = process.argv.includes('--backup');

// Importing the database module applies migrations as a side effect, so for a
// status-only run we open the file read-only first.
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, '..', 'data', 'quickbite.db');

function backup() {
  if (!fs.existsSync(DB_FILE)) {
    console.log('· no database file yet — nothing to back up');
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${DB_FILE}.${stamp}.bak`;
  fs.copyFileSync(DB_FILE, target);
  console.log(`✓ backup written to ${path.basename(target)}`);
  return target;
}

function status() {
  const { DatabaseSync } = require('node:sqlite');

  if (!fs.existsSync(DB_FILE)) {
    console.log(`No database at ${DB_FILE} — it will be created on first run.`);
    return;
  }

  const db = new DatabaseSync(DB_FILE);
  const { MIGRATIONS } = require('../server/migrations');

  const applied = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
      ? db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
      : []
  );

  console.log(`\nDatabase: ${DB_FILE}\n`);
  for (const migration of MIGRATIONS) {
    console.log(`  ${applied.has(migration.name) ? '✓' : '·'} ${migration.name}`);
  }

  const pending = MIGRATIONS.filter((m) => !applied.has(m.name)).length;
  console.log(`\n${pending === 0 ? 'Up to date.' : `${pending} migration(s) pending.`}\n`);

  db.close();
}

function main() {
  if (statusOnly) return status();

  if (wantBackup) backup();

  // Loading the module runs `migrate()` and logs each migration it applies.
  console.log(`\nMigrating ${DB_FILE}\n`);
  const { db } = require('../server/db');

  const applied = db.prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name').all();
  console.log(`\n✓ schema is at ${applied.length} migration(s); latest: ${applied.at(-1)?.name ?? 'none'}\n`);

  db.close();
}

main();

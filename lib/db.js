// provenance: polygram@0.17.10 lib/db.js (git dcceff6) — adapt: schema differs;
// user_version is derived from the max migration file number instead of a
// hand-bumped SCHEMA_VERSION constant (closes polygram's documented footgun where
// adding a migration without bumping the constant silently skipped it).

'use strict';

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// "007-add-foo.sql" -> 7. Files that don't start with digits are ignored.
function migrationNumber(filename) {
  const m = /^(\d+)/.exec(filename);
  return m ? parseInt(m[1], 10) : null;
}

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && migrationNumber(f) !== null)
    .map((f) => ({ file: f, num: migrationNumber(f), path: path.join(dir, f) }))
    .sort((a, b) => a.num - b.num);
}

// Apply every migration whose number exceeds the DB's current user_version, each in
// its own IMMEDIATE transaction with a re-read of user_version inside the txn (safe
// against a second process booting concurrently). Sets user_version to the file's
// number so the schema version always equals the highest applied migration.
function runMigrations(db, dir = MIGRATIONS_DIR) {
  const migrations = listMigrations(dir);
  for (const { num, path: file } of migrations) {
    const sql = fs.readFileSync(file, 'utf8');
    const applied = db.transaction(() => {
      const current = db.pragma('user_version', { simple: true });
      if (current >= num) return false;
      db.exec(sql);
      // user_version only takes a literal; num is our own integer, not user input.
      db.pragma(`user_version = ${num}`);
      return true;
    });
    // .immediate() issues BEGIN IMMEDIATE, taking the write lock up front: a second
    // process booting concurrently blocks on busy_timeout, then re-reads user_version
    // inside the txn and no-ops. Migration files must not contain journal_mode pragmas
    // (can't run in a txn) — those are set on the connection by openDb. A failure mid
    // migration rolls back and aborts boot loudly.
    applied.immediate();
  }
  return db.pragma('user_version', { simple: true });
}

// Open (or create) the account DB, apply pending migrations, return the handle.
// Fatal on failure — a daemon must never serve traffic against a half-migrated DB.
function openDb(dbPath, { migrationsDir = MIGRATIONS_DIR } = {}) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  return db;
}

module.exports = { openDb, runMigrations, listMigrations, migrationNumber, MIGRATIONS_DIR };

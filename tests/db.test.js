'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { openDb, listMigrations, migrationNumber, runMigrations } = require('../lib/db');

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-db-')), 'test.db');
}

test('migrationNumber parses the leading digits', () => {
  assert.equal(migrationNumber('001-init.sql'), 1);
  assert.equal(migrationNumber('042-add-thing.sql'), 42);
  assert.equal(migrationNumber('README.md'), null);
});

test('listMigrations returns files sorted by number', () => {
  const migs = listMigrations();
  assert.ok(migs.length >= 1);
  assert.equal(migs[0].file, '001-init.sql');
  for (let i = 1; i < migs.length; i++) {
    assert.ok(migs[i].num > migs[i - 1].num, 'migrations must be strictly increasing');
  }
});

test('openDb applies migrations and sets user_version to the max migration number', () => {
  const db = openDb(tmpDbPath());
  const maxNum = listMigrations().at(-1).num;
  assert.equal(db.pragma('user_version', { simple: true }), maxNum);
  db.close();
});

test('schema has every v1 table', () => {
  const db = openDb(tmpDbPath());
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = new Set(rows.map((r) => r.name));
  for (const t of [
    'messages', 'attachments', 'sessions', 'turn_metrics', 'jid_map', 'events',
    'daemon_state', 'pending_questions', 'pending_approvals', 'chat_tool_decisions',
    'secret_redactions', 'config_changes',
  ]) {
    assert.ok(names.has(t), `missing table ${t}`);
  }
  db.close();
});

test('messages UNIQUE(chat_jid, sender_jid, msg_id) rejects a duplicate', () => {
  const db = openDb(tmpDbPath());
  const ins = db.prepare(
    `INSERT INTO messages (chat_jid, msg_id, sender_jid, direction, account, ts, received_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  ins.run('g@g.us', 'ID1', 's@s.whatsapp.net', 'in', 'umi', 1, 1);
  assert.throws(
    () => ins.run('g@g.us', 'ID1', 's@s.whatsapp.net', 'in', 'umi', 2, 2),
    /UNIQUE/,
  );
  db.close();
});

test('FTS mirror is queryable and survives update', () => {
  const db = openDb(tmpDbPath());
  db.prepare(
    `INSERT INTO messages (chat_jid, msg_id, sender_jid, user, text, direction, account, ts, received_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run('g@g.us', 'ID1', 's', 'Alice', 'hello invoice world', 'in', 'umi', 1, 1);
  let hit = db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invoice'`).get();
  assert.ok(hit, 'FTS should find the inserted text');
  db.prepare(`UPDATE messages SET text = 'goodbye receipt' WHERE msg_id = 'ID1'`).run();
  hit = db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invoice'`).get();
  assert.equal(hit, undefined, 'stale FTS term must be gone after update');
  hit = db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'receipt'`).get();
  assert.ok(hit, 'new FTS term must be present after update');
  db.close();
});

test('runMigrations is idempotent (second run applies nothing)', () => {
  const p = tmpDbPath();
  const db = openDb(p);
  const v1 = db.pragma('user_version', { simple: true });
  const v2 = runMigrations(db);
  assert.equal(v1, v2);
  db.close();
});

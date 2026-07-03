'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('../lib/db');
const { createOutbound, mintMsgId } = require('../lib/db/outbound');

function db() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-out-')), 't.db');
  return openDb(p);
}
const rowById = (d, id) => d.prepare('SELECT * FROM messages WHERE id=?').get(id);

test('mintMsgId is whatsmeow-shaped and unique', () => {
  const a = mintMsgId();
  assert.match(a, /^3EB0[0-9A-F]{18}$/);
  assert.notEqual(a, mintMsgId());
});

test('reserve writes a pending out-row before the send and caches the id', () => {
  const d = db();
  const ob = createOutbound(d, { now: () => 1000 });
  const { rowId, msgId } = ob.reserve({ chatJid: 'g@g.us', text: 'hi', account: 'umi' });
  const row = rowById(d, rowId);
  assert.equal(row.status, 'pending');
  assert.equal(row.direction, 'out');
  assert.equal(row.is_from_me, 1);
  assert.equal(row.msg_id, msgId);
  assert.equal(ob.isOwnSend('g@g.us', msgId), true, 'sent-cache populated at mint time');
});

test('markSent CAS flips pending->sent with server ts', () => {
  const d = db();
  const ob = createOutbound(d, { now: () => 1000 });
  const { rowId } = ob.reserve({ chatJid: 'g@g.us', text: 'hi', account: 'umi' });
  assert.equal(ob.markSent(rowId, 2000), 'sent');
  const row = rowById(d, rowId);
  assert.equal(row.status, 'sent');
  assert.equal(row.ts, 2000);
});

test('markFailed CAS flips pending->failed with error', () => {
  const d = db();
  const ob = createOutbound(d);
  const { rowId } = ob.reserve({ chatJid: 'g@g.us', text: 'x', account: 'umi' });
  assert.equal(ob.markFailed(rowId, 'boom'), true);
  assert.equal(rowById(d, rowId).status, 'failed');
  assert.equal(rowById(d, rowId).error, 'boom');
});

test('ambiguous-send race: sweeper flips, then a late success reconciles failed->sent', () => {
  let clock = 0;
  const d = db();
  const ob = createOutbound(d, { now: () => clock });
  clock = 1000;
  const { rowId } = ob.reserve({ chatJid: 'g@g.us', text: 'slow', account: 'umi' });
  // 61s later, still pending -> sweeper marks ambiguous
  clock = 62_000;
  const swept = ob.sweepAmbiguous(60_000);
  assert.equal(swept.length, 1);
  assert.equal(rowById(d, rowId).error, 'ambiguous-send');
  // The 200 finally arrives: markSent must RECONCILE, not no-op.
  const outcome = ob.markSent(rowId, 63_000);
  assert.equal(outcome, 'reconciled');
  const row = rowById(d, rowId);
  assert.equal(row.status, 'sent');
  assert.equal(row.error, null);
});

test('markSent on a plain-failed (non-ambiguous) row does not resurrect it', () => {
  const d = db();
  const ob = createOutbound(d);
  const { rowId } = ob.reserve({ chatJid: 'g@g.us', text: 'x', account: 'umi' });
  ob.markFailed(rowId, 'permanent');
  assert.equal(ob.markSent(rowId, 5), 'noop');
  assert.equal(rowById(d, rowId).status, 'failed');
});

test('boot sweep flips crash-window pending rows to crashed-mid-send', () => {
  let clock = 1000;
  const d = db();
  const ob = createOutbound(d, { now: () => clock });
  ob.reserve({ chatJid: 'g@g.us', text: 'x', account: 'umi' });
  clock = 100_000;
  const rows = ob.sweepCrashed();
  assert.equal(rows.length, 1);
  assert.equal(d.prepare("SELECT error FROM messages WHERE direction='out'").get().error, 'crashed-mid-send');
});

test('boot sweep also catches a FRESH crash-window row (<60s old, reserved just before crash)', () => {
  // Regression: sweepCrashed must not age-filter — a row reserved seconds before the
  // crash would otherwise leak past boot and get mislabeled ambiguous-send 60s later.
  let clock = 1000;
  const d = db();
  const ob = createOutbound(d, { now: () => clock });
  ob.reserve({ chatJid: 'g@g.us', text: 'fresh', account: 'umi' });
  clock = 6000; // 5s after reserve — a fast crash+restart
  const rows = ob.sweepCrashed();
  assert.equal(rows.length, 1);
  assert.equal(d.prepare("SELECT error FROM messages WHERE direction='out'").get().error, 'crashed-mid-send');
});

test('caller-supplied msgId is honored (idempotent re-send guard upstream)', () => {
  const d = db();
  const ob = createOutbound(d);
  const { msgId } = ob.reserve({ chatJid: 'g@g.us', text: 'x', account: 'umi', msgId: '3EB0DEADBEEF00112233' });
  assert.equal(msgId, '3EB0DEADBEEF00112233');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('../lib/db');
const { createJidMap, bareJid, suffixKind } = require('../lib/db/jid-map');

function db() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-jid-')), 't.db');
  return openDb(p);
}

test('bareJid strips the device suffix', () => {
  assert.equal(bareJid('66821683034:3@s.whatsapp.net'), '66821683034@s.whatsapp.net');
  assert.equal(bareJid('123@lid'), '123@lid');
});

test('suffixKind classifies pn vs lid', () => {
  assert.equal(suffixKind('1@s.whatsapp.net'), 'pn');
  assert.equal(suffixKind('1@c.us'), 'pn');
  assert.equal(suffixKind('1@lid'), 'lid');
  assert.equal(suffixKind('1@g.us'), null);
});

test('observeSender records a pn<->lid pair and identitySet expands both ways', () => {
  const jm = createJidMap(db());
  jm.observeSender({
    jid: '555@lid',
    altJid: '66821683034@s.whatsapp.net',
    pushName: 'Alice',
    ts: 1000,
  });
  assert.deepEqual([...jm.identitySet('555@lid')].sort(),
    ['555@lid', '66821683034@s.whatsapp.net'].sort());
  assert.deepEqual([...jm.identitySet('66821683034@s.whatsapp.net')].sort(),
    ['555@lid', '66821683034@s.whatsapp.net'].sort());
});

test('a lid-only sender with no mapping resolves to just itself', () => {
  const jm = createJidMap(db());
  assert.deepEqual([...jm.identitySet('999@lid')], ['999@lid']);
});

test('matchesAny resolves an allowlist entry through the map (pn allowlist, lid sender)', () => {
  const jm = createJidMap(db());
  jm.seed({ pn: '66821683034@s.whatsapp.net', lid: '555@lid', ts: 1 });
  // Allowlist has the phone form; the message arrived lid-addressed.
  assert.equal(jm.matchesAny('555@lid', ['66821683034@s.whatsapp.net']), true);
  // A different sender does not match.
  assert.equal(jm.matchesAny('777@lid', ['66821683034@s.whatsapp.net']), false);
});

test('sameIdentity is device-suffix and form independent', () => {
  const jm = createJidMap(db());
  jm.seed({ pn: '66821683034@s.whatsapp.net', lid: '555@lid', ts: 1 });
  assert.equal(jm.sameIdentity('66821683034:3@s.whatsapp.net', '555@lid'), true);
  assert.equal(jm.sameIdentity('66821683034@s.whatsapp.net', '66821683034:9@s.whatsapp.net'), true);
});

test('observe with only one side is a no-op (nothing to map yet)', () => {
  const jm = createJidMap(db());
  jm.observe({ pn: '1@s.whatsapp.net', lid: null, ts: 1 });
  assert.deepEqual([...jm.identitySet('1@s.whatsapp.net')], ['1@s.whatsapp.net']);
});

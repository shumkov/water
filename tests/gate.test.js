'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('../lib/db');
const { createJidMap } = require('../lib/db/jid-map');
const { createGate } = require('../lib/handlers/gate');
const { isAbort } = require('../lib/handlers/abort-detector');

const BOT_PN = '66821683034@s.whatsapp.net';
const BOT_LID = '99999@lid';
const GROUP = '120363419377779909@g.us';

function harness(chatConfig, { adminJids = [], seedPairs = [], allowConfigCommands = false } = {}) {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-gate-')), 't.db'));
  const jidMap = createJidMap(db);
  jidMap.seed({ pn: BOT_PN, lid: BOT_LID, ts: 1 }); // bot's own pn<->lid
  for (const p of seedPairs) jidMap.seed({ ...p, ts: 1 });
  const botIdentity = new Set([jidMap.bareJid(BOT_PN), jidMap.bareJid(BOT_LID)]);
  const gate = createGate({
    resolveChat: (jid) => (jid === GROUP || jid.endsWith('@s.whatsapp.net') ? chatConfig : null),
    jidMap, botIdentity, adminJids, allowConfigCommands,
  });
  return { gate, jidMap };
}

function groupMsg(over = {}) {
  return {
    chatJid: GROUP, chatType: 'group', msgId: 'M', isFromMe: false,
    sender: { jid: '55@lid', pn: null, lid: '55@lid', pushName: 'X' },
    text: 'hello', mentions: [], attachments: [], ...over,
  };
}

test('abort-detector: sentence-level, not substring', () => {
  assert.equal(isAbort('stop'), true);
  assert.equal(isAbort('Stop. I will ask later'), true);
  assert.equal(isAbort('/stop'), true);
  assert.equal(isAbort('หยุด'), true);
  assert.equal(isAbort("please don't stop now"), false);
  assert.equal(isAbort('stopwatch'), false);
});

test('abort-detector does NOT fire on wait-intent (false-abort guard)', () => {
  // "wait, let me check" / "รอสักครู่" are not requests to kill the turn.
  assert.equal(isAbort('wait'), false);
  assert.equal(isAbort('wait, let me check with my team'), false);
  assert.equal(isAbort('รอสักครู่นะคะ'), false);
  assert.equal(isAbort('подожди секунду'), false);
});

test('unknown chat → ignore(unknown-chat)', () => {
  const { gate } = harness({ requireMention: true });
  const d = gate.decide({ ...groupMsg(), chatJid: 'other@g.us' });
  assert.deepEqual(d, { action: 'ignore', reason: 'unknown-chat', sessionKey: undefined });
});

test('isFromMe → ignore(is-from-me)', () => {
  const { gate } = harness({ requireMention: true });
  const d = gate.decide(groupMsg({ isFromMe: true }));
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'is-from-me');
});

test('group requireMention, no mention → ignore(unaddressed)', () => {
  const { gate } = harness({ requireMention: true });
  assert.equal(gate.decide(groupMsg()).action, 'ignore');
  assert.equal(gate.decide(groupMsg()).reason, 'unaddressed');
});

test('group @mention of the bot (via LID resolution) → dispatch', () => {
  const { gate } = harness({ requireMention: true });
  // message mentions the bot by its PN form; bot identity known via seed
  const d = gate.decide(groupMsg({ mentions: [BOT_PN] }));
  assert.equal(d.action, 'dispatch');
});

test('reply-to-bot satisfies mention → dispatch', () => {
  const { gate } = harness({ requireMention: true });
  const d = gate.decide(groupMsg({ quote: { msgId: 'B1', participantJid: BOT_LID } }));
  assert.equal(d.action, 'dispatch');
});

test('mentionPattern name-trigger → dispatch without @', () => {
  const { gate } = harness({ requireMention: true, mentionPatterns: ['\\bumi\\b'] });
  const d = gate.decide(groupMsg({ text: 'hey umi can you help' }));
  assert.equal(d.action, 'dispatch');
});

test('allowFrom: mention but non-listed sender → ignore(not-allowed)', () => {
  const seedPairs = [{ pn: '77@s.whatsapp.net', lid: '77@lid' }];
  const { gate } = harness({ requireMention: true, allowFrom: ['66@s.whatsapp.net'] }, { seedPairs });
  const d = gate.decide(groupMsg({ sender: { jid: '77@lid', lid: '77@lid', pn: null }, mentions: [BOT_PN] }));
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'not-allowed');
});

test('allowFrom: listed sender (lid resolves to allowed pn) + mention → dispatch', () => {
  const seedPairs = [{ pn: '66@s.whatsapp.net', lid: '66@lid' }];
  const { gate } = harness({ requireMention: true, allowFrom: ['66@s.whatsapp.net'] }, { seedPairs });
  const d = gate.decide(groupMsg({ sender: { jid: '66@lid', lid: '66@lid', pn: null }, mentions: [BOT_PN] }));
  assert.equal(d.action, 'dispatch');
});

test('allowFrom + unresolvable lid-only sender → ignore(unresolved-identity) [visible]', () => {
  const { gate } = harness({ requireMention: true, allowFrom: ['66@s.whatsapp.net'] });
  const d = gate.decide(groupMsg({ sender: { jid: 'nomap@lid', lid: 'nomap@lid', pn: null }, mentions: [BOT_PN] }));
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'unresolved-identity');
});

test('DM always dispatches (subject to allowlist)', () => {
  const { gate } = harness({ requireMention: true });
  const d = gate.decide({ ...groupMsg(), chatJid: 'x@s.whatsapp.net', chatType: 'dm' });
  assert.equal(d.action, 'dispatch');
});

test('DM allowFrom is enforced: a non-listed DM sender is ignored(not-allowed)', () => {
  const seedPairs = [{ pn: '77@s.whatsapp.net', lid: '77@lid' }];
  const { gate } = harness({ requireMention: true, allowFrom: ['66@s.whatsapp.net'] }, { seedPairs });
  const d = gate.decide({
    chatJid: 'x@s.whatsapp.net', chatType: 'dm', msgId: 'M', isFromMe: false,
    sender: { jid: '77@s.whatsapp.net', pn: '77@s.whatsapp.net', lid: null }, text: 'hi', mentions: [], attachments: [],
  });
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'not-allowed');
});

test('config command /model is gated by allowConfigCommands', () => {
  const admin = { jid: '66@s.whatsapp.net', pn: '66@s.whatsapp.net', lid: null };
  const dm = (over) => ({ chatJid: 'x@s.whatsapp.net', chatType: 'dm', msgId: 'M', isFromMe: false, sender: admin, text: '/model opus', mentions: [], attachments: [], ...over });
  // OFF (default): admin /model falls through to the agent (dispatch), NOT a command
  const off = harness({ requireMention: true }, { adminJids: ['66@s.whatsapp.net'] });
  assert.equal(off.gate.decide(dm()).action, 'dispatch');
  // ON: admin /model is intercepted as a config command
  const on = harness({ requireMention: true }, { adminJids: ['66@s.whatsapp.net'], allowConfigCommands: true });
  const d = on.gate.decide(dm());
  assert.equal(d.action, 'command');
  assert.equal(d.kind, 'config');
});

test('verdict command works even when allowConfigCommands is OFF (approval surface stays live)', () => {
  const { gate } = harness({ requireMention: true }, { adminJids: ['66@s.whatsapp.net'], allowConfigCommands: false });
  const d = gate.decide({ chatJid: 'x@s.whatsapp.net', chatType: 'dm', msgId: 'M', isFromMe: false, sender: { jid: '66@s.whatsapp.net', pn: '66@s.whatsapp.net', lid: null }, text: 'approve abc', mentions: [], attachments: [] });
  assert.equal(d.action, 'command');
  assert.equal(d.kind, 'verdict');
});

test('abort in a group by a non-admin non-initiator is ordinary chatter (falls through)', () => {
  const { gate } = harness({ requireMention: true });
  const d = gate.decide(groupMsg({ text: 'stop' }));
  assert.equal(d.action, 'ignore'); // unaddressed, not abort
});

test('abort by admin in a group → abort', () => {
  const { gate } = harness({ requireMention: true }, { adminJids: ['66@s.whatsapp.net'] });
  const d = gate.decide(groupMsg({ text: 'stop', sender: { jid: '66@s.whatsapp.net', pn: '66@s.whatsapp.net', lid: null } }));
  assert.equal(d.action, 'abort');
});

test('abort in a DM → abort (DM is self-authorizing)', () => {
  const { gate } = harness({ requireMention: true });
  const d = gate.decide({ ...groupMsg(), chatJid: 'x@s.whatsapp.net', chatType: 'dm', text: '/stop' });
  assert.equal(d.action, 'abort');
});

test('verdict command by admin → command(verdict)', () => {
  const { gate } = harness({ requireMention: true }, { adminJids: ['66@s.whatsapp.net'] });
  const d = gate.decide({ ...groupMsg(), chatType: 'dm', chatJid: 'x@s.whatsapp.net', text: 'approve abc123', sender: { jid: '66@s.whatsapp.net', pn: '66@s.whatsapp.net', lid: null } });
  assert.equal(d.action, 'command');
  assert.equal(d.kind, 'verdict');
  assert.equal(d.verb, 'approve');
  assert.equal(d.id, 'abc123');
});

test('verdict command by a non-admin is NOT a command (routes to agent)', () => {
  const { gate } = harness({ requireMention: true });
  const d = gate.decide(groupMsg({ text: 'approve abc123' }));
  assert.notEqual(d.action, 'command');
});

test('album sibling with media inherits acceptance → dispatch', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-gate2-')), 't.db'));
  const jidMap = createJidMap(db);
  jidMap.seed({ pn: BOT_PN, lid: BOT_LID, ts: 1 });
  const gate = createGate({
    resolveChat: () => ({ requireMention: true }),
    jidMap, botIdentity: new Set([BOT_PN, BOT_LID]), adminJids: [],
    isAlbumSiblingOf: () => true,
  });
  const d = gate.decide(groupMsg({ attachments: [{ kind: 'image' }] }));
  assert.equal(d.action, 'dispatch');
  assert.equal(d.reason, 'album-sibling');
});

test('open question consumes the next message from the asker', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-gate3-')), 't.db'));
  const jidMap = createJidMap(db);
  jidMap.seed({ pn: BOT_PN, lid: BOT_LID, ts: 1 });
  const gate = createGate({
    resolveChat: () => ({ requireMention: true }),
    jidMap, botIdentity: new Set([BOT_PN, BOT_LID]),
    hasOpenQuestionFor: (chat, sender) => sender === '55@lid',
  });
  const d = gate.decide(groupMsg({ text: '2' }));
  assert.equal(d.action, 'consume');
});

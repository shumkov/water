'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('../lib/db');
const { createOutbound } = require('../lib/db/outbound');
const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');
const { chunkMarkdownText } = require('../lib/delivery/chunk');
const { toWhatsApp } = require('../lib/delivery/format');

function harness({ failOn = null, now = () => 1000 } = {}) {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-del-')), 't.db'));
  const outbound = createOutbound(db, { now });
  const calls = { sendText: [], editText: [], react: [], sendMedia: [] };
  const transport = {
    async sendText(a) { calls.sendText.push(a); if (failOn === 'sendText') throw new Error('send boom'); return { msgId: a.id, ts: 2000 }; },
    async editText(a) { calls.editText.push(a); return { msgId: a.msgId }; },
    async react(a) { calls.react.push(a); },
    async sendMedia(a) { calls.sendMedia.push(a); return { msgId: a.id, ts: 2000 }; },
  };
  const td = createChannelsToolDispatcher({
    transport, outbound, account: 'umi', chunkText: chunkMarkdownText,
    formatText: toWhatsApp, maxChunkLen: 40, now,
  });
  return { td, calls, db, outbound };
}

test('format: markdown -> WhatsApp downgrade', () => {
  assert.equal(toWhatsApp('**bold**'), '*bold*');
  assert.equal(toWhatsApp('__bold__'), '*bold*');
  assert.equal(toWhatsApp('~~gone~~'), '~gone~');
  assert.equal(toWhatsApp('## Heading'), '*Heading*');
  assert.equal(toWhatsApp('see [docs](https://x.io/a)'), 'see docs (https://x.io/a)');
  assert.equal(toWhatsApp('```\n**not touched**\n```'), '```\n**not touched**\n```');
});

test('reply: sends chunks, quote only on the first, returns first msgId, write-before-send rows', async () => {
  const { td, calls, db } = harness();
  const longText = 'A'.repeat(35) + ' ' + 'B'.repeat(35); // > 40-char budget → 2 chunks
  const r = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'reply', text: longText, sourceMsgId: 'U1', participantJid: 'p@s.whatsapp.net' });
  assert.equal(r.ok, true);
  assert.ok(r.message_id, 'returns first bubble id');
  assert.equal(calls.sendText.length, 2, 'two chunks sent');
  assert.ok(calls.sendText[0].quote, 'first chunk quotes the user message');
  assert.equal(calls.sendText[1].quote, undefined, 'later chunks do not quote');
  // write-before-send: two out rows, both flipped to sent
  const rows = db.prepare("SELECT status FROM messages WHERE direction='out'").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === 'sent'));
});

test('reply(files): an image is sent with its real MIME (not octet-stream) so WuzAPI /chat/send/image accepts it', async () => {
  const { td, calls } = harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-media-'));
  const pngPath = path.join(dir, 'qr.png');
  // a real (tiny) 1x1 PNG
  fs.writeFileSync(pngPath, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex'));
  const r = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'reply', text: 'here', files: [pngPath], sessionCwd: dir });
  assert.equal(r.ok, true);
  assert.equal(calls.sendMedia.length, 1, 'one media send');
  const m = calls.sendMedia[0];
  assert.equal(m.kind, 'image');
  assert.equal(m.mimeType, 'image/png', 'must carry the real image MIME — octet-stream makes WuzAPI reject the image with HTTP 400');
  assert.ok(m.data.startsWith('data:image/png;base64,'), `data URL must carry the image MIME, got: ${m.data.slice(0, 40)}`);
});

test('reply(files): a document keeps document kind + a real MIME', async () => {
  const { td, calls } = harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-doc-'));
  const txtPath = path.join(dir, 'note.txt');
  fs.writeFileSync(txtPath, 'hello');
  const r = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'reply', text: 'file', files: [txtPath], sessionCwd: dir });
  assert.equal(r.ok, true);
  const m = calls.sendMedia[0];
  assert.equal(m.kind, 'document');
  assert.equal(m.mimeType, 'text/plain');
  assert.ok(m.data.startsWith('data:text/plain;base64,'));
});

test('reply: a send failure marks the row failed and returns ok:false', async () => {
  const { td, db } = harness({ failOn: 'sendText' });
  const r = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'reply', text: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(db.prepare("SELECT status FROM messages WHERE direction='out'").get().status, 'failed');
});

test('reply: a possibly-landed send (TIMEOUT) is marked ambiguous, not plain-failed (I4)', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-amb-')), 't.db'));
  const outbound = createOutbound(db, { now: () => 1000 });
  const transport = {
    async sendText() { const e = new Error('timed out'); e.code = 'TIMEOUT'; throw e; },
  };
  const td = createChannelsToolDispatcher({ transport, outbound, account: 'umi', chunkText: chunkMarkdownText, formatText: toWhatsApp });
  const r = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'reply', text: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(db.prepare("SELECT error FROM messages WHERE direction='out'").get().error, 'ambiguous-send');
});

test('edit_message: ownership gate blocks a non-owned message', async () => {
  const { td } = harness();
  const r = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'edit_message', messageId: 'NOTMINE', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not created by this session/);
});

test('edit_message: owned + within window succeeds; past 20-min window is NACKed', async () => {
  let clock = 1000;
  const { td, calls } = harness({ now: () => clock });
  // send a reply so the session owns a message id
  const sent = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'reply', text: 'orig' });
  const mid = sent.message_id;
  // edit within the window
  const ok = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'edit_message', messageId: mid, text: 'fixed' });
  assert.equal(ok.ok, true);
  assert.equal(calls.editText.length, 1);
  // 21 minutes later → NACK
  clock += 21 * 60 * 1000;
  const late = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'edit_message', messageId: mid, text: 'too late' });
  assert.equal(late.ok, false);
  assert.match(late.error, /too old to edit/);
});

test('react routes to transport.react (remove when text null)', async () => {
  const { td, calls } = harness();
  await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'react', messageId: 'M1', text: '👍' });
  assert.equal(calls.react[0].emoji, '👍');
  await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'react', messageId: 'M1', text: '' });
  assert.equal(calls.react[1].emoji, null);
});

test('unsupported tool → ok:false', async () => {
  const { td } = harness();
  const r = await td({ sessionKey: 'g@g.us', chatId: 'g@g.us', toolName: 'frobnicate', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unsupported tool/);
});

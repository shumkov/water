'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { normalize } = require('../lib/transport/normalize');
const { openDb } = require('../lib/db');
const { createRecordInbound } = require('../lib/handlers/record-inbound');

const FX = path.join(__dirname, 'fixtures', 'webhook');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8'));
function db() {
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-nrm-')), 't.db'));
}

test('group text w/ mention: chat/sender/lid/pn/mentions/text', () => {
  const r = normalize(fixture('group-text-mention.synthetic.json'));
  assert.equal(r.type, 'message');
  const m = r.message;
  assert.equal(m.chatJid, '120363419377779909@g.us');
  assert.equal(m.chatType, 'group');
  assert.equal(m.msgId, '3EB0AAA111');
  assert.equal(m.sender.lid, '555123@lid');
  assert.equal(m.sender.pn, '66891112222@s.whatsapp.net');
  assert.equal(m.sender.pushName, 'Alice');
  assert.deepEqual(m.mentions, ['66821683034@s.whatsapp.net']);
  assert.match(m.text, /please check the order/);
  assert.equal(m.tsMs, Date.parse('2026-07-03T12:00:00Z'));
});

test('reply-to-bot: quote stanza + participant + bare numbered answer text', () => {
  const r = normalize(fixture('group-reply-to-bot.synthetic.json'));
  const m = r.message;
  assert.equal(m.text, '2');
  assert.equal(m.quote.msgId, '3EB0BOTMSG');
  assert.equal(m.quote.participantJid, '66821683034@s.whatsapp.net');
});

test('dm image: attachment + mediaRef with all 7 download fields', () => {
  const r = normalize(fixture('dm-image.synthetic.json'));
  const m = r.message;
  assert.equal(m.chatType, 'dm');
  assert.equal(m.text, 'here is the product'); // caption folds into text
  assert.equal(m.attachments.length, 1);
  const a = m.attachments[0];
  assert.equal(a.kind, 'image');
  assert.equal(a.mimeType, 'image/jpeg');
  assert.equal(a.sizeBytes, 45210);
  for (const k of ['Url', 'DirectPath', 'MediaKey', 'Mimetype', 'FileEncSHA256', 'FileSHA256', 'FileLength']) {
    assert.ok(k in a.mediaRef, `mediaRef missing ${k}`);
  }
  assert.equal(a.mediaRef.FileLength, 45210);
});

test('own echo: isFromMe true', () => {
  const r = normalize(fixture('own-echo.synthetic.json'));
  assert.equal(r.message.isFromMe, true);
});

test('reaction event normalizes to a reaction, not a message', () => {
  const r = normalize(fixture('reaction.synthetic.json'));
  assert.equal(r.type, 'reaction');
  assert.equal(r.targetMsgId, '3EB0BOTMSG');
  assert.equal(r.emoji, '👍');
});

test('connection event normalizes to {type:connection, kind}', () => {
  const r = normalize(fixture('connection-disconnected.synthetic.json'));
  assert.equal(r.type, 'connection');
  assert.equal(r.kind, 'disconnected');
});

test('revoke protocolMessage normalizes to a revoke', () => {
  const raw = {
    type: 'Message',
    event: {
      Info: { Chat: 'g@g.us', Sender: 's@s.whatsapp.net', IsGroup: true, ID: 'X', Timestamp: '2026-07-03T00:00:00Z' },
      Message: { protocolMessage: { type: 'REVOKE', key: { ID: '3EB0GONE' } } },
    },
  };
  const r = normalize(raw);
  assert.equal(r.type, 'revoke');
  assert.equal(r.targetMsgId, '3EB0GONE');
});

test('MESSAGE_EDIT protocolMessage: edit.targetMsgId + edited text folds in', () => {
  const raw = {
    type: 'Message',
    event: {
      Info: { Chat: 'g@g.us', Sender: 's@s.whatsapp.net', IsGroup: true, ID: 'E1', Timestamp: '2026-07-03T00:00:00Z' },
      Message: {
        protocolMessage: {
          type: 'MESSAGE_EDIT',
          key: { ID: '3EB0ORIG' },
          editedMessage: { conversation: 'corrected price is 500' },
        },
      },
    },
  };
  const r = normalize(raw);
  assert.equal(r.type, 'message');
  assert.equal(r.message.edit.targetMsgId, '3EB0ORIG');
  assert.equal(r.message.text, 'corrected price is 500');
});

test('editedMessage without explicit type still detected as an edit', () => {
  const raw = {
    type: 'Message',
    event: {
      Info: { Chat: 'g@g.us', Sender: 's@s.whatsapp.net', IsGroup: true, ID: 'E2', Timestamp: '2026-07-03T00:00:00Z' },
      Message: { protocolMessage: { key: { ID: '3EB0ORIG2' }, editedMessage: { extendedTextMessage: { text: 'fixed' } } } },
    },
  };
  const r = normalize(raw);
  assert.equal(r.message.edit.targetMsgId, '3EB0ORIG2');
  assert.equal(r.message.text, 'fixed');
});

test('casing-defensive: PascalCase media fields also parse', () => {
  const raw = {
    type: 'Message',
    event: {
      Info: { Chat: 'g@g.us', Sender: 's@s.whatsapp.net', IsGroup: true, ID: 'Y', Timestamp: '2026-07-03T00:00:00Z' },
      Message: { documentMessage: { FileName: 'a.pdf', Mimetype: 'application/pdf', FileLength: 10, URL: 'u', DirectPath: 'd', MediaKey: 'k', FileEncSHA256: 'e', FileSHA256: 'f' } },
    },
  };
  const a = normalize(raw).message.attachments[0];
  assert.equal(a.kind, 'document');
  assert.equal(a.fileName, 'a.pdf');
  assert.equal(a.mediaRef.FileLength, 10);
});

test('recordInbound persists message + attachments and dedups on retry', () => {
  const d = db();
  const rec = createRecordInbound(d);
  const r = normalize(fixture('dm-image.synthetic.json'));
  const first = rec(r.message, { account: 'umi' });
  assert.equal(first.deduped, false);
  assert.ok(first.rowId);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM attachments WHERE message_id=?').get(first.rowId).c, 1);

  const second = rec(r.message, { account: 'umi' }); // wuzapi retry: same (chat,sender,id)
  assert.equal(second.deduped, true);
  assert.equal(second.rowId, first.rowId);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM messages').get().c, 1, 'no duplicate row');
  assert.equal(d.prepare('SELECT COUNT(*) c FROM attachments').get().c, 1, 'no duplicate attachment');
});

test('every synthetic Message fixture yields a msgId, chatJid and terminal type', () => {
  for (const f of fs.readdirSync(FX).filter((x) => x.endsWith('.synthetic.json'))) {
    const r = normalize(fixture(f));
    assert.ok(r.type, `${f}: no type`);
    if (r.type === 'message') {
      assert.ok(r.message.msgId, `${f}: missing msgId`);
      assert.ok(r.message.chatJid, `${f}: missing chatJid`);
    }
  }
});

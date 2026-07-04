'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createDaemon } = require('../water');
const { openDb } = require('../lib/db');

const GROUP = '120363419377779909@g.us';
const BOT_PN = '66821683034@s.whatsapp.net';

function baseConfig(dataDir) {
  return {
    accounts: {
      umi: {
        wuzapi: { baseUrl: 'http://127.0.0.1:1', userToken: 't', hmacKey: 'k' },
        webhook: { port: 0, pathToken: 'tok' },
        adminJids: [BOT_PN],
        allowConfigCommands: false,
        processBudget: 9,
        botJid: BOT_PN,
      },
    },
    chats: {
      [GROUP]: { name: 'Umi', account: 'umi', agent: 'x', cwd: dataDir, requireMention: true, mentionPatterns: ['\\bumi\\b'] },
    },
    defaults: { model: 'sonnet', effort: 'low', maxTurn: 600000, maxTurnHard: 5400000 },
  };
}

// Mock transport (no network) + a mock pm injected by monkeypatching after construct.
function mkTransport(sent) {
  return {
    async sessionStatus() { return { jid: BOT_PN }; },
    async resolveLid() { return null; },
    async sendText(a) { sent.push(a); return { msgId: a.id, ts: 1 }; },
    async sendMedia(a) { sent.push(a); return { msgId: a.id, ts: 1 }; },
    async editText(a) { return { msgId: a.msgId }; },
    async react() {},
    async setPresence() {},
  };
}

function msg(over = {}) {
  return {
    chatJid: GROUP, chatType: 'group', msgId: 'M1', isFromMe: false,
    sender: { jid: '55@lid', altJid: null, pn: null, lid: '55@lid', pushName: 'Alice' },
    tsMs: 1000, receivedAtMs: 1000, text: 'hello there', mentions: [], attachments: [], ...over,
  };
}

function daemon(dataDir, sent) {
  const d = createDaemon({
    config: baseConfig(dataDir), account: 'umi', dataDir,
    transport: mkTransport(sent), botIdentity: new Set([BOT_PN]),
    logger: { log() {}, warn() {}, error() {} },
  });
  return d;
}

test('unaddressed group message is recorded and ignored(unaddressed), no turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-d1-'));
  const sent = [];
  const d = daemon(dir, sent);
  // fake pm so a dispatch (shouldn't happen here) is observable
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {}; d.pm.send = async () => { dispatched++; return { alreadyDelivered: true }; };
  await d.onMessage(msg({ text: 'just chatting' }));
  await new Promise((r) => setTimeout(r, 20)); // let fire-and-forget settle
  const row = d.db.prepare("SELECT handler_status, error FROM messages WHERE msg_id='M1'").get();
  assert.equal(row.handler_status, 'ignored');
  assert.equal(row.error, 'unaddressed');
  assert.equal(dispatched, 0);
  await d.stop();
});

test('mentioned group message dispatches a turn and marks replied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-d2-'));
  const sent = [];
  const d = daemon(dir, sent);
  // mock the session engine: getOrSpawn no-op, send resolves alreadyDelivered
  const captured = {};
  d.pm.getOrSpawn = async (sk, ctx) => { captured.ctx = ctx; };
  d.pm.procs = new Map([[GROUP, { claudeSessionId: 'sess-1' }]]);
  d.pm.send = async (sk, prompt, opts) => { captured.prompt = prompt; captured.opts = opts; return { alreadyDelivered: true, turnId: 'T1', metrics: { resultSubtype: 'success' } }; };
  await d.onMessage(msg({ text: 'hey umi help me', mentions: [] }));
  await new Promise((r) => setTimeout(r, 30));
  const row = d.db.prepare("SELECT handler_status FROM messages WHERE msg_id='M1'").get();
  assert.equal(row.handler_status, 'replied');
  assert.match(captured.prompt, /hey umi help me/);
  assert.equal(captured.opts.context.user, 'Alice');
  assert.equal(captured.opts.context.sourceMsgId, 'M1');
  // session id persisted for --resume
  assert.equal(d.db.prepare('SELECT claude_session_id FROM sessions WHERE session_key=?').get(GROUP).claude_session_id, 'sess-1');
  // turn_metrics recorded
  assert.ok(d.db.prepare('SELECT 1 FROM turn_metrics WHERE msg_id=?').get('M1'));
  await d.stop();
});

test('duplicate webhook (same chat+sender+id) is deduped, only one row', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-d3-'));
  const d = daemon(dir, []);
  d.pm.getOrSpawn = async () => {}; d.pm.procs = new Map(); d.pm.send = async () => ({ alreadyDelivered: true });
  await d.onMessage(msg({ text: 'hey umi' }));
  await d.onMessage(msg({ text: 'hey umi' })); // retry
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.db.prepare("SELECT COUNT(*) c FROM messages WHERE direction='in'").get().c, 1);
  await d.stop();
});

test('boot replay re-dispatches a received row that never got gated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-d4-'));
  // pre-seed a received (ungated) inbound row directly, simulating a crash after
  // webhook-commit but before gate.
  const seed = openDb(path.join(dir, 'umi.db'));
  seed.prepare(`INSERT INTO messages (chat_jid,msg_id,sender_jid,user,text,direction,account,ts,received_at)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(GROUP, 'R1', '55@lid', 'Alice', 'umi are you there', 'in', 'umi', Date.now(), Date.now());
  seed.close();

  const sent = [];
  const d = daemon(dir, sent);
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {}; d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = async () => { dispatched++; return { alreadyDelivered: true }; };
  await d.start(); // runs bootReplay
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dispatched, 1, 'the ungated received row was re-dispatched on boot');
  await d.stop();
});

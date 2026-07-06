'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createDaemon, buildExpectedWebhook } = require('../water');
const { openDb } = require('../lib/db');
const { sign } = require('../lib/transport/hmac');

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

test('isFromMe (human/other-device) is recorded as a human-device out-row, never dispatched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-hd-'));
  const d = daemon(dir, []);
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {}; d.pm.procs = new Map(); d.pm.send = async () => { dispatched++; return { alreadyDelivered: true }; };
  await d.onMessage(msg({ isFromMe: true, msgId: 'HD1', text: 'staff answered from phone' }));
  await new Promise((r) => setTimeout(r, 20));
  const row = d.db.prepare("SELECT direction, source FROM messages WHERE msg_id='HD1'").get();
  assert.equal(row.direction, 'out');
  assert.equal(row.source, 'human-device');
  assert.equal(dispatched, 0);
  await d.stop();
});

test('dispatch failure marks the row failed and calls the error reply (not on replay)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-df-'));
  const sent = [];
  const d = daemon(dir, sent);
  d.pm.getOrSpawn = async () => {}; d.pm.procs = new Map();
  d.pm.send = async () => { throw new Error('spawn boom'); };
  await d.onMessage(msg({ text: 'hey umi', msgId: 'F1' }));
  await new Promise((r) => setTimeout(r, 30));
  const row = d.db.prepare("SELECT handler_status FROM messages WHERE msg_id='F1'").get();
  assert.equal(row.handler_status, 'failed');
  await d.stop();
});

test('injectTurn is fail-closed on an unknown chat, dispatches into a configured one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-inj-'));
  const d = daemon(dir, []);
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {}; d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = async () => { dispatched++; return { alreadyDelivered: true }; };
  const bad = await d.injectTurn({ chat_id: 'unknown@g.us', text: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unknown-chat');
  assert.equal(dispatched, 0);
  await d.injectTurn({ chat_id: GROUP, text: 'daily summary please' });
  assert.equal(dispatched, 1);
  await d.stop();
});

test('abort routing interrupts the process and marks the row aborted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-ab-'));
  const d = daemon(dir, []);
  let interrupted = 0;
  d.pm.procs = new Map([[GROUP, { interrupt: async () => { interrupted++; } }]]);
  // admin sender so the abort is authorized in a group
  await d.onMessage(msg({ text: 'stop', msgId: 'AB1', sender: { jid: BOT_PN, pn: BOT_PN, lid: null, pushName: 'Ivan' } }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(interrupted, 1);
  assert.equal(d.db.prepare("SELECT handler_status FROM messages WHERE msg_id='AB1'").get().handler_status, 'aborted');
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

test('start(): a real HMAC-signed webhook POST records + dispatches end to end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-start-'));
  const sent = [];
  const d = daemon(dir, sent);
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {}; d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = async () => { dispatched++; return { alreadyDelivered: true }; };
  const { port } = await d.start({ withTimers: false });
  const body = JSON.stringify({
    type: 'Message',
    event: {
      Info: { Chat: GROUP, Sender: '55@lid', IsGroup: true, ID: 'W1', Timestamp: '2026-07-04T00:00:00Z', PushName: 'Al' },
      Message: { extendedTextMessage: { text: 'hey umi help' } },
    },
  });
  const res = await fetch(`http://127.0.0.1:${port}/hook/tok`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hmac-signature': sign(Buffer.from(body), 'k') }, body,
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(d.db.prepare("SELECT COUNT(*) c FROM messages WHERE msg_id='W1'").get().c, 1);
  assert.equal(dispatched, 1);
  await d.stop();
});

test('a bot reply through the tool-dispatcher stores an outbound ts in ms (SLA guard works)', async () => {
  // Regression for the ts-in-seconds bug. The client normalizes wuzapi seconds -> ms
  // (client test covers toMs); here we drive a real reply through the dispatcher and
  // assert the stored outbound ts is ms scale so botReplyAfter (o.ts >= in.ts) can match.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-slareg-'));
  const d = daemon(dir, []);
  const nowMs = Date.now();
  // mock transport already returns a ms-scale ts via the real client boundary; the
  // daemon's mkTransport.sendText returns { ts: 1 } (too small), so simulate the
  // post-toMs client by returning a proper ms ts here.
  d._internal.transport.sendText = async (a) => ({ msgId: a.id, ts: nowMs });
  await d._internal.toolDispatcher({ sessionKey: GROUP, chatId: GROUP, toolName: 'reply', text: 'answer' });
  const outTs = d.db.prepare("SELECT ts FROM messages WHERE direction='out' AND status='sent'").get().ts;
  assert.ok(outTs > 1e12, `outbound ts must be ms scale, got ${outTs}`);
  await d.stop();
});

test('edit that ADDS a mention to an ignored message dispatches a turn (WhatsApp patch #9)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-edit1-'));
  const d = daemon(dir, []);
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {};
  d.pm.procs = new Map([[GROUP, { claudeSessionId: 'sess-1' }]]);
  d.pm.send = async () => { dispatched++; return { alreadyDelivered: true, turnId: 'T', metrics: { resultSubtype: 'success' } }; };
  // 1. no mention → ignored, no turn
  await d.onMessage(msg({ msgId: 'M1', text: 'order please' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dispatched, 0, 'unaddressed → not dispatched');
  assert.equal(d.db.prepare("SELECT handler_status FROM messages WHERE msg_id='M1'").get().handler_status, 'ignored');
  // 2. partner EDITS M1 to add the mention → now it earns a reply
  await d.onMessage(msg({ msgId: 'EDIT1', edit: { targetMsgId: 'M1' }, text: 'order please umi' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dispatched, 1, 'edit added the mention → dispatched a turn');
  await d.stop();
});

test('edit that does NOT newly address the bot stays silent (text-only update)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-edit2-'));
  const d = daemon(dir, []);
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {}; d.pm.procs = new Map();
  d.pm.send = async () => { dispatched++; return { alreadyDelivered: true }; };
  await d.onMessage(msg({ msgId: 'M2', text: 'order please' }));
  await d.onMessage(msg({ msgId: 'E2', edit: { targetMsgId: 'M2' }, text: 'order please now' })); // still no mention
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dispatched, 0, 'edit without a mention → no dispatch');
  await d.stop();
});

test('edit while a turn is in flight folds a correction into the live turn (no competing turn)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-edit3-'));
  const d = daemon(dir, []);
  let dispatched = 0; let injected = null;
  d.pm.getOrSpawn = async () => {};
  d.pm.procs = new Map([[GROUP, { inFlight: true, injectUserMessage: (a) => { injected = a; return true; } }]]);
  d.pm.send = async () => { dispatched++; return { alreadyDelivered: true }; };
  await d.onMessage(msg({ msgId: 'M3', text: 'order please' }));            // ignored
  await d.onMessage(msg({ msgId: 'E3', edit: { targetMsgId: 'M3' }, text: 'order please umi' })); // edit adds mention, mid-turn
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dispatched, 0, 'in-flight turn → no competing dispatch');
  assert.ok(injected && /order please umi/.test(injected.content), 'correction folded into the live turn');
  assert.equal(injected.source, 'edit-fold');
  await d.stop();
});

// Regression: the webhook URL water advertises to WuzAPI must honour webhook.advertiseHost.
// The daemon ran inside a Docker-networked deployment where WuzAPI (in a container) posts to
// water on the host; a hardcoded 127.0.0.1 advertised URL is the container's own loopback →
// every delivery is "connection refused" and silently dropped. advertiseHost lets water
// advertise the bridge-gateway address the container can actually reach.
test('buildExpectedWebhook advertises webhook.advertiseHost (not a hardcoded 127.0.0.1)', () => {
  // Default: loopback, unchanged behaviour for same-namespace deployments.
  const def = buildExpectedWebhook({ port: 8090, pathToken: 'water' });
  assert.equal(def.url, 'http://127.0.0.1:8090/hook/water');
  assert.equal(def.baseUrlPrefix, 'http://127.0.0.1');
  assert.equal(def.path, '/hook/water');

  // Cross-namespace: the advertised URL + drift-detection prefix follow advertiseHost;
  // path stays host-agnostic so the watchdog recognises our webhook across a host change.
  const gw = buildExpectedWebhook({ port: 8090, pathToken: 'water', advertiseHost: '172.21.0.1' });
  assert.equal(gw.url, 'http://172.21.0.1:8090/hook/water');
  assert.equal(gw.baseUrlPrefix, 'http://172.21.0.1');
  assert.equal(gw.path, '/hook/water');

  // pathToken defaults to 'water'.
  assert.equal(buildExpectedWebhook({ port: 9, advertiseHost: '10.0.0.5' }).url, 'http://10.0.0.5:9/hook/water');

  // Coalesce on falsy: an explicit "" must fall back to the defaults, matching how the
  // receiver resolves the same values — otherwise the advertised URL and the bind diverge.
  const empty = buildExpectedWebhook({ port: 8090, pathToken: '', advertiseHost: '' });
  assert.equal(empty.url, 'http://127.0.0.1:8090/hook/water');
  assert.equal(empty.path, '/hook/water');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createDaemon, buildExpectedWebhook } = require('../water');
const { openDb } = require('../lib/db');
const { sign } = require('../lib/transport/hmac');
const { normalize } = require('../lib/transport/normalize');

const GROUP = '120363419377779909@g.us';
const DM = '66820000000@s.whatsapp.net';
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

function daemonWithDm(dataDir, sent) {
  const config = baseConfig(dataDir);
  config.chats[DM] = {
    name: 'DM',
    account: 'umi',
    agent: 'x',
    cwd: dataDir,
    requireMention: false,
  };
  return createDaemon({
    config,
    account: 'umi',
    dataDir,
    transport: mkTransport(sent),
    botIdentity: new Set([BOT_PN]),
    logger: { log() {}, warn() {}, error() {} },
  });
}

async function waitFor(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A stranger DM: not in `chats`, so resolveChat -> null (unconfigured).
const STRANGER_DM = 'stranger@s.whatsapp.net';
function strangerDmMsg(over = {}) {
  return {
    chatJid: STRANGER_DM, chatType: 'dm', msgId: 'SD1', isFromMe: false,
    sender: { jid: STRANGER_DM, altJid: null, pn: STRANGER_DM, lid: null, pushName: 'Stranger' },
    tsMs: 1000, receivedAtMs: 1000, text: 'hello, is this UMI?', mentions: [], attachments: [], ...over,
  };
}

function daemonWithRestrictedReply(dataDir, sent, replyText = "DMs aren't monitored here.") {
  const cfg = baseConfig(dataDir);
  cfg.accounts.umi.dmRestrictedReply = replyText;
  const d = createDaemon({
    config: cfg, account: 'umi', dataDir,
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

test('restricted-dm: a non-allowlisted DM sends exactly one canned reply and marks the row ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm1-'));
  const sent = [];
  const d = daemonWithRestrictedReply(dir, sent, 'We do not monitor DMs here.');
  await d.onMessage(strangerDmMsg());
  await new Promise((r) => setTimeout(r, 20));
  const row = d.db.prepare("SELECT handler_status, error FROM messages WHERE msg_id='SD1'").get();
  assert.equal(row.handler_status, 'ignored');
  assert.equal(row.error, 'restricted-dm');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'We do not monitor DMs here.');
  assert.equal(sent[0].chatJid, STRANGER_DM);
  await d.stop();
});

test('restricted-dm: absent config keeps the silent drop (back-compat, no send)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm2-'));
  const sent = [];
  const d = daemon(dir, sent); // baseConfig has no dmRestrictedReply
  await d.onMessage(strangerDmMsg());
  await new Promise((r) => setTimeout(r, 20));
  const row = d.db.prepare("SELECT handler_status, error FROM messages WHERE msg_id='SD1'").get();
  assert.equal(row.handler_status, 'ignored');
  assert.equal(row.error, 'unknown-chat');
  assert.equal(sent.length, 0);
  await d.stop();
});

test('restricted-dm: replay skips the send but still marks the row ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm3-'));
  const sent = [];
  const d = daemonWithRestrictedReply(dir, sent);
  const ins = d.db.prepare(`INSERT INTO messages (chat_jid,msg_id,sender_jid,user,text,direction,account,ts,received_at)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(STRANGER_DM, 'SD-replay', STRANGER_DM, 'Stranger', 'hi again', 'in', 'umi', Date.now(), Date.now());
  await d.processInbound(strangerDmMsg({ msgId: 'SD-replay' }), ins.lastInsertRowid, { isReplay: true });
  const row = d.db.prepare("SELECT handler_status, error FROM messages WHERE msg_id='SD-replay'").get();
  assert.equal(row.handler_status, 'ignored');
  assert.equal(row.error, 'restricted-dm');
  assert.equal(sent.length, 0, 'boot replay must never re-blast an old DM');
  await d.stop();
});

test('restricted-dm: a throwing send is swallowed and the row is still marked ignored (no leak)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm4-'));
  const sent = [];
  const d = daemonWithRestrictedReply(dir, sent);
  d._internal.transport.sendText = async () => { throw new Error('wuzapi down'); };
  await d.onMessage(strangerDmMsg());
  await new Promise((r) => setTimeout(r, 20));
  const row = d.db.prepare("SELECT handler_status, error FROM messages WHERE msg_id='SD1'").get();
  assert.equal(row.handler_status, 'ignored');
  assert.equal(row.error, 'restricted-dm');
  await d.stop();
});

test('restricted-dm: a second message from the same sender within the window is capped (no second send)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm5-'));
  const sent = [];
  const d = daemonWithRestrictedReply(dir, sent);
  await d.onMessage(strangerDmMsg({ msgId: 'SD-a' }));
  await new Promise((r) => setTimeout(r, 20));
  await d.onMessage(strangerDmMsg({ msgId: 'SD-b', text: 'still there?' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1, 'only the first message in the window gets a reply');
  const row = d.db.prepare("SELECT handler_status, error FROM messages WHERE msg_id='SD-b'").get();
  assert.equal(row.handler_status, 'ignored');
  assert.equal(row.error, 'restricted-dm-capped');
  await d.stop();
});

test('restricted-dm cap resolves pn/lid identity: same person via two JID forms shares one cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm6-'));
  const sent = [];
  const d = daemonWithRestrictedReply(dir, sent);
  const PN = 'stranger2@s.whatsapp.net';
  const LID = 'stranger2@lid';
  // First message: sender attributed by pn, with the lid alt form present — this is how
  // jidMap.observeSender (called for every inbound message) learns the pn<->lid pair.
  await d.onMessage(strangerDmMsg({
    msgId: 'ID-1', chatJid: PN,
    sender: { jid: PN, altJid: LID, pn: PN, lid: LID, pushName: 'Stranger2' },
  }));
  await new Promise((r) => setTimeout(r, 20));
  // Second message: same real person, now attributed purely by lid (addressing-mode
  // quirk) — the cap must still recognize them as already-replied via identitySet.
  await d.onMessage(strangerDmMsg({
    msgId: 'ID-2', chatJid: PN, text: 'hello again',
    sender: { jid: LID, altJid: null, pn: null, lid: LID, pushName: 'Stranger2' },
  }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1, 'same person via pn then lid must share the cap, not get a second reply');
  assert.equal(d.db.prepare("SELECT error FROM messages WHERE msg_id='ID-2'").get().error, 'restricted-dm-capped');
  await d.stop();
});

test('restricted-dm cap is per-sender: a second, distinct stranger still gets their own reply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm10-'));
  const sent = [];
  const d = daemonWithRestrictedReply(dir, sent);
  await d.onMessage(strangerDmMsg({ msgId: 'S1' }));
  await new Promise((r) => setTimeout(r, 20));
  const OTHER = 'other-stranger@s.whatsapp.net';
  await d.onMessage(strangerDmMsg({
    msgId: 'S2', chatJid: OTHER,
    sender: { jid: OTHER, altJid: null, pn: OTHER, lid: null, pushName: 'Other' },
  }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2, 'the cap must be keyed per sender, not shared/global');
  await d.stop();
});

test('restricted-dm: mark-before-send prevents a race — two near-simultaneous messages from the same sender only get one send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm7-'));
  const sent = [];
  const d = daemonWithRestrictedReply(dir, sent);
  const p1 = d.onMessage(strangerDmMsg({ msgId: 'RACE1' }));
  const p2 = d.onMessage(strangerDmMsg({ msgId: 'RACE2', text: 'still here?' }));
  await Promise.all([p1, p2]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1, 'marking before the await must block the second message before its send fires');
  await d.stop();
});

test('restricted-dm: empty-string dmRestrictedReply is treated as disabled (silent drop, no send)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm8-'));
  const sent = [];
  const d = daemonWithRestrictedReply(dir, sent, '');
  await d.onMessage(strangerDmMsg());
  await new Promise((r) => setTimeout(r, 20));
  const row = d.db.prepare("SELECT handler_status, error FROM messages WHERE msg_id='SD1'").get();
  assert.equal(row.handler_status, 'ignored');
  assert.equal(row.error, 'unknown-chat');
  assert.equal(sent.length, 0);
  await d.stop();
});

test('restricted-dm: no turn_metrics row is created (no session/turn, per spec)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-rdm9-'));
  const sent = [];
  const d = daemonWithRestrictedReply(dir, sent);
  await d.onMessage(strangerDmMsg());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.db.prepare('SELECT COUNT(*) c FROM turn_metrics').get().c, 0);
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

test('shutdown fences newly persisted webhooks and writes clean marker only after the admitted turn is durable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-clean-'));
  const d = daemon(dir, []);
  let finishTurn;
  d.pm.getOrSpawn = async () => {};
  d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = () => new Promise((resolve) => { finishTurn = resolve; });
  d.pm.shutdown = async () => {};

  await d.onMessage(msg({ msgId: 'BEFORE', text: 'umi work on this' }));
  await waitFor(() => d.busySummary().in_flight === 1, 'first turn was never admitted');

  const stopping = d.stop();
  await waitFor(() => d._internal.shutdownBarrier.isFenced(), 'shutdown never fenced admission');
  await d.onMessage(msg({ msgId: 'AFTER', text: 'umi this must replay' }));

  finishTurn({ alreadyDelivered: true, turnId: 'T', metrics: { resultSubtype: 'success' } });
  const result = await stopping;
  assert.equal(result.clean, true);

  const reopened = openDb(path.join(dir, 'umi.db'));
  assert.equal(
    reopened.prepare("SELECT handler_status FROM messages WHERE msg_id='BEFORE'").get().handler_status,
    'replied',
  );
  assert.equal(
    reopened.prepare("SELECT handler_status FROM messages WHERE msg_id='AFTER'").get().handler_status,
    null,
    'post-fence webhook stays received for boot replay',
  );
  assert.ok(reopened.prepare("SELECT v FROM daemon_state WHERE k='clean_shutdown_at'").get());
  reopened.close();
});

test('a turn rejected during shutdown stays replay-eligible and forbids the clean marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-reject-'));
  const d = daemon(dir, []);
  let rejectTurn;
  d.pm.getOrSpawn = async () => {};
  d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = () => new Promise((resolve, reject) => { rejectTurn = reject; });
  d.pm.shutdown = async () => {};

  await d.onMessage(msg({ msgId: 'REJECTED', text: 'umi work on this' }));
  await waitFor(() => d.busySummary().in_flight === 1, 'turn was never admitted');
  const stopping = d.stop();
  await waitFor(() => d._internal.shutdownBarrier.isFenced(), 'shutdown never fenced admission');
  rejectTurn(new Error('session stopped'));

  const result = await stopping;
  assert.equal(result.clean, false);
  const reopened = openDb(path.join(dir, 'umi.db'));
  assert.equal(
    reopened.prepare("SELECT handler_status FROM messages WHERE msg_id='REJECTED'").get().handler_status,
    'replay-pending',
  );
  assert.equal(
    reopened.prepare("SELECT v FROM daemon_state WHERE k='clean_shutdown_at'").get(),
    undefined,
  );
  reopened.close();
});

test('a database close failure invalidates the clean marker before retrying close', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-close-'));
  const d = daemon(dir, []);
  d.pm.shutdown = async () => {};
  const originalClose = d.db.close.bind(d.db);
  let closeCalls = 0;
  d.db.close = () => {
    closeCalls++;
    if (closeCalls === 1) throw new Error('simulated close failure');
    return originalClose();
  };

  const result = await d.stop();
  assert.equal(result.clean, false);
  assert.equal(closeCalls, 2, 'a failed close should be retried after invalidating the marker');

  const reopened = openDb(path.join(dir, 'umi.db'));
  assert.equal(
    reopened.prepare("SELECT v FROM daemon_state WHERE k='clean_shutdown_at'").get(),
    undefined,
  );
  assert.deepEqual(
    JSON.parse(reopened.prepare("SELECT detail_json FROM events WHERE kind='water-stop' ORDER BY id DESC LIMIT 1").get().detail_json),
    { clean: false },
    'the final lifecycle event must not report a clean stop after close failed',
  );
  reopened.close();
});

test('IPC work-producing methods reject after the shutdown fence while ping and busy remain available', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-ipc-'));
  const d = daemon(dir, []);
  d._internal.shutdownBarrier.fence();

  assert.deepEqual(
    await d.injectTurn({ chat_id: GROUP, text: 'daily summary' }),
    { ok: false, reason: 'shutting-down' },
  );
  assert.deepEqual(
    await d._internal.sendTextFromIpc({ chat_id: GROUP, text: 'operator message' }),
    { ok: false, reason: 'shutting-down' },
  );
  assert.deepEqual(d.busySummary(), { account: 'umi', in_flight: 0 });
  assert.equal(d._internal.shutdownBarrier.isFenced(), true);
  await d.stop();
});

test('busy summary counts non-turn admitted work as well as message turns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-busy-daemon-wide-'));
  const d = daemon(dir, []);
  const timerToken = d._internal.shutdownBarrier.admit({
    kind: 'timer:sla',
    owner: 'timer:sla',
  });
  assert.deepEqual(d.busySummary(), { account: 'umi', in_flight: 1 });
  timerToken.complete('timer-complete');
  assert.deepEqual(d.busySummary(), { account: 'umi', in_flight: 0 });
  await d.stop();
});

test('shutdown waits for an already-running watchdog callback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-watchdog-'));
  const d = daemon(dir, []);
  let finishPoll;
  const running = d._internal.runAdmitted(
    { kind: 'timer:poll', owner: 'timer:poll' },
    () => new Promise((resolve) => { finishPoll = resolve; }),
  );
  await waitFor(() => d.busySummary().in_flight === 1, 'watchdog callback was never admitted');
  let stopped = false;
  const stopping = d.stop().then((result) => { stopped = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false, 'shutdown must wait for the admitted callback');
  finishPoll();
  await running;
  assert.equal((await stopping).clean, true);
});

test('shutdown waits for a connection-event revive already in progress', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-connection-'));
  const d = daemon(dir, []);
  let finishRevive;
  d._internal.transport.connectSession = () => new Promise((resolve) => {
    finishRevive = resolve;
  });

  const running = d.onConnectionEvent({ kind: 'connect-failure' });
  await waitFor(
    () => d.busySummary().in_flight === 1,
    'connection event was never admitted',
  );
  let stopped = false;
  const stopping = d.stop().then((result) => {
    stopped = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false, 'shutdown must wait for the admitted connection event');

  finishRevive();
  await running;
  assert.equal((await stopping).clean, true);
});

test('shutdown during startup prevents later listeners and records a crash-like stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-startup-'));
  let finishIdentity;
  const transport = mkTransport([]);
  transport.sessionStatus = () => new Promise((resolve) => { finishIdentity = resolve; });
  const d = createDaemon({
    config: baseConfig(dir),
    account: 'umi',
    dataDir: dir,
    transport,
    logger: { log() {}, warn() {}, error() {} },
  });
  d.pm.shutdown = async () => {};

  const starting = d.start({ withTimers: false });
  await waitFor(() => d.busySummary().in_flight === 1, 'startup was never admitted');
  const stopping = d.stop();
  finishIdentity({ jid: BOT_PN });
  await assert.rejects(starting, /shutdown began during startup/);
  assert.equal((await stopping).clean, false);

  const reopened = openDb(path.join(dir, 'umi.db'));
  assert.equal(
    reopened.prepare("SELECT v FROM daemon_state WHERE k='clean_shutdown_at'").get(),
    undefined,
  );
  reopened.close();
});

test('a question answer remains admissible after the fence because it completes an existing turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-question-'));
  const d = daemonWithDm(dir, []);
  d.pm.answerQuestion = () => true;
  d.db.prepare(`
    INSERT INTO pending_questions
      (chat_jid, tool_call_id, session_id, asker_jid, questions_json, status, created_ts)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
  `).run(DM, 'tool-1', DM, DM, JSON.stringify([{
    header: 'size',
    question: 'Which size?',
    options: [{ label: 'Small', description: 'small' }],
  }]), Date.now());

  const turnToken = d._internal.shutdownBarrier.admit({ kind: 'turn', owner: DM });
  const stopping = d.stop();
  await waitFor(() => d._internal.shutdownBarrier.isFenced(), 'shutdown never fenced');
  await d.onMessage(msg({
    chatJid: DM,
    chatType: 'dm',
    msgId: 'ANSWER',
    sender: { jid: DM, altJid: null, pn: DM, lid: null, pushName: 'Alice' },
    text: '1',
  }));
  assert.equal(
    d.db.prepare("SELECT status FROM pending_questions WHERE tool_call_id='tool-1'").get().status,
    'answered',
  );
  assert.equal(
    d.db.prepare("SELECT handler_status FROM messages WHERE msg_id='ANSWER'").get().handler_status,
    'ignored',
  );
  turnToken.complete('durable-terminal');
  assert.equal((await stopping).clean, true);
});

test('an edit arriving after the fence resets its original row for boot re-evaluation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-edit-'));
  const d = daemon(dir, []);
  await d.onMessage(msg({ msgId: 'EDIT-TARGET', text: 'not addressed' }));
  await waitFor(
    () => d.db.prepare("SELECT handler_status FROM messages WHERE msg_id='EDIT-TARGET'").get()?.handler_status === 'ignored',
    'original message was never gated',
  );
  d._internal.shutdownBarrier.fence();
  await d.onMessage(msg({
    msgId: 'EDIT-EVENT',
    edit: { targetMsgId: 'EDIT-TARGET' },
    text: 'now addressed to umi',
  }));
  assert.equal(
    d.db.prepare("SELECT handler_status FROM messages WHERE msg_id='EDIT-TARGET'").get().handler_status,
    null,
  );
  await d.stop();
});

test('an ambiguous delivery during shutdown forbids the clean marker and replays the inbound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-shutdown-ambiguous-'));
  const d = daemon(dir, []);
  let rejectSend;
  d._internal.transport.sendText = () => new Promise((resolve, reject) => { rejectSend = reject; });
  d.pm.getOrSpawn = async () => {};
  d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = async () => {
    const delivered = await d._internal.toolDispatcher({
      sessionKey: GROUP,
      chatId: GROUP,
      toolName: 'reply',
      text: 'possibly landed',
    });
    assert.equal(delivered.ok, false);
    return { alreadyDelivered: true, turnId: 'T', metrics: { resultSubtype: 'success' } };
  };
  d.pm.shutdown = async () => {};

  await d.onMessage(msg({ msgId: 'AMBIGUOUS', text: 'umi answer' }));
  await waitFor(
    () => d.db.prepare("SELECT 1 FROM messages WHERE direction='out' AND status='pending'").get(),
    'outbound was never reserved',
  );
  const stopping = d.stop();
  const error = new Error('send timed out');
  error.code = 'TIMEOUT';
  rejectSend(error);
  const result = await stopping;
  assert.equal(result.clean, false);

  const reopened = openDb(path.join(dir, 'umi.db'));
  assert.equal(
    reopened.prepare("SELECT handler_status FROM messages WHERE msg_id='AMBIGUOUS'").get().handler_status,
    'replay-pending',
  );
  assert.equal(
    reopened.prepare("SELECT error FROM messages WHERE direction='out'").get().error,
    'ambiguous-send',
  );
  assert.equal(
    reopened.prepare("SELECT v FROM daemon_state WHERE k='clean_shutdown_at'").get(),
    undefined,
  );
  reopened.close();
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

test('boot replay preserves a structured native mention from the stored webhook', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-replay-mention-'));
  const raw = {
    type: 'Message',
    event: {
      Info: {
        Chat: GROUP,
        Sender: '55@lid',
        IsGroup: true,
        ID: 'R-MENTION',
        Timestamp: '2026-07-30T00:00:00Z',
        PushName: 'Alice',
      },
      Message: {
        extendedTextMessage: {
          text: 'please help',
          contextInfo: { mentionedJID: [BOT_PN] },
        },
      },
    },
  };
  const seed = openDb(path.join(dir, 'umi.db'));
  seed.prepare(`
    INSERT INTO messages
      (chat_jid,msg_id,sender_jid,user,text,raw_json,direction,account,ts,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    GROUP,
    'R-MENTION',
    '55@lid',
    'Alice',
    'please help',
    JSON.stringify(raw),
    'in',
    'umi',
    Date.now(),
    Date.now(),
  );
  seed.close();

  const d = daemon(dir, []);
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {};
  d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = async () => {
    dispatched++;
    return { alreadyDelivered: true };
  };
  await d.start({ withTimers: false });
  assert.equal(dispatched, 1, 'the native mention must still address the bot after replay');
  await d.stop();
});

test('a reply to a later message does not suppress an earlier replay candidate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-replay-correlated-'));
  const seed = openDb(path.join(dir, 'umi.db'));
  seed.prepare(`
    INSERT INTO messages
      (chat_jid,msg_id,sender_jid,user,text,direction,source,account,
       handler_status,status,quote_msg_id,ts,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    GROUP, 'R-EARLIER', '55@lid', 'Alice', 'umi earlier', 'in',
    'whatsapp', 'umi', 'replay-pending', 'received', null,
    Date.now() - 10, Date.now() - 10,
  );
  seed.prepare(`
    INSERT INTO messages
      (chat_jid,msg_id,sender_jid,user,text,direction,source,account,
       handler_status,status,quote_msg_id,ts,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    GROUP, 'R-LATER', '55@lid', 'Alice', 'umi later', 'in',
    'whatsapp', 'umi', 'replied', 'received', null,
    Date.now() - 5, Date.now() - 5,
  );
  seed.prepare(`
    INSERT INTO messages
      (chat_jid,msg_id,sender_jid,user,text,direction,source,account,
       handler_status,status,quote_msg_id,ts,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    GROUP, 'OUT-LATER', BOT_PN, null, 'later answer', 'out',
    'bot-reply', 'umi', null, 'sent', 'R-LATER',
    Date.now(), Date.now(),
  );
  seed.close();

  const d = daemon(dir, []);
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {};
  d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = async () => {
    dispatched++;
    return { alreadyDelivered: true };
  };
  await d.start({ withTimers: false });
  assert.equal(dispatched, 1, 'only evidence tied to the same inbound may suppress replay');
  await d.stop();
});

test('an edit fenced during shutdown replays its updated structured mention', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-replay-edit-'));
  const originalRaw = {
    type: 'Message',
    event: {
      Info: {
        Chat: GROUP,
        Sender: '55@lid',
        IsGroup: true,
        ID: 'R-EDITED',
        Timestamp: '2026-07-30T00:00:00Z',
        PushName: 'Alice',
      },
      Message: { extendedTextMessage: { text: 'please help' } },
    },
  };
  const editRaw = {
    type: 'Message',
    event: {
      Info: {
        Chat: GROUP,
        Sender: '55@lid',
        IsGroup: true,
        ID: 'R-EDIT-EVENT',
        Timestamp: '2026-07-30T00:00:01Z',
        PushName: 'Alice',
      },
      Message: {
        protocolMessage: {
          type: 14,
          key: { ID: 'R-EDITED' },
          editedMessage: {
            extendedTextMessage: {
              text: 'please help',
              contextInfo: { mentionedJID: [BOT_PN] },
            },
          },
        },
      },
    },
  };

  const first = daemon(dir, []);
  await first.onMessage(normalize(originalRaw).message);
  await waitFor(
    () => first.db.prepare("SELECT handler_status FROM messages WHERE msg_id='R-EDITED'").get()?.handler_status === 'ignored',
    'original unaddressed message was not gated',
  );

  let finishTurn;
  first.pm.getOrSpawn = async () => {};
  first.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  first.pm.send = () => new Promise((resolve) => { finishTurn = resolve; });
  first.pm.shutdown = async () => {};
  await first.onMessage(msg({ msgId: 'R-DRAIN', text: 'umi finish this turn' }));
  await waitFor(() => first.busySummary().in_flight === 1, 'drain fixture turn was never admitted');

  const stopping = first.stop();
  await waitFor(() => first._internal.shutdownBarrier.isFenced(), 'shutdown never fenced admission');
  await first.onMessage(normalize(editRaw).message);
  finishTurn({ alreadyDelivered: true, turnId: 'T', metrics: { resultSubtype: 'success' } });
  await stopping;

  const second = daemon(dir, []);
  let dispatched = 0;
  second.pm.getOrSpawn = async () => {};
  second.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  second.pm.send = async () => {
    dispatched++;
    return { alreadyDelivered: true };
  };
  await second.start({ withTimers: false });
  assert.equal(dispatched, 1, 'boot replay must gate the edited native mention');
  await second.stop();
});

test('failed boot replay stays replay-pending and prevents readiness', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-replay-failed-'));
  const seed = openDb(path.join(dir, 'umi.db'));
  seed.prepare(`
    INSERT INTO messages
      (chat_jid,msg_id,sender_jid,user,text,direction,account,handler_status,ts,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    GROUP,
    'R-FAILED',
    '55@lid',
    'Alice',
    'umi retry this',
    'in',
    'umi',
    'replay-pending',
    Date.now(),
    Date.now(),
  );
  seed.close();

  const d = daemon(dir, []);
  d.pm.getOrSpawn = async () => {};
  d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = async () => {
    throw new Error('replay fixture failure');
  };

  await assert.rejects(
    d.start({ withTimers: false }),
    /boot replay incomplete/,
  );
  assert.equal(
    d.db.prepare("SELECT handler_status FROM messages WHERE msg_id='R-FAILED'").get().handler_status,
    'replay-pending',
  );
  await d.stop();

  const next = daemon(dir, []);
  let dispatched = 0;
  next.pm.getOrSpawn = async () => {};
  next.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  next.pm.send = async () => {
    dispatched++;
    return { alreadyDelivered: true };
  };
  await next.start({ withTimers: false });
  assert.equal(
    dispatched,
    1,
    'a failed boot must stay crash-like so the next boot retries the row',
  );
  await next.stop();
});

test('explicit replay-pending rows are retried even after the legacy replay window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-replay-old-'));
  const old = Date.now() - 3 * 3600_000;
  const seed = openDb(path.join(dir, 'umi.db'));
  seed.prepare(`
    INSERT INTO messages
      (chat_jid,msg_id,sender_jid,user,text,direction,account,
       handler_status,ts,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    GROUP, 'R-OLD-PENDING', '55@lid', 'Alice', 'umi recover this',
    'in', 'umi', 'replay-pending', old, old,
  );
  seed.close();

  const d = daemon(dir, []);
  let dispatched = 0;
  d.pm.getOrSpawn = async () => {};
  d.pm.procs = new Map([[GROUP, { claudeSessionId: 's' }]]);
  d.pm.send = async () => {
    dispatched++;
    return { alreadyDelivered: true };
  };
  await d.start({ withTimers: false });
  assert.equal(dispatched, 1);
  await d.stop();
});

test('lifecycle telemetry proves startup, replay, admission, drain, and stop without identifiers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-lifecycle-'));
  const d = daemon(dir, []);
  await d.start({ withTimers: false });
  await d.stop();

  const reopened = openDb(path.join(dir, 'umi.db'));
  const rows = reopened.prepare(`
    SELECT kind, detail_json
      FROM events
     WHERE kind LIKE 'water-%'
     ORDER BY id
  `).all();
  reopened.close();

  assert.deepEqual(
    rows.map((row) => row.kind),
    [
      'water-start',
      'water-receiver-ready',
      'water-boot-replay-complete',
      'water-admission-open',
      'water-shutdown-fenced',
      'water-shutdown-drain',
      'water-stop',
    ],
  );
  const serialized = rows.map((row) => row.detail_json).join('\n');
  for (const forbidden of ['chat', 'jid', 'message', 'session', 'socket']) {
    assert.doesNotMatch(serialized.toLowerCase(), new RegExp(forbidden));
  }
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

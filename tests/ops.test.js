'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('../lib/db');
const { createEscalator, inQuietHours } = require('../lib/ops/escalate');
const { createSlaWatchdog } = require('../lib/ops/sla-watchdog');
const { createTransportWatchdog } = require('../lib/ops/transport-watchdog');
const { createHeartbeat } = require('../lib/ops/heartbeat');

function db() { return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-ops-')), 't.db')); }

// --- escalation ---
test('escalator sends via injected tell with severity prefix', async () => {
  const calls = [];
  const e = createEscalator({ ipcBot: 'shumabit', chatId: '123', tellFn: async (bot, m, p) => calls.push({ bot, m, p }) });
  assert.equal(await e.escalate('CRITICAL', 'boom'), true);
  assert.equal(calls[0].bot, 'shumabit');
  assert.match(calls[0].p.text, /CRITICAL: boom/);
});

test('INFO escalation is suppressed during quiet hours; CRITICAL always pages', async () => {
  const quiet = { from: '01:00', to: '07:00', tz: 'UTC' };
  const at3amUtc = new Date('2026-07-04T03:00:00Z');
  assert.equal(inQuietHours(at3amUtc, quiet), true);
  const calls = [];
  const e = createEscalator({ ipcBot: 'b', chatId: '1', quietHours: quiet, tellFn: async (...a) => calls.push(a), nowFn: () => at3amUtc });
  assert.equal(await e.escalate('INFO', 'x'), false);   // suppressed
  assert.equal(await e.escalate('CRITICAL', 'y'), true); // always pages
  assert.equal(calls.length, 1);
});

test('escalation-failed is logged loudly when the IPC path is down', async () => {
  const events = [];
  const e = createEscalator({ ipcBot: 'b', chatId: '1', tellFn: async () => { throw new Error('down'); }, logEvent: (k) => events.push(k), logger: { error() {} } });
  assert.equal(await e.escalate('CRITICAL', 'x'), false);
  assert.ok(events.includes('escalation-failed'));
});

// --- SLA watchdog ---
function seedStuck(d, { ageMs, human = false }) {
  const now = Date.now();
  d.prepare(`INSERT INTO messages (chat_jid,msg_id,sender_jid,text,direction,account,handler_status,ts,received_at)
             VALUES (?,?,?,?,?,?,?,?,?)`).run('g@g.us', 'M1', 's', 'help', 'in', 'umi', 'dispatched', now - ageMs, now - ageMs);
  if (human) d.prepare(`INSERT INTO messages (chat_jid,msg_id,sender_jid,direction,account,is_from_me,source,status,ts,received_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`).run('g@g.us', 'H1', 's', 'out', 'umi', 1, 'human-device', 'sent', now - ageMs + 1000, now);
}

test('SLA: a stuck dispatched turn past holdAfter gets a holding reply once', async () => {
  const d = db();
  seedStuck(d, { ageMs: 100 * 60_000 }); // 100 min, past the 92-min default hold
  const sends = [];
  const escs = [];
  const w = createSlaWatchdog({ db: d, resolveChat: () => ({ maxTurnHard: 90 * 60_000 }), sendHolding: async () => { sends.push(1); return true; }, escalate: async (s) => escs.push(s) });
  await w.tick();
  await w.tick(); // second tick must NOT re-send (latched)
  assert.equal(sends.length, 1);
  assert.deepEqual(escs, ['INFO']);
});

test('SLA: a human answering from the phone suppresses the holding reply (INFO still fires)', async () => {
  const d = db();
  seedStuck(d, { ageMs: 100 * 60_000, human: true });
  const sends = [];
  const escs = [];
  const w = createSlaWatchdog({ db: d, resolveChat: () => ({ maxTurnHard: 90 * 60_000 }), sendHolding: async () => { sends.push(1); return true; }, escalate: async (s) => escs.push(s) });
  await w.tick();
  assert.equal(sends.length, 0, 'no robotic reply when a human is active');
  assert.deepEqual(escs, ['INFO']);
});

test('SLA: a fresh turn (within hold window) does not trigger', async () => {
  const d = db();
  seedStuck(d, { ageMs: 5 * 60_000 });
  const sends = [];
  const w = createSlaWatchdog({ db: d, resolveChat: () => ({ maxTurnHard: 90 * 60_000 }), sendHolding: async () => { sends.push(1); return true; }, escalate: async () => {} });
  await w.tick();
  assert.equal(sends.length, 0);
});

// --- transport watchdog ---
test('transport watchdog: logged-out is CRITICAL and blocks auto-revive', async () => {
  const escs = [];
  let connectCalls = 0;
  const w = createTransportWatchdog({ transport: { connectSession: async () => { connectCalls++; }, sessionStatus: async () => ({ connected: false }) }, escalate: async (s, t) => escs.push([s, t]) });
  await w.onConnectionEvent({ kind: 'logged-out' });
  assert.equal(escs[0][0], 'CRITICAL');
  // even after down polls, no revive (needs a human)
  await w.poll(); await w.poll(); await w.poll();
  assert.equal(connectCalls, 0);
});

test('transport watchdog: connect-failure triggers a bounded revive', async () => {
  let connectCalls = 0;
  const w = createTransportWatchdog({ transport: { connectSession: async () => { connectCalls++; }, sessionStatus: async () => ({}) }, escalate: async () => {} });
  await w.onConnectionEvent({ kind: 'connect-failure' });
  assert.equal(connectCalls, 1);
});

// --- heartbeat ---
test('heartbeat writes an atomic file and reports fresh age', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-hb-'));
  const d = openDb(path.join(dir, 'umi.db'));
  const hb = createHeartbeat({ db: d, dataDir: dir, account: 'umi' });
  const snap = hb.beat();
  assert.ok(fs.existsSync(path.join(dir, 'heartbeat.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'heartbeat.json'))).account, 'umi');
  assert.ok(hb.healthPayload().heartbeatAgeS <= 1);
});

test('transport watchdog in STANDBY does not claim the webhook', async () => {
  const { createTransportWatchdog } = require('../lib/ops/transport-watchdog');
  let setCalls = 0;
  const transport = { async sessionStatus() { return { connected: true, webhook: '' }; }, async setWebhook() { setCalls++; } };
  const wd = createTransportWatchdog({ transport, escalate: async () => {}, expectedWebhook: { url: 'http://127.0.0.1:8090/hook/water', baseUrlPrefix: 'http://127.0.0.1' }, standby: true });
  await wd.poll();
  assert.equal(setCalls, 0, 'standby must NOT claim an empty webhook');
  // and NON-standby DOES claim it
  let setCalls2 = 0;
  const t2 = { async sessionStatus() { return { connected: true, webhook: '' }; }, async setWebhook() { setCalls2++; } };
  const wd2 = createTransportWatchdog({ transport: t2, escalate: async () => {}, expectedWebhook: { url: 'http://127.0.0.1:8090/hook/water', baseUrlPrefix: 'http://127.0.0.1' } });
  await wd2.poll();
  assert.equal(setCalls2, 1, 'non-standby claims the empty webhook');
});

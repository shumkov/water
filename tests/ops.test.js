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
const { createAuthDisabledGate } = require('../lib/ops/auth-disabled-gate');

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

test('no ipcBot configured → escalation is a no-op (no IPC attempt, no escalation-failed noise)', async () => {
  // Netdata is the single alert surface; with no ipcBot, escalate must NOT hit the IPC (which
  // would fail to /tmp/polygram-undefined.sock and inflate healthz.escalated). It just records
  // an escalation-skipped event and returns false.
  const events = [];
  let tellCalls = 0;
  const e = createEscalator({ ipcBot: undefined, chatId: '1', tellFn: async () => { tellCalls++; }, logEvent: (k) => events.push(k), logger: { error() {} } });
  assert.equal(await e.escalate('CRITICAL', 'x'), false);
  assert.equal(tellCalls, 0, 'no ipcBot → the IPC send must not be attempted');
  assert.ok(events.includes('escalation-skipped'));
  assert.ok(!events.includes('escalation-failed'), 'no failed-event noise when disabled');
});

// --- auth-disabled gate ---
test('auth-disabled gate: onFailure escalates once across two consecutive calls (dedupe)', async () => {
  const calls = [];
  const g = createAuthDisabledGate({ escalate: async (sev, t) => { calls.push([sev, t]); return true; }, logger: { error() {} } });
  g.onFailure({ sessionKey: 'a@g.us', msgId: 'M1' });
  await Promise.resolve(); await Promise.resolve(); // let the fire-and-forget promise settle
  g.onFailure({ sessionKey: 'a@g.us', msgId: 'M2' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'CRITICAL');
  assert.match(calls[0][1], /Claude Code access disabled/);
});

test('auth-disabled gate: onFailure logs a distinct event on EVERY call, even deduped ones', async () => {
  const events = [];
  const g = createAuthDisabledGate({ escalate: async () => true, logEvent: (kind, detail) => events.push({ kind, detail }), logger: { error() {} } });
  g.onFailure({ sessionKey: 'a@g.us', msgId: 'M1' });
  await Promise.resolve(); await Promise.resolve();
  g.onFailure({ sessionKey: 'a@g.us', msgId: 'M2' });
  await Promise.resolve(); await Promise.resolve();
  const authEvents = events.filter((e) => e.kind === 'auth-disabled');
  assert.equal(authEvents.length, 2, 'every occurrence must log, independent of the escalate dedupe');
});

test('auth-disabled gate: a failed/no-op escalate send un-latches — the NEXT occurrence retries', async () => {
  const calls = [];
  const g = createAuthDisabledGate({ escalate: async (sev, t) => { calls.push(t); return false; }, logger: { error() {} } });
  g.onFailure({ sessionKey: 'a@g.us' });
  await Promise.resolve(); await Promise.resolve();
  g.onFailure({ sessionKey: 'a@g.us' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 2, 'a false (no-op/failed) send must not permanently latch — one bad attempt must not silence the rest of the outage');
});

test('auth-disabled gate: a throwing escalate un-latches too, and never rejects out of onFailure', async () => {
  const g = createAuthDisabledGate({ escalate: async () => { throw new Error('IPC down'); }, logger: { error() {} } });
  assert.doesNotThrow(() => g.onFailure({ sessionKey: 'a@g.us' }));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const calls = [];
  const g2 = createAuthDisabledGate({ escalate: async (sev, t) => { calls.push(t); throw new Error('still down'); }, logger: { error() {} } });
  g2.onFailure({ sessionKey: 'a@g.us' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  g2.onFailure({ sessionKey: 'a@g.us' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 2, 'a thrown escalate must un-latch just like a false return');
});

test('auth-disabled gate: an unexpected escalate() throw is loudly logged, not silently swallowed', async () => {
  const events = [];
  const errors = [];
  const g = createAuthDisabledGate({
    escalate: async () => { throw new Error('unexpected bug'); },
    logEvent: (kind, detail) => events.push({ kind, detail }),
    logger: { error: (msg) => errors.push(msg) },
  });
  g.onFailure({ sessionKey: 'a@g.us' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.ok(events.some((e) => e.kind === 'auth-disabled-escalate-error'), 'an unexpected escalate() failure must be logged as its own event, not just silently un-latched');
  assert.ok(errors.some((m) => /unexpected bug/.test(m)), 'the actual error message must reach the logger, not just a generic line');
});

test('auth-disabled gate: onSuccess re-arms even a confirmed-sent (still-latched) outage', async () => {
  const calls = [];
  const g = createAuthDisabledGate({ escalate: async (sev, t) => { calls.push(t); return true; }, logger: { error() {} } });
  g.onFailure({ sessionKey: 'a@g.us' });
  await Promise.resolve(); await Promise.resolve();
  g.onSuccess(); // outage ended
  g.onFailure({ sessionKey: 'a@g.us' }); // a distinct, later outage
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 2, 'onSuccess must re-arm so a later, distinct outage escalates again');
});

test('auth-disabled gate: two onFailure calls in the same tick (no await between) still fire escalate exactly once', async () => {
  const calls = [];
  const g = createAuthDisabledGate({ escalate: async (sev, t) => { calls.push(t); return true; }, logger: { error() {} } });
  g.onFailure({ sessionKey: 'a@g.us' });
  g.onFailure({ sessionKey: 'b@g.us' }); // no await between — simulates two chats failing in the same tick
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 1, 'the synchronous check-and-set must prevent a thundering herd across concurrently-failing chats');
});

test('auth-disabled gate: no escalate configured — onFailure does not throw, still logs', async () => {
  const events = [];
  const g = createAuthDisabledGate({ logEvent: (kind) => events.push(kind), logger: { error() {} } });
  assert.doesNotThrow(() => g.onFailure({ sessionKey: 'a@g.us' }));
  assert.ok(events.includes('auth-disabled'));
  assert.doesNotThrow(() => g.onSuccess());
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

test('heartbeat: authDisabled counts auth-disabled events in the trailing hour, distinct from escalated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-hb-'));
  const d = openDb(path.join(dir, 'umi.db'));
  const now = Date.now();
  d.prepare("INSERT INTO events (ts, chat_jid, kind, detail_json) VALUES (?,?,?,?)").run(now, 'a@g.us', 'auth-disabled', '{}');
  d.prepare("INSERT INTO events (ts, chat_jid, kind, detail_json) VALUES (?,?,?,?)").run(now, 'b@g.us', 'auth-disabled', '{}');
  d.prepare("INSERT INTO events (ts, chat_jid, kind, detail_json) VALUES (?,?,?,?)").run(now - 2 * 3600_000, 'c@g.us', 'auth-disabled', '{}'); // old — outside the 1h window
  const hb = createHeartbeat({ db: d, dataDir: dir, account: 'umi' });
  const snap = hb.beat();
  assert.equal(snap.authDisabled, 2, 'only the trailing-hour auth-disabled events count');
  assert.equal(hb.healthPayload().authDisabled, 2, 'must also feed the /healthz payload');
  assert.equal(snap.escalated, 0, 'auth-disabled events must not inflate the generic escalated counter');
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

test('transport watchdog self-heals an advertiseHost change (same path, new host) — not foreign', async () => {
  const { createTransportWatchdog } = require('../lib/ops/transport-watchdog');
  // WuzAPI holds water's OWN prior webhook at the loopback host; water now advertises the
  // docker-bridge gateway. Same /hook/water path → recognise as ours → repair to the new URL,
  // instead of mistaking it for a foreign consumer and dead-locking (the production trap).
  let setUrl = null;
  const transport = {
    async sessionStatus() { return { connected: true, webhook: 'http://127.0.0.1:8090/hook/water' }; },
    async setWebhook({ url }) { setUrl = url; },
  };
  const expectedWebhook = { url: 'http://172.21.0.1:8090/hook/water', path: '/hook/water', baseUrlPrefix: 'http://172.21.0.1' };
  const wd = createTransportWatchdog({ transport, escalate: async () => {}, expectedWebhook });
  await wd.poll();
  assert.equal(setUrl, 'http://172.21.0.1:8090/hook/water', 'a host-only change must self-heal to the new advertiseHost URL');
});

test('transport watchdog leaves a genuinely foreign endpoint (different path) alone + escalates', async () => {
  const { createTransportWatchdog } = require('../lib/ops/transport-watchdog');
  let setCalls = 0; let escalated = null;
  const transport = {
    async sessionStatus() { return { connected: true, webhook: 'http://10.0.0.9:8090/hook/other' }; },
    async setWebhook() { setCalls++; },
  };
  const expectedWebhook = { url: 'http://172.21.0.1:8090/hook/water', path: '/hook/water', baseUrlPrefix: 'http://172.21.0.1' };
  const wd = createTransportWatchdog({ transport, escalate: async (sev, t) => { escalated = { sev, t }; }, expectedWebhook });
  await wd.poll();
  assert.equal(setCalls, 0, 'a different /hook path is a foreign consumer → do not clobber');
  assert.equal(escalated?.sev, 'INFO');
});

'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createFeedback, REFRESH_MS, MAX_TYPING_MS } = require('../lib/feedback/feedback');

// The reactor applies emoji through a serialized promise chain (applyChain), so
// react/setPresence land asynchronously — flush the queue before asserting.
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

function mkTransport(over = {}) {
  const reacts = []; const presence = [];
  return {
    react: async (a) => { reacts.push(a); },
    setPresence: async (chatJid, state) => { presence.push({ chatJid, state }); },
    _reacts: reacts, _presence: presence, ...over,
  };
}
const msg = (over = {}) => ({ chatJid: 'G@g.us', chatType: 'group', msgId: 'M1', sender: { jid: '55@lid' }, ...over });
const SILENT = { debug() {}, error() {}, warn() {}, log() {} };

test('begin fires the 👀 ack (with participantJid) + composing presence; end → paused', async () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { typing: { enabled: true }, ackReaction: { group: 'always', dm: 'always' } } });
  const h = fb.begin(msg());
  await tick();
  assert.equal(t._reacts[0].emoji, '👀');
  assert.equal(t._reacts[0].participantJid, '55@lid');   // required for a GROUP reaction
  assert.equal(t._reacts[0].chatJid, 'G@g.us');
  assert.equal(t._presence[0].state, 'composing');
  h.end({ ok: true, delivered: true });
  await tick();
  assert.equal(t._presence.at(-1).state, 'paused');
});

test('progress cascade: thinking → tool(web) → subagent map to 🤔 / ⚡ / 👾', async () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { ackReaction: { group: 'always' } } });
  const h = fb.begin(msg());
  fb.onEvent('G@g.us', 'thinking'); await tick();
  fb.onEvent('G@g.us', 'tool-use', 'WebFetch'); await tick();   // tool-use payload is the toolName STRING
  fb.onEvent('G@g.us', 'subagent-start', {}); await tick();
  const emojis = t._reacts.map((r) => r.emoji);
  assert.ok(emojis.includes('🤔'), 'thinking → 🤔');
  assert.ok(emojis.includes('⚡'), 'WebFetch → WEB → ⚡');
  assert.ok(emojis.includes('👾'), 'subagent → 👾');
  h.end({ ok: true, delivered: true });
  await tick();
});

test('end resolution: error → 🤯', async () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { ackReaction: { group: 'always' } } });
  const h = fb.begin(msg()); await tick();
  h.end({ ok: false }); await tick();
  assert.equal(t._reacts.at(-1).emoji, '🤯');
});

test('end resolution: completed with NO reply → durable ✅ (not cleared)', async () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { ackReaction: { group: 'always' } } });
  const h = fb.begin(msg()); await tick();
  h.end({ ok: true, delivered: false }); await tick();
  assert.equal(t._reacts.at(-1).emoji, '✅');
  assert.ok(!t._reacts.some((r) => r.emoji === null), 'no-reply must NOT clear the ack');
});

test('end resolution: completed WITH reply → clears the ack (react null)', async () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { ackReaction: { group: 'always' } } });
  const h = fb.begin(msg()); await tick();
  h.end({ ok: true, delivered: true }); await tick();
  assert.equal(t._reacts.at(-1).emoji, null, 'delivered → clear');
});

test('no-clobber: when the agent set its own reaction, end does NOT clear', async () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { ackReaction: { group: 'always' } } });
  const h = fb.begin(msg()); await tick();
  fb.markAgentReacted('G@g.us');
  h.end({ ok: true, delivered: true }); await tick();
  assert.ok(!t._reacts.some((r) => r.emoji === null), 'agent reaction must be left untouched');
});

test('replay + synthetic(inj-/water:inject) turns get NO feedback', async () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { typing: { enabled: true }, ackReaction: { group: 'always', dm: 'always' } } });
  fb.begin(msg(), { isReplay: true }).end({ ok: true });
  fb.begin(msg({ msgId: 'inj-123' })).end({ ok: true });
  fb.begin(msg({ sender: { jid: 'water:inject' } })).end({ ok: true });
  fb.onEvent('G@g.us', 'thinking');   // no live turn registered
  await tick();
  assert.equal(t._reacts.length, 0);
  assert.equal(t._presence.length, 0);
});

test('best-effort: a throwing transport never throws out of begin/onEvent/end', async () => {
  const t = { react: async () => { throw new Error('down'); }, setPresence: async () => { throw new Error('down'); } };
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { typing: { enabled: true }, ackReaction: { group: 'always' } } });
  const h = fb.begin(msg());          // must not throw
  fb.onEvent('G@g.us', 'tool-use', 'Bash');
  await tick();
  assert.doesNotThrow(() => h.end({ ok: false }));
  await tick();
});

test('ackReaction:never → NO reactions at all (no ack, no cascade, no terminal), typing still works', async () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { typing: { enabled: true }, ackReaction: { group: 'never' } } });
  const h = fb.begin(msg());
  fb.onEvent('G@g.us', 'thinking');
  fb.onEvent('G@g.us', 'tool-use', 'Bash');
  await tick();
  assert.equal(t._reacts.length, 0, 'never → the cascade must not fire either');
  assert.equal(t._presence[0].state, 'composing', 'typing still runs');
  h.end({ ok: true, delivered: false }); await tick();
  assert.equal(t._reacts.length, 0, 'never → no terminal ✅ either');
  assert.equal(t._presence.at(-1).state, 'paused');
});

test('parallel subagents: the 👾 work-hold survives until the LAST subagent-done', async () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { ackReaction: { group: 'always' } } });
  const h = fb.begin(msg()); await tick();
  // Two concurrent subagents; the first finishing must NOT release the hold.
  fb.onEvent('G@g.us', 'subagent-start', {});
  fb.onEvent('G@g.us', 'subagent-start', {});
  await tick();
  assert.equal(t._reacts.at(-1).emoji, '👾');
  fb.onEvent('G@g.us', 'subagent-done', {});   // first done — second still running
  await tick();
  assert.equal(t._reacts.at(-1).emoji, '👾', 'hold survives while a second subagent runs');
  fb.onEvent('G@g.us', 'subagent-done', {});   // last done → back to 🤔
  await tick();
  assert.equal(t._reacts.at(-1).emoji, '🤔', 'last subagent-done releases → THINKING');
  h.end({ ok: true, delivered: true }); await tick();
});

test('end is idempotent + a no-op for an unknown session', () => {
  const t = mkTransport();
  const fb = createFeedback({ transport: t, logger: SILENT, settings: { ackReaction: { group: 'always' } } });
  const h = fb.begin(msg());
  assert.doesNotThrow(() => { h.end({ ok: true }); h.end({ ok: true }); }); // double end
});

// ── Typing loop (fake timers) ───────────────────────────────────────────────────
// Only the typing timers are exercised here (ackReaction:'never' ⇒ no reactor ⇒ no
// reactor timers to interfere), so the mock clock drives just the composing loop.

test('typing: the REFRESH_MS interval re-fires setPresence(composing)', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const t = mkTransport();
    const fb = createFeedback({ transport: t, logger: SILENT, settings: { typing: { enabled: true }, ackReaction: { group: 'never' } } });
    fb.begin(msg());
    const composing = () => t._presence.filter((p) => p.state === 'composing').length;
    assert.equal(composing(), 1, 'fires once immediately');
    mock.timers.tick(REFRESH_MS);
    assert.equal(composing(), 2, 'refreshed on the interval');
    mock.timers.tick(REFRESH_MS);
    assert.equal(composing(), 3);
  } finally { mock.timers.reset(); }
});

test('typing: the MAX_TYPING_MS cap stops the loop + sends paused', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const t = mkTransport();
    const fb = createFeedback({ transport: t, logger: SILENT, settings: { typing: { enabled: true }, ackReaction: { group: 'never' } } });
    fb.begin(msg());
    mock.timers.tick(MAX_TYPING_MS);
    assert.equal(t._presence.at(-1).state, 'paused', 'cap → paused');
    const n = t._presence.length;
    mock.timers.tick(REFRESH_MS * 5);
    assert.equal(t._presence.length, n, 'no further composing after the cap');
  } finally { mock.timers.reset(); }
});

test('typing: end() clears the interval — no composing fires afterward', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const t = mkTransport();
    const fb = createFeedback({ transport: t, logger: SILENT, settings: { typing: { enabled: true }, ackReaction: { group: 'never' } } });
    const h = fb.begin(msg());
    h.end({ ok: true, delivered: true });
    assert.equal(t._presence.at(-1).state, 'paused');
    const n = t._presence.length;
    mock.timers.tick(REFRESH_MS * 5);
    assert.equal(t._presence.length, n, 'interval cleared by end()');
  } finally { mock.timers.reset(); }
});

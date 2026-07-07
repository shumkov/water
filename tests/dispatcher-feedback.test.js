'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../lib/handlers/dispatcher');

function spyFeedback() {
  const calls = { begin: [], end: [] };
  return { calls, begin(msg, opts) { calls.begin.push({ msg, opts }); return { end: (res) => calls.end.push(res) }; } };
}
function mkDeps({ pmSend, feedback }) {
  const marks = [];
  return {
    pm: { getOrSpawn: async () => {}, send: pmSend, procs: new Map() },
    sessions: { resolveForSpawn: () => null, persist: () => {} },
    status: {
      markDispatched: () => marks.push('dispatched'),
      markReplied: () => marks.push('replied'),
      markFailed: () => marks.push('failed'),
      recordTurnMetric: () => {},
    },
    resolveChat: () => ({ cwd: '/tmp' }),
    defaults: {}, feedback,
    logger: { error() {}, warn() {}, log() {} },
    _marks: marks,
  };
}
const msg = () => ({ chatJid: 'G@g.us', chatType: 'group', msgId: 'M1', sender: { pushName: 'A', jid: '5@lid' } });

test('feedback.begin fires right after markDispatched; end gets {ok,delivered} on a delivered turn', async () => {
  const fb = spyFeedback();
  const deps = mkDeps({ pmSend: async () => ({ alreadyDelivered: true }), feedback: fb });
  await createDispatcher(deps).dispatch('G@g.us', msg(), { id: 1 });
  assert.equal(deps._marks[0], 'dispatched');
  assert.equal(fb.calls.begin.length, 1);
  assert.equal(fb.calls.begin[0].msg.msgId, 'M1');
  assert.deepEqual(fb.calls.end[0], { ok: true, delivered: true });
});

test('turn error → feedback.end {ok:false}', async () => {
  const fb = spyFeedback();
  const deps = mkDeps({ pmSend: async () => { throw new Error('boom'); }, feedback: fb });
  await assert.rejects(() => createDispatcher(deps).dispatch('G@g.us', msg(), { id: 1 }));
  assert.equal(fb.calls.end[0].ok, false);
  assert.equal(fb.calls.end[0].delivered, false);
});

test('intentional silence (no reply) → feedback.end {ok:true, delivered:false}', async () => {
  const fb = spyFeedback();
  const deps = mkDeps({ pmSend: async () => ({}), feedback: fb });   // no alreadyDelivered, no text
  await createDispatcher(deps).dispatch('G@g.us', msg(), { id: 1 });
  assert.deepEqual(fb.calls.end[0], { ok: true, delivered: false });
});

test('CRITICAL: a throwing feedback.end does NOT leak the per-session lock', async () => {
  const badFb = { begin() { return { end() { throw new Error('end boom'); } }; } };
  let sends = 0;
  const deps = mkDeps({ pmSend: async () => { sends++; return { alreadyDelivered: true }; }, feedback: badFb });
  const d = createDispatcher(deps);
  await d.dispatch('G@g.us', msg(), { id: 1 });   // fb.end throws → must be swallowed → release() still runs
  // If the lock had leaked, this second same-chat dispatch would hang forever.
  await d.dispatch('G@g.us', msg(), { id: 2 });
  assert.equal(sends, 2, 'second turn ran → the lock was released despite fb.end throwing');
});

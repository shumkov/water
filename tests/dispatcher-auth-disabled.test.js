'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../lib/handlers/dispatcher');
const { classify } = require('../lib/error/classify');

function mkDeps({ pmSend, authDisabledGate, errorReply }) {
  return {
    pm: { getOrSpawn: async () => {}, send: pmSend, procs: new Map() },
    sessions: { resolveForSpawn: () => null, persist: () => {} },
    status: {
      markDispatched: () => {},
      markReplied: () => {},
      markFailed: () => {},
      recordTurnMetric: () => {},
    },
    resolveChat: () => ({ cwd: '/tmp' }),
    defaults: {},
    classify,
    authDisabledGate,
    errorReply,
    logger: { error() {}, warn() {}, log() {} },
  };
}
const msg = () => ({ chatJid: 'G@g.us', chatType: 'group', msgId: 'M1', sender: { pushName: 'A', jid: '5@lid' } });

test('AUTH_DISABLED turn failure calls authDisabledGate.onFailure with sessionKey + msgId', async () => {
  const calls = [];
  const err = Object.assign(new Error('disabled Claude subscription access'), { code: 'AUTH_DISABLED' });
  const deps = mkDeps({
    pmSend: async () => { throw err; },
    authDisabledGate: { onFailure: (a) => calls.push(a), onSuccess: () => {} },
  });
  await assert.rejects(() => createDispatcher(deps).dispatch('G@g.us', msg(), { id: 1 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionKey, 'G@g.us');
  assert.equal(calls[0].msgId, 'M1');
});

test('a successful dispatch calls authDisabledGate.onSuccess()', async () => {
  let successCalls = 0;
  const deps = mkDeps({
    pmSend: async () => ({ alreadyDelivered: true }),
    authDisabledGate: { onFailure: () => {}, onSuccess: () => { successCalls++; } },
  });
  await createDispatcher(deps).dispatch('G@g.us', msg(), { id: 1 });
  assert.equal(successCalls, 1);
});

test('a bug in authDisabledGate.onSuccess must not turn a successful turn into a rejected one', async () => {
  const deps = mkDeps({
    pmSend: async () => ({ alreadyDelivered: true }),
    authDisabledGate: { onFailure: () => {}, onSuccess: () => { throw new Error('bug inside the gate'); } },
  });
  const result = await createDispatcher(deps).dispatch('G@g.us', msg(), { id: 1 });
  assert.equal(result.alreadyDelivered, true, 'the real turn result must still be returned, not swallowed by a gate bug');
});

test('AUTH_DISABLED: errorReply is never called (silence to the WhatsApp partner)', async () => {
  const err = Object.assign(new Error('disabled Claude subscription access'), { code: 'AUTH_DISABLED' });
  let errorReplyCalls = 0;
  const deps = mkDeps({
    pmSend: async () => { throw err; },
    authDisabledGate: { onFailure: () => {}, onSuccess: () => {} },
    errorReply: async () => { errorReplyCalls++; },
  });
  await assert.rejects(() => createDispatcher(deps).dispatch('G@g.us', msg(), { id: 1 }));
  assert.equal(errorReplyCalls, 0);
});

test('default (no-op) authDisabledGate does not crash the error or success paths', async () => {
  const errDeps = mkDeps({ pmSend: async () => { throw Object.assign(new Error('x'), { code: 'AUTH_DISABLED' }); } });
  await assert.rejects(() => createDispatcher(errDeps).dispatch('G@g.us', msg(), { id: 1 }));

  const okDeps = mkDeps({ pmSend: async () => ({ alreadyDelivered: true }) });
  await createDispatcher(okDeps).dispatch('G@g.us', msg(), { id: 2 });
});

test('a non-AUTH_DISABLED turn failure does not call authDisabledGate.onFailure', async () => {
  let failureCalls = 0;
  const deps = mkDeps({
    pmSend: async () => { throw new Error('boom'); },
    authDisabledGate: { onFailure: () => { failureCalls++; }, onSuccess: () => {} },
  });
  await assert.rejects(() => createDispatcher(deps).dispatch('G@g.us', msg(), { id: 1 }));
  assert.equal(failureCalls, 0);
});

test('a bug in authDisabledGate.onFailure itself must not replace the real turn error', async () => {
  const originalErr = Object.assign(new Error('disabled Claude subscription access'), { code: 'AUTH_DISABLED' });
  const deps = mkDeps({
    pmSend: async () => { throw originalErr; },
    authDisabledGate: { onFailure: () => { throw new Error('bug inside the gate'); }, onSuccess: () => {} },
  });
  await assert.rejects(
    () => createDispatcher(deps).dispatch('G@g.us', msg(), { id: 1 }),
    (e) => e === originalErr,
    'dispatch() must still reject with the real turn error, not whatever the gate threw',
  );
});

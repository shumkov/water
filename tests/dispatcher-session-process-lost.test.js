'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../lib/handlers/dispatcher');
const { classify } = require('../lib/error/classify');

const SESSION_KEY = 'G@g.us';

function message(msgId) {
  return {
    chatJid: SESSION_KEY,
    chatType: 'group',
    msgId,
    sender: { pushName: 'A', jid: '5@lid' },
  };
}

test('SESSION_PROCESS_LOST clears before guidance, never continues, and the next dispatch starts fresh', async () => {
  let storedSessionId = 'old-session';
  let sendCalls = 0;
  const spawnContexts = [];
  const sequence = [];
  const lost = Object.assign(new Error('contained process tree exited'), {
    code: 'SESSION_PROCESS_LOST',
  });

  const dispatcher = createDispatcher({
    pm: {
      procs: new Map(),
      getOrSpawn: async (_sessionKey, ctx) => { spawnContexts.push(ctx); },
      send: async () => {
        sendCalls += 1;
        if (sendCalls === 1) throw lost;
        return { alreadyDelivered: true };
      },
    },
    sessions: {
      resolveForSpawn: () => storedSessionId,
      persist: () => {},
      clearSession: (sessionKey) => {
        assert.equal(sessionKey, SESSION_KEY);
        storedSessionId = null;
        sequence.push('clear');
      },
    },
    status: {
      markDispatched: () => {},
      markReplied: () => {},
      markFailed: () => {},
      recordTurnMetric: () => {},
    },
    resolveChat: () => ({ cwd: '/tmp' }),
    defaults: {},
    classify,
    errorReply: async (_msg, text) => {
      assert.equal(storedSessionId, null, 'the stale session must be gone before guidance');
      sequence.push('guidance');
      assert.match(text, /resend/i);
      assert.match(text, /fresh session/i);
    },
    logger: { error() {}, warn() {}, log() {} },
  });

  await assert.rejects(
    () => dispatcher.dispatch(SESSION_KEY, message('M1'), { id: 1 }),
    (err) => err === lost,
  );
  assert.equal(sendCalls, 1, 'process loss must not trigger an automatic continuation');
  assert.deepEqual(sequence, ['clear', 'guidance']);

  await dispatcher.dispatch(SESSION_KEY, message('M2'), { id: 2 });
  assert.equal(sendCalls, 2, 'only the explicit next dispatch starts another turn');
  assert.equal(spawnContexts[0].existingSessionId, 'old-session');
  assert.equal(
    spawnContexts[1].existingSessionId,
    null,
    'the next process spawn must omit the stale --resume session id',
  );
});

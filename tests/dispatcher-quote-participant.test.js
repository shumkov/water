'use strict';

// The reply tool quotes the user's message, which needs BOTH the source stanza id and the
// author's participant JID. This pins that the dispatcher puts the participant into the turn
// context (so orchestra can carry it to the reply tool) — and that a synthetic sender with
// no routable JID is NOT propagated (which would build a quote WuzAPI rejects).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../lib/handlers/dispatcher');

function mkDeps({ pmSend }) {
  return {
    pm: { getOrSpawn: async () => {}, send: pmSend, procs: new Map() },
    sessions: { resolveForSpawn: () => null, persist: () => {} },
    status: {
      markDispatched: () => {}, markReplied: () => {}, markFailed: () => {},
      recordTurnMetric: () => {},
    },
    resolveChat: () => ({ cwd: '/tmp' }),
    defaults: {},
    feedback: { begin: () => ({ end() {} }) },
    logger: { error() {}, warn() {}, log() {} },
  };
}
const msgFrom = (jid) => ({ chatJid: 'G@g.us', chatType: 'group', msgId: 'M1', sender: { pushName: 'A', jid } });

test('real group sender: participantJid + sourceMsgId reach the turn context (so the reply can quote)', async () => {
  let ctx = null;
  const deps = mkDeps({ pmSend: async (_sk, _p, opts) => { ctx = opts?.context; return { alreadyDelivered: true }; } });
  await createDispatcher(deps).dispatch('G@g.us', msgFrom('5@lid'), { id: 1 });
  assert.equal(ctx.sourceMsgId, 'M1');
  assert.equal(ctx.participantJid, '5@lid', 'the author JID is carried as the quote participant');
});

test('phone-form sender is carried verbatim (no LID/PN normalization)', async () => {
  let ctx = null;
  const deps = mkDeps({ pmSend: async (_sk, _p, opts) => { ctx = opts?.context; return { alreadyDelivered: true }; } });
  await createDispatcher(deps).dispatch('G@g.us', msgFrom('49999@s.whatsapp.net'), { id: 1 });
  assert.equal(ctx.participantJid, '49999@s.whatsapp.net');
});

test('synthetic sender (cron/inject, no routable JID) does NOT carry a participant → reply stays unquoted', async () => {
  let ctx = null;
  const deps = mkDeps({ pmSend: async (_sk, _p, opts) => { ctx = opts?.context; return { alreadyDelivered: true }; } });
  await createDispatcher(deps).dispatch('G@g.us', msgFrom('water:inject'), { id: 1 });
  assert.equal(ctx.sourceMsgId, 'M1', 'sourceMsgId is unchanged');
  assert.equal(ctx.participantJid, undefined, 'no participant for a non-JID sender (guards against a quote WuzAPI would reject)');
});

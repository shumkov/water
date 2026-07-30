'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createShutdownBarrier } = require('../lib/ops/shutdown-barrier');

test('fence snapshots admitted work, rejects new work, and reports durable completion cleanly', async () => {
  const barrier = createShutdownBarrier();
  const token = barrier.admit({ kind: 'webhook', owner: 'chat' });
  assert.ok(token);
  assert.equal(barrier.count(), 1);

  const snapshot = barrier.fence();
  assert.equal(barrier.admit({ kind: 'ipc', owner: 'other' }), null);
  token.complete('delivered');

  assert.deepEqual(
    await barrier.wait(snapshot, { timeoutMs: 50 }),
    { clean: true, timedOut: false, admitted: 1, completed: 1, rejected: 0 },
  );
});

test('a rejected or ambiguous admitted token makes the barrier crash-like', async () => {
  for (const disposition of ['rejected', 'ambiguous']) {
    const barrier = createShutdownBarrier();
    const token = barrier.admit({ kind: 'turn' });
    const snapshot = barrier.fence();
    token.fail(disposition);
    const result = await barrier.wait(snapshot, { timeoutMs: 50 });
    assert.equal(result.clean, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.rejected, 1);
  }
});

test('an unfinished admitted token times out crash-like', async () => {
  const barrier = createShutdownBarrier();
  barrier.admit({ kind: 'timer' });
  const result = await barrier.wait(barrier.fence(), { timeoutMs: 10 });
  assert.equal(result.clean, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.completed, 0);
});

'use strict';

const CLEAN_DISPOSITIONS = new Set([
  'delivered',
  'intentional-no-reply',
  'durable-terminal',
  'timer-complete',
  'ipc-delivered',
]);

function createShutdownBarrier() {
  let fenced = false;
  const active = new Set();

  function admit({ kind = 'work', owner = null, rowId = null } = {}) {
    if (fenced) return null;

    let settle;
    let settled = false;
    let taintedReason = null;
    const done = new Promise((resolve) => { settle = resolve; });
    const token = {
      kind,
      owner,
      rowId,
      startedAt: Date.now(),
      done,
      taint(reason = 'rejected') {
        if (settled) return false;
        taintedReason = String(reason);
        return true;
      },
      isTainted: () => taintedReason !== null,
      complete(disposition) {
        if (settled) return false;
        if (!CLEAN_DISPOSITIONS.has(disposition)) {
          throw new TypeError(`shutdown token has no durable terminal disposition: ${disposition}`);
        }
        settled = true;
        active.delete(token);
        settle(taintedReason === null
          ? { clean: true, disposition }
          : { clean: false, disposition: taintedReason });
        return true;
      },
      fail(reason = 'rejected') {
        if (settled) return false;
        settled = true;
        active.delete(token);
        settle({ clean: false, disposition: String(reason) });
        return true;
      },
    };
    active.add(token);
    return token;
  }

  function fence() {
    fenced = true;
    return [...active];
  }

  async function wait(snapshot, { timeoutMs = 300_000 } = {}) {
    const tokens = Array.isArray(snapshot) ? snapshot : [];
    if (tokens.length === 0) {
      return { clean: true, timedOut: false, admitted: 0, completed: 0, rejected: 0 };
    }

    let timeout = null;
    const timeoutResult = new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      timeout.unref?.();
    });
    const settlement = Promise.all(tokens.map((token) => token.done))
      .then((results) => ({ timedOut: false, results }));
    const outcome = await Promise.race([settlement, timeoutResult]);
    if (timeout) clearTimeout(timeout);

    if (outcome.timedOut) {
      return {
        clean: false,
        timedOut: true,
        admitted: tokens.length,
        completed: 0,
        rejected: 0,
      };
    }
    const completed = outcome.results.filter((result) => result.clean).length;
    const rejected = outcome.results.length - completed;
    return {
      clean: rejected === 0,
      timedOut: false,
      admitted: tokens.length,
      completed,
      rejected,
    };
  }

  return {
    admit,
    fence,
    wait,
    isFenced: () => fenced,
    count: () => active.size,
    hasActiveOwner: (owner) => [...active].some((token) => token.owner === owner),
  };
}

module.exports = { createShutdownBarrier, CLEAN_DISPOSITIONS };

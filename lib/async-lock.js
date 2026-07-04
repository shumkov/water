// provenance: polygram@0.17.11 lib/async-lock.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Per-key chain lock. Each acquire() returns a release function; the next
 * acquire() awaits the previous one's release.
 *
 * Used by polygram to serialise stdin writes per session. Pre-work
 * (attachment download, voice transcription, prompt formatting) runs
 * concurrently; only the stdin write itself is serialised so Claude
 * reads messages in arrival order and replies come out in the same
 * order.
 *
 * Deliberately minimal — no timeouts, no cancellation, no fairness
 * guarantees beyond FIFO. Callers are expected to ALWAYS call release,
 * even on error paths, or the lock leaks (blocks all future acquires
 * for that key forever).
 */

function createAsyncLock() {
  const chains = new Map(); // key → Promise of last release

  return {
    async acquire(key) {
      const prev = chains.get(key) || Promise.resolve();
      let release;
      const next = new Promise((resolve) => { release = resolve; });
      // Save the chain-entry promise so the cleanup branch can compare
      // against the SAME reference. Pre-fix this re-evaluated
      // `prev.then(() => next)` (a fresh promise each call), so the
      // === compare was always false and the Map leaked one entry per
      // unique key.
      const myEntry = prev.then(() => next);
      chains.set(key, myEntry);
      await prev;
      // Return a wrapper that also clears the chain entry when this is
      // the last holder — avoids the Map growing unbounded across the
      // lifetime of the process. Idempotent: a double-release call is
      // harmless (release() is a Promise resolver; calling resolve
      // twice is a no-op).
      return () => {
        if (chains.get(key) === myEntry) {
          chains.delete(key);
        }
        release();
      };
    },
    get size() { return chains.size; },
  };
}

module.exports = { createAsyncLock };

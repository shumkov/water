// provenance: polygram@0.17.11 lib/tmux/poll-scheduler.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * PollScheduler — shared tick generator for TmuxProcess polling loops.
 *
 * Each in-flight tmux turn polls `tmux capture-pane` every ~250ms to
 * detect READY / STREAMING / approval-prompt state changes. Without
 * coordination, N concurrent in-flight chats run N independent
 * `setTimeout` chains. PollScheduler collapses these into a SINGLE
 * `setInterval` whose firing wakes all registered waiters at once.
 *
 * Wins:
 *   - One timer regardless of how many tmux chats are running.
 *   - Tick-aligned bursts: all capture-pane subprocess spawns happen
 *     in the same JS turn, then the loop idles until the next tick.
 *     Linux/macOS handle bursty fork+exec better than smeared.
 *   - Single shutdown point — `release()` from each process cleanly
 *     stops the timer when nothing is in flight.
 *
 * Usage:
 *   const sched = new PollScheduler({ intervalMs: 250 });
 *   await proc.send(...);   // internally calls:
 *   //   sched.acquire();
 *   //   while (not done) { ...; await sched.waitTick(); }
 *   //   sched.release();
 *
 * Each `waitTick()` returns a Promise that resolves at the NEXT tick.
 * Multiple waiters on the same tick all resolve simultaneously.
 */

'use strict';

class PollScheduler {
  /**
   * @param {object} [opts]
   * @param {number} [opts.intervalMs=250]  — global poll cadence
   */
  constructor({ intervalMs = 250 } = {}) {
    this.intervalMs = intervalMs;
    this._timer = null;
    this._refCount = 0;
    this._waiters = new Set();
  }

  /**
   * Register a polling lifetime. Increments refCount and starts the
   * shared interval if not already running. Pair every acquire() with
   * a release() in a try/finally.
   */
  acquire() {
    this._refCount++;
    if (!this._timer) {
      this._timer = setInterval(() => this._tick(), this.intervalMs);
      // Don't keep the event loop alive solely for polling. The
      // polygram daemon has many other refs (Telegram, IPC, the tmux
      // sessions themselves) keeping it up.
      this._timer.unref?.();
    }
  }

  /**
   * Drop a polling lifetime. When refCount hits zero we stop the
   * interval AND resolve any lingering waiters so their loops can
   * exit cleanly (e.g. process killed mid-tick).
   */
  release() {
    if (this._refCount <= 0) return;
    this._refCount--;
    if (this._refCount === 0 && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      // Wake any leftover waiters so their polling loops can observe
      // closed state and exit.
      this._drainWaiters();
    }
  }

  /**
   * Resolves at the next scheduler tick. Cheap — no setTimeout
   * allocation per call, just a Set insertion. Caller MUST have
   * called acquire() before its first waitTick() and call release()
   * after its last.
   */
  waitTick() {
    return new Promise((resolve) => {
      this._waiters.add(resolve);
    });
  }

  /**
   * Number of registered polling lifetimes (active in-flight turns).
   * Useful for observability + tests.
   */
  get activeCount() {
    return this._refCount;
  }

  _tick() {
    this._drainWaiters();
  }

  _drainWaiters() {
    if (this._waiters.size === 0) return;
    const fns = [...this._waiters];
    this._waiters.clear();
    for (const fn of fns) {
      try { fn(); } catch { /* swallow */ }
    }
  }
}

module.exports = { PollScheduler };

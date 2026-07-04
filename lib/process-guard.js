// provenance: polygram@0.17.11 lib/process-guard.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * rc.50: process-guard helpers — orphan-detection PID file + safety
 * handlers for uncaughtException / unhandledRejection that don't
 * re-enter on broken stdout.
 *
 * Background — the rc.50 incident:
 *   PID 6335 (rc.48) was orphaned when its tmux pane was destroyed
 *   during `launchctl kickstart -k`. polygram's existing SIGHUP
 *   handler should have drained cleanly, but during the drain
 *   `console.error` inside the uncaughtException handler itself
 *   threw EIO (stdout was wired to a now-destroyed pty). That fired
 *   the same handler, which logged again, which threw EIO again — a
 *   tight re-entrant loop that hijacked the event loop and prevented
 *   shutdown from completing. The orphan ran for 3+ hours writing
 *   3.59M+ uncaught-exception rows to the DB at ~12k/sec, and
 *   polled the same Telegram bot token in parallel with the new
 *   daemon.
 *
 * This module provides three primitives. polygram.js wires them
 * together at boot.
 */

'use strict';

const fs = require('fs');

/**
 * Boot-time orphan detection. Writes our PID to `pidPath`. If the
 * file already exists with a different live PID, kill it before
 * proceeding (SIGTERM, then SIGKILL after `sigtermWaitMs`). Without
 * this, two daemons can end up sharing the same Telegram bot token
 * and SQLite DB — the cascade that made the rc.50 incident
 * production-visible.
 *
 * @returns {{ priorPid: number|null, priorAction: string }}
 */
function claimPidFile(pidPath, { logger = console, sigtermWaitMs = 2000 } = {}) {
  const ownPid = process.pid;
  let priorPid = null;
  let priorAction = 'no-prior';

  if (fs.existsSync(pidPath)) {
    const raw = (() => {
      try { return fs.readFileSync(pidPath, 'utf8').trim(); }
      catch { return ''; }
    })();
    const parsed = /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
    if (!parsed) {
      priorAction = 'malformed-overwritten';
    } else if (parsed === ownPid) {
      // Re-entrant call from same process — write but don't kill self.
      priorPid = parsed;
      priorAction = 'self-skip';
    } else {
      priorPid = parsed;
      const alive = isAlive(parsed);
      if (!alive) {
        priorAction = 'stale-overwritten';
      } else {
        logger.log?.(`[orphan-guard] prior daemon PID ${parsed} still alive — sending SIGTERM`);
        try { process.kill(parsed, 'SIGTERM'); } catch {}
        const start = Date.now();
        while (Date.now() - start < sigtermWaitMs && isAlive(parsed)) {
          // Busy-wait. Boot is single-threaded; we have nothing else to do
          // until the orphan is gone, and we don't want to bind the bot
          // token while it's still polling. sigtermWaitMs is configurable
          // (default 2s; tests override to 100ms).
          sleepSync(50);
        }
        if (isAlive(parsed)) {
          logger.log?.(`[orphan-guard] PID ${parsed} ignored SIGTERM — escalating to SIGKILL`);
          try { process.kill(parsed, 'SIGKILL'); } catch {}
          // Poll for actual death — SIGKILL is delivered async, the
          // kernel may take a tick to reap (esp. for detached children).
          const killStart = Date.now();
          while (Date.now() - killStart < 1000 && isAlive(parsed)) {
            sleepSync(20);
          }
          priorAction = 'sigkill-killed';
        } else {
          priorAction = 'sigterm-killed';
        }
      }
    }
  }

  fs.writeFileSync(pidPath, String(ownPid) + '\n', { mode: 0o600 });
  return { priorPid, priorAction };
}

/**
 * Delete the PID file on clean shutdown. Only deletes if the file
 * still contains OUR PID — protects against the race where a new
 * daemon already claimed the file and rewrote it before we got here.
 */
function releasePidFile(pidPath) {
  if (!fs.existsSync(pidPath)) return;
  try {
    const content = fs.readFileSync(pidPath, 'utf8').trim();
    if (content === String(process.pid)) {
      fs.unlinkSync(pidPath);
    }
    // Else: another daemon owns it now. Leaving alone is correct.
  } catch {}
}

/**
 * Build an uncaughtException handler that:
 *   1. Wraps `logger.error` AND `logEvent` in try/catch — neither
 *      can re-throw out of the handler. (Pre-rc.50 the bare
 *      console.error threw EIO and re-fired this same handler in
 *      an event-loop-hijacking loop.)
 *   2. Tracks repetitions of the same exception message in a sliding
 *      window. If the same message fires `eioThreshold` times within
 *      `eioWindowMs`, calls `panicExit(2)` so launchd restarts us
 *      cleanly. Without the circuit breaker, a stuck-stdout EIO
 *      cascade just keeps writing rows forever.
 *
 * @param {object} opts
 * @param {object} opts.logger - { error(msg) } sink for human-readable logs.
 * @param {function(string, object)} opts.logEvent - DB persist sink.
 * @param {string} opts.botName
 * @param {number} [opts.eioThreshold=100]
 * @param {number} [opts.eioWindowMs=5000]
 * @param {function(number)} [opts.panicExit=process.exit]
 * @param {function(): number} [opts.now=Date.now]
 * @returns {function(Error)}
 */
function _makeUncaughtHandler({
  logger,
  logEvent,
  botName,
  eioThreshold = 100,
  eioWindowMs = 5000,
  panicExit = (code) => process.exit(code),
  now = Date.now,
} = {}) {
  // Per-message sliding-window timestamps. Map<message, number[]>.
  const recent = new Map();
  let panicked = false;

  return function uncaughtHandler(err) {
    if (panicked) return; // bail — we're on our way out
    const msg = String(err?.message || err || 'unknown').slice(0, 500);
    const stack = err?.stack?.split('\n').slice(0, 5).join('\n') || '';

    // 1. Log defensively. Stdout may be broken (the original incident);
    //    must not re-throw out of this handler.
    try {
      logger?.error?.(`[polygram] uncaughtException: ${msg}\n${stack}`);
    } catch { /* swallow — broken stdout */ }

    // 2. Persist defensively. DB might be closing during shutdown.
    try {
      logEvent?.('uncaught-exception', { message: msg, bot_name: botName });
    } catch { /* swallow */ }

    // 3. Storm circuit breaker: same message N times in window → exit.
    const t = now();
    let timestamps = recent.get(msg);
    if (!timestamps) { timestamps = []; recent.set(msg, timestamps); }
    timestamps.push(t);
    // Drop expired.
    while (timestamps.length && t - timestamps[0] > eioWindowMs) timestamps.shift();
    if (timestamps.length >= eioThreshold) {
      panicked = true;
      try {
        logger?.error?.(`[polygram] uncaughtException circuit breaker: ${timestamps.length}× "${msg}" in ${eioWindowMs}ms — exit(2)`);
      } catch {}
      try {
        logEvent?.('panic-exit', { message: msg, count: timestamps.length, window_ms: eioWindowMs, bot_name: botName });
      } catch {}
      panicExit(2);
    }
  };
}

// Build a parallel handler for unhandledRejection: same defensive
// posture, separate counter (rejections and exceptions can come
// from different code paths and shouldn't share a budget).
function _makeUnhandledRejectionHandler(opts) {
  const inner = _makeUncaughtHandler({
    ...opts,
    // Override the 'kind' written to events table.
    logEvent: opts.logEvent
      ? (kind, detail) => opts.logEvent(kind === 'panic-exit' ? 'panic-exit' : 'unhandled-rejection', detail)
      : undefined,
  });
  return (reason /* , promise */) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    inner(err);
  };
}

/**
 * Swallow EPIPE/EIO on the process's own stdout/stderr so a broken pipe during
 * shutdown can't become an uncaughtException.
 *
 * rc.50 stopped the re-entrant LOOP (the handler no longer re-throws), but the
 * write errors themselves still surface: when `launchctl kickstart` destroys the
 * tmux pane, in-flight `console.log`/`console.error` calls hit a now-dead pty.
 * Because stdout/stderr are TTYs, those writes throw EIO **synchronously** — each
 * unguarded throw becomes an uncaughtException. Observed live on the rc.29→rc.30
 * restart (2026-06-08): 100 `write EIO` rows then a circuit-breaker panic-exit on
 * every deploy, interrupting the graceful drain.
 *
 * This guards BOTH delivery paths:
 *   (a) sync: wraps `write()` to drop EPIPE/EIO throws (TTY case — the real one);
 *   (b) async: attaches an `error` listener for the pipe case (errors arrive as
 *       events). Genuine, non-EPIPE/EIO errors still surface unchanged.
 *
 * @returns {{ uninstall: function() }}
 */
function guardStdio({ streams = [process.stdout, process.stderr] } = {}) {
  const guarded = streams.filter(Boolean);
  const isBrokenPipe = (err) => err && (err.code === 'EPIPE' || err.code === 'EIO');
  const onError = (err) => { if (isBrokenPipe(err)) return; throw err; };
  const restores = [];

  for (const s of guarded) {
    s.on?.('error', onError);
    restores.push(() => s.off?.('error', onError));

    if (typeof s.write === 'function' && !s.__polygramStdioGuarded) {
      const origWrite = s.write;
      s.write = function guardedWrite(...args) {
        try {
          return origWrite.apply(this, args);
        } catch (err) {
          if (!isBrokenPipe(err)) throw err;
          // Pane is gone — nothing to write to. Invoke the write callback (the
          // last arg, if any) so callers awaiting it don't hang, and report
          // backpressure (false) instead of throwing to uncaughtException.
          const cb = args[args.length - 1];
          if (typeof cb === 'function') { try { cb(err); } catch { /* ignore */ } }
          return false;
        }
      };
      s.__polygramStdioGuarded = true;
      restores.push(() => { s.write = origWrite; delete s.__polygramStdioGuarded; });
    }
  }

  return { uninstall() { for (const r of restores) r(); } };
}

/**
 * Convenience: install both handlers in one call (plus the stdio guard, so the
 * shutdown broken-pipe writes never reach the uncaughtException handler).
 * @returns {{ uninstall: function() }}
 */
function installSafetyHandlers(opts) {
  const onException = _makeUncaughtHandler(opts);
  const onRejection = _makeUnhandledRejectionHandler(opts);
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  const stdio = guardStdio();
  return {
    uninstall() {
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onRejection);
      stdio.uninstall();
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but we lack rights
    // (treat as alive — same UID typically; we will fail to kill it
    // but at least we know it's there).
    if (err.code === 'EPERM') return true;
    return false;
  }
}

function sleepSync(ms) {
  // Atomics-based busy-wait. 50ms granularity is fine for boot
  // orphan-killing; we're not in a hot path.
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

module.exports = {
  claimPidFile,
  releasePidFile,
  installSafetyHandlers,
  guardStdio,
  _makeUncaughtHandler,
  _makeUnhandledRejectionHandler,
};

// provenance: polygram@0.17.11 lib/tmux/startup-gate.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * runStartupGate — generic helper for "spawn a tmux'd TUI and wait until
 * it's accepting input, sending Enter for known transient dialogs along
 * the way".
 *
 * Extracted from CliProcess._handleStartupDialogs (M1 follow-on
 * refactor). Made caller-agnostic so future TmuxProcess flows that need
 * to navigate trust / dev-channels / approval-mode prompts can reuse
 * it without duplicating the poll loop.
 *
 * Loop semantics:
 *   - capture-pane every `pollMs` (default 300ms)
 *   - if any trigger regex matches AND its `name` hasn't been seen, send
 *     the trigger's `key` (typically 'Enter') via runner.sendControl
 *   - after each send, wait `settleMs` (default 500ms) for the TUI to
 *     transition out of the dialog before the next poll
 *   - if `readySignal` regex matches the captured pane content, resolve
 *   - if `Date.now()` exceeds the deadline, throw with `err.code = timeoutCode`
 *
 * Progress-aware (stall) deadline — `stallMs`:
 *   The blind wall-clock `deadlineMs` can't tell "claude is mid-download
 *   (24% progress bar, genuinely working)" from "claude is wedged". The
 *   shumorobot General incident (2026-05-30) killed a cold-spawn that was
 *   actively downloading the runtime. When `stallMs` is set, the gate
 *   tracks pane ACTIVITY: any change in captured pane content — or a
 *   trigger key being sent — resets a stall clock. The gate fails early
 *   (with `timeoutCode`) only after `stallMs` elapses with NO activity,
 *   i.e. the pane is frozen. `deadlineMs` remains an absolute backstop so
 *   a pane that animates forever but never reaches `readySignal` still
 *   terminates. When `stallMs` is omitted (default), behavior is the pure
 *   `deadlineMs` wall-clock exactly as before.
 *
 * Each trigger is one-shot per gate run (tracked by `name` in a Set).
 *
 * Caller supplies:
 *   - runner: object with `captureWide(tmuxName)` and `sendControl(tmuxName, key)`
 *   - triggers: [{name, regex, key}] — order matters; first match wins
 *   - readySignal: RegExp matching the "TUI is ready, no more dialogs" pane text
 *   - deadlineMs, pollMs, settleMs — timeouts
 *   - timeoutCode: err.code on deadline expiry (default 'TUI_STARTUP_TIMEOUT')
 *   - logger, label — for diagnostic prose
 */

'use strict';

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_POLL_MS = 300;
const DEFAULT_SETTLE_MS = 500;

/**
 * @param {object} opts
 * @param {object} opts.runner                — tmux runner with captureWide + sendControl
 * @param {string} opts.tmuxName              — tmux session name to poll
 * @param {Array<{name:string, regex:RegExp, key:string}>} opts.triggers
 * @param {RegExp} opts.readySignal           — match → resolve
 * @param {number} [opts.deadlineMs=30000]    — absolute backstop
 * @param {number} [opts.stallMs]             — if set, fail after this much
 *   wall-clock with NO pane activity (progress-aware). Omit for pure
 *   wall-clock behavior.
 * @param {number} [opts.pollMs=300]
 * @param {number} [opts.settleMs=500]
 * @param {string} [opts.timeoutCode='TUI_STARTUP_TIMEOUT']
 * @param {Function} [opts.onTrigger]          — (name) => void, called AT FIRE
 *   TIME (not gate resolution). Telemetry hung off the success-path return
 *   misses the matched-then-died sequence (2026-06-10 prod: gate matched
 *   session-age, then TMUX_SESSION_GONE). Errors are swallowed.
 * @param {object} [opts.logger=console]
 * @param {string} [opts.label='startup-gate']
 * @returns {Promise<{matchedTriggers: string[], elapsedMs: number}>}
 */
async function runStartupGate({
  runner,
  tmuxName,
  triggers = [],
  readySignal,
  deadlineMs = DEFAULT_DEADLINE_MS,
  stallMs,
  pollMs = DEFAULT_POLL_MS,
  settleMs = DEFAULT_SETTLE_MS,
  timeoutCode = 'TUI_STARTUP_TIMEOUT',
  onTrigger = null,
  logger = console,
  label = 'startup-gate',
} = {}) {
  if (!runner || typeof runner.captureWide !== 'function' || typeof runner.sendControl !== 'function') {
    throw new TypeError('runStartupGate: runner must have captureWide + sendControl');
  }
  if (!tmuxName) throw new TypeError('runStartupGate: tmuxName required');
  if (!(readySignal instanceof RegExp)) {
    throw new TypeError('runStartupGate: readySignal must be a RegExp');
  }

  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  const stallEnabled = Number.isFinite(stallMs) && stallMs > 0;
  const seen = new Set();
  const matchedTriggers = [];
  // rc.4: remember the most recent successful pane snapshot. If the gate
  // fails (deadline OR session-gone), include the snapshot in the error
  // so we can see what the TUI last printed before claude exited. Without
  // this, "claude exits code 0 after dev-channels Enter" surfaces as a
  // 30-second `can't find pane` spam with no diagnostic about WHY.
  let lastPane = null;
  // Progress-aware gate: timestamp of the last observed pane CHANGE (or
  // trigger send). Only consulted when stallEnabled.
  let lastActivityAt = startedAt;
  // Music incident (2026-06-01): the stall timer must NOT arm while the pane
  // is still BLANK. A blank-and-unchanging pane means claude hasn't started
  // rendering yet (slow cold-start), NOT that it wedged — the TUI for some
  // topics takes 30-45s to first-render. Arming the stall timer on a blank
  // pane killed a legitimate slow spawn at stallMs with a false "wedged".
  // So the stall clock only runs once the pane has shown non-whitespace
  // content; before that, only the absolute `deadlineMs` governs.
  let sawContent = false;

  while (Date.now() < deadline) {
    // Stall check (progress-aware): the pane RENDERED something and has then
    // been static for stallMs → genuinely wedged. Gated on sawContent so a
    // blank cold-start isn't mistaken for a wedge. Fires early so a truly
    // hung TUI fails fast, while an actively-progressing one (download bar,
    // dialog navigation) keeps resetting lastActivityAt below.
    if (stallEnabled && sawContent && Date.now() - lastActivityAt >= stallMs) {
      const err = new Error(
        `[${label}] startup gate: pane rendered then went static for ${stallMs}ms for ${tmuxName} ` +
        `(matched: ${matchedTriggers.length ? matchedTriggers.join(', ') : 'none'}). ` +
        `Appears wedged. Last pane content:\n` +
        _formatPaneTail(lastPane),
      );
      err.code = timeoutCode;
      err.lastPane = lastPane;
      err.matchedTriggers = matchedTriggers;
      err.reason = 'stall';
      throw err;
    }
    let pane;
    try {
      pane = await runner.captureWide(tmuxName);
    } catch (err) {
      // rc.4: detect "can't find pane" / "no server" — tmux session died
      // (claude exited, killed the bash that hosted it, tmux tore down the
      // pane). Fast-fail with a distinct code instead of spinning for the
      // full deadline. Pattern matches the actual tmux capture-pane errors:
      //   - "can't find pane: <name>"     (session/pane gone after spawn)
      //   - "no server running"           (entire tmux server gone)
      const msg = err?.message || '';
      if (/can't find (pane|session)|no server running|session not found/i.test(msg)) {
        const goneErr = new Error(
          `[${label}] tmux session disappeared for ${tmuxName} after ${Date.now() - startedAt}ms ` +
          `(matched: ${matchedTriggers.length ? matchedTriggers.join(', ') : 'none'}). ` +
          `claude likely exited; last pane content:\n` +
          _formatPaneTail(lastPane),
        );
        goneErr.code = 'TMUX_SESSION_GONE';
        goneErr.lastPane = lastPane;
        goneErr.matchedTriggers = matchedTriggers;
        throw goneErr;
      }
      logger.warn?.(`[${label}] captureWide failed: ${msg}`);
      await new Promise(r => setTimeout(r, settleMs));
      continue;
    }
    // First non-whitespace content = the TUI has started rendering. Only
    // from here does the stall timer become meaningful (before this, a blank
    // pane is cold-start, governed by the absolute deadline). Seed
    // lastActivityAt at the moment content first appears so the stall window
    // is measured from "rendered", not from spawn.
    if (!sawContent && pane && pane.trim().length > 0) {
      sawContent = true;
      lastActivityAt = Date.now();
    }
    // Progress signal: any change in pane content is activity → reset the
    // stall clock. A captureWide that returns the SAME bytes is NOT
    // activity (a frozen download bar at 24% reads identically each poll).
    if (pane !== lastPane) lastActivityAt = Date.now();
    lastPane = pane;

    // Walk triggers in declaration order — first match (and not yet seen) wins
    let matched = false;
    for (const trigger of triggers) {
      if (seen.has(trigger.name)) continue;
      if (!trigger.regex.test(pane)) continue;
      // `keys: [...]` sends a sequence (dialog navigation — e.g. Down,Enter
      // to pick a non-default option); `key:` remains the single-key form.
      // Sequence keys go as separate send-keys calls with a short delay —
      // Ink dialogs can swallow the second key of a same-batch sequence.
      const keySeq = Array.isArray(trigger.keys) ? trigger.keys : [trigger.key];
      for (let ki = 0; ki < keySeq.length; ki++) {
        if (ki > 0) await new Promise(r => setTimeout(r, Math.min(settleMs, 120)));
        try {
          await runner.sendControl(tmuxName, keySeq[ki]);
        } catch (err) {
          logger.warn?.(`[${label}] sendControl(${keySeq[ki]}) failed for trigger=${trigger.name}: ${err.message}`);
        }
      }
      seen.add(trigger.name);
      matchedTriggers.push(trigger.name);
      try { onTrigger?.(trigger.name); } catch { /* telemetry must not break the gate */ }
      matched = true;
      // Sending a key is activity — navigating the TUI counts as progress
      // even if the pre-transition pane text was static (e.g. a dialog we
      // just answered). Reset the stall clock so we don't fail mid-nav.
      lastActivityAt = Date.now();
      // Settle window so the TUI transitions out of the dialog before next poll
      await new Promise(r => setTimeout(r, settleMs));
      break;
    }
    if (matched) continue;

    if (readySignal.test(pane)) {
      return { matchedTriggers, elapsedMs: Date.now() - startedAt };
    }

    await new Promise(r => setTimeout(r, pollMs));
  }

  const err = new Error(
    `[${label}] startup gate did not resolve within ${deadlineMs}ms for ${tmuxName} ` +
    `(matched: ${matchedTriggers.length ? matchedTriggers.join(', ') : 'none'}). ` +
    `Last pane content:\n` +
    _formatPaneTail(lastPane),
  );
  err.code = timeoutCode;
  err.lastPane = lastPane;
  err.matchedTriggers = matchedTriggers;
  throw err;
}

/**
 * Render the last ~800 chars of pane content for inclusion in error messages.
 * Truncate at line boundaries when possible so the diagnostic isn't visually
 * mangled. Returns "(no pane content ever captured)" for null/undefined.
 */
function _formatPaneTail(pane) {
  if (!pane) return '  (no pane content ever captured — claude exited before first captureWide)';
  const MAX = 800;
  const text = String(pane);
  if (text.length <= MAX) return text.split('\n').map(l => '  ' + l).join('\n');
  // Take last MAX chars, then trim to a line boundary if one exists nearby
  let tail = text.slice(-MAX);
  const nl = tail.indexOf('\n');
  if (nl > 0 && nl < 80) tail = tail.slice(nl + 1);
  return '  …(truncated)…\n' + tail.split('\n').map(l => '  ' + l).join('\n');
}

module.exports = {
  runStartupGate,
  DEFAULT_DEADLINE_MS,
  DEFAULT_POLL_MS,
  DEFAULT_SETTLE_MS,
};

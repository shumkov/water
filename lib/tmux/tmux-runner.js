// provenance: polygram@0.17.11 lib/tmux/tmux-runner.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Low-level tmux wrapper used by TmuxProcess (`lib/process/tmux-process.js`).
 *
 * Pure mechanics — spawn / send / capture / kill / list. No semantics
 * about claude or polygram. TmuxProcess composes these into the
 * higher-level send-prompt / observe-turn / interrupt flow.
 *
 * Conventions:
 *   - Session names are bot-prefixed to avoid cross-bot collision
 *     on the same host: `water-<bot>-<chat>-<thread>`.
 *   - Prompt bodies go through pasteText() (sanitize + multiline
 *     separator + set-buffer/paste-buffer).
 *   - Control keys (Enter, Escape, C-c) go through sendControl()
 *     using `tmux send-keys` (no -l flag).
 *
 * Phase 0 spike findings encoded here:
 *   F-spike-1  --permission-mode acceptEdits handled by callers
 *   F-spike-3  `\n` in paste-buffer SPLITS into separate Enter
 *              presses → encode as MULTILINE_SEPARATOR before paste
 *   F-spike-4  bypassPermissions needs --dangerously-skip-permissions
 *              companion (callers add this flag pair when needed)
 *   G5b        sanitize() strips C0/DEL control bytes so a Telegram
 *              user can't inject Ctrl-C / Ctrl-D into the pty
 *
 * @see docs/0.10.0-phase0-spike-findings.md F-spike-1..4
 * @see docs/0.10.0-process-manager-abstraction-plan.md §12.4
 */

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createAsyncLock } = require('../async-lock');

// ─── Constants ───────────────────────────────────────────────────────

// Phase 0 F-spike-3: `\n` in paste-buffer triggers separate Enter
// presses in claude TUI; only the LAST line stays. Encode as a visible
// separator before paste so the full multi-line prompt arrives.
const MULTILINE_SEPARATOR = ' / ';

// G5b: strip C0/DEL bytes (0x00-0x08, 0x0b-0x1f, 0x7f) from prompt
// before send. Allows \t (0x09) and \n (0x0a) through; we handle \n
// via MULTILINE_SEPARATOR.
const CONTROL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

// 2026-05-18 incident — submit confirmation now lives in TmuxProcess.
// A ~1-2KB polygram prompt is collapsed by the claude TUI into a
// "[Pasted text #N]" placeholder; the single post-paste Enter can be
// absorbed mid-ingest, leaving the prompt unsubmitted.
//
// B5 confirmed the submit HERE by capture-pane (does the input box
// still hold the paste?). That FALSE-POSITIVED: the TUI renders the
// collapsed-paste placeholder asynchronously, so a capture-pane poll
// catches a transient frame where the placeholder is not yet visible
// and B5 wrongly concluded "submitted ✓", leaving the prompt stuck
// (3rd recurrence: shumorobot msg 803, 2026-05-19). B7 REMOVED the
// capture-pane confirm — capture-pane is an unreliable signal for a
// collapsed paste. Submission is now confirmed in `TmuxProcess` by the
// paste's correlation token surfacing in a JSONL `user-message` (the
// only reliable "the prompt reached claude" signal). The runner just
// pastes + Enter; it no longer judges whether the submit landed.

// ─── execFile wrapper ────────────────────────────────────────────────

// Every tmux invocation polygram makes — capture-pane, send-keys,
// set-buffer, paste-buffer, has-session, list-sessions, kill-session,
// and even `new-session -d` (which detaches immediately) — is a
// sub-second operation. A tmux call that runs longer than this is
// WEDGED (tmux server hung, host pathologically loaded).
//
// Without a bound, a wedged subprocess hangs the `await` forever:
// `_awaitTurnComplete`'s poll loop re-checks its deadline only
// BETWEEN `captureWide` calls, so a single hung `capture-pane` stalls
// the turn with no timeout (leftover R7). The 2026-05-18 submit-
// confirm loop has the same exposure — it capture-panes too.
//
// A per-exec timeout bounds ALL of it: a timed-out tmux call rejects
// → the caller throws → the turn fails LOUD with an error instead of
// hanging. killSignal is SIGKILL because a wedged process may ignore
// SIGTERM. 10s is generous headroom over the sub-second norm.
const TMUX_RUN_TIMEOUT_MS = 10_000;

/**
 * Promise-wrapped childProcess.execFile. Returns { stdout, stderr }.
 * Rejects on non-zero exit (or timeout) with err.stdout + err.stderr
 * attached. A default timeout + SIGKILL bound every tmux call so a
 * wedged subprocess cannot hang a turn (leftover R7); an explicit
 * `opts.timeout` still overrides.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      cmd,
      args,
      { timeout: TMUX_RUN_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Strip C0/DEL control characters. Allow \t and \n (\n is then
 * encoded to MULTILINE_SEPARATOR by pasteText below).
 */
function sanitize(text) {
  return String(text).replace(CONTROL_CHAR_RE, '');
}

/**
 * Bot-prefixed tmux session name. Replaces unsafe chars with _ so
 * the name is always a valid tmux session identifier.
 *
 * @param {string} botName
 * @param {string|number} chatId
 * @param {string|number|null} threadId
 */
function sessionName(botName, chatId, threadId) {
  const tail = threadId ? `${chatId}-${threadId}` : `${chatId}-main`;
  return `water-${botName}-${tail}`.replace(/[^\w-]/g, '_');
}

/**
 * Per-session debug-log path. Same sanitization as session name so
 * an admin typo in a topic key can't path-traverse.
 *
 * Per R2-F5 the path lives under polygram's own data dir, not /tmp.
 *
 * @param {string} botName
 * @param {string|number} chatId
 * @param {string|number|null} threadId
 * @param {string} [logsDir]  base dir; default ~/.water/<bot>/logs
 */
function debugLogPath(botName, chatId, threadId, logsDir) {
  const safeBot = String(botName).replace(/[^\w-]/g, '_');
  const tail = threadId ? `${chatId}-${threadId}` : `${chatId}-main`;
  const safeTail = String(tail).replace(/[^\w-]/g, '_');
  // SECURITY (audit M4): refuse to fall back to /tmp when HOME is
  // unset. /tmp is world-writable; a co-tenant could pre-create the
  // path as a symlink pointing at an arbitrary file, and claude's
  // --debug-file flag would follow it on open-for-append. Operators
  // running polygram must have HOME set; if not, this is a misconfig
  // that should fail loud.
  if (!logsDir && !process.env.HOME) {
    throw Object.assign(
      new Error('HOME env var unset; refusing /tmp fallback for debugLogPath'),
      { code: 'HOME_UNSET' },
    );
  }
  const base = logsDir || path.join(process.env.HOME, '.water', safeBot, 'logs');
  return path.join(base, `tmux-claude-${safeTail}.log`);
}

/**
 * Ensure the directory exists for a debug log path. Idempotent.
 */
function ensureLogDir(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
}

// ─── TmuxRunner ──────────────────────────────────────────────────────

/**
 * Construct a tmux runner. Returns an object of methods. Stateless —
 * each call is an independent tmux invocation. The shared `logger` is
 * the only injected dependency.
 *
 * Test seam: tests can stub `runner._run` to mock execFile.
 *
 * @param {object} [opts]
 * @param {object} [opts.logger=console]
 * @param {Function} [opts.runFn] — override the underlying execFile
 *   wrapper (for tests). Same signature: (cmd, args, opts?) → Promise.
 */
function createTmuxRunner({
  logger = console,
  runFn = run,
} = {}) {
  async function spawn({
    name,
    cwd,
    command,
    args = [],
    envExtras = {},
    paneWidth = 200,
  }) {
    // SECURITY (audit M5): paneWidth ends up as a CLI arg to `tmux
    // set-option`. We use execFile (no shell), so this is not a
    // shell-injection vector — but a hostile value like '-Force' or
    // a number-string with embedded options could be mis-parsed by
    // tmux. Validate it's a small positive integer.
    if (!Number.isInteger(paneWidth) || paneWidth < 20 || paneWidth > 10_000) {
      throw new TypeError(`paneWidth must be an integer in [20, 10000], got ${paneWidth}`);
    }
    const sessArgs = ['new-session', '-d', '-s', name];
    if (cwd) sessArgs.push('-c', cwd);
    for (const [k, v] of Object.entries(envExtras)) {
      sessArgs.push('-e', `${k}=${v}`);
    }
    sessArgs.push(command, ...args);
    try {
      await runFn('tmux', sessArgs);
    } catch (err) {
      throw Object.assign(new Error(`tmux spawn failed: ${err.message}`), {
        code: 'TMUX_SPAWN_FAILED',
        name,
        cause: err,
        stderr: err.stderr,
      });
    }
    // Try to widen the detached pane so claude TUI has room to render
    // long lines. `resize-window` is the supported way; older
    // attempts used a non-existent `pane-width` option that always
    // errored (tmux 3.x: pane-width is a format variable, not a
    // settable option). capture-pane -J in captureWide() handles
    // any remaining wrap artifacts.
    try {
      await runFn('tmux', ['resize-window', '-t', name, '-x', String(paneWidth)]);
    } catch (err) {
      logger.debug?.(`[tmux-runner] resize-window failed for ${name}: ${err.message} (capture-pane -J handles wrap)`);
    }
    return name;
  }

  /**
   * Send raw key sequence (Enter, Escape, C-c, etc.). NOT for prompt
   * body — use pasteText for that. send-keys without -l interprets
   * key names like "Enter" and "C-c".
   */
  async function sendControl(name, key) {
    await runFn('tmux', ['send-keys', '-t', name, key]);
  }

  // rc.13.1: paste+Enter must be ATOMIC per session. Pre-rc.13.1 two
  // concurrent pasteText+sendControl pairs could interleave in the
  // TUI's bracketed-paste buffer — Ivan caught this on shumorobot
  // 2026-05-15 (the 2233-char user JSONL entry contained one
  // truncated polygram channel + a full nested polygram prompt for
  // a different msg_id). Symptom: msg 696's paste was at byte
  // `chat_id="-1003` when msg 698's autosteer paste cut in,
  // concatenating two pastes into one TUI user message → the agent
  // saw a malformed input → the reply attribution went sideways
  // (msg 697 got msg 698's answer, msg 696 got served last).
  //
  // The async-lock is keyed by tmux session name, so different
  // sessions don't block each other. Within one session, pasteText
  // + sendControl(Enter) hold the lock atomically.
  const inputLock = createAsyncLock();
  /**
   * Paste a prompt body + press Enter, atomically per session.
   *
   * Pure mechanics: paste, Enter, a small post-Enter drain. The runner
   * does NOT judge whether the submit landed — B7 moved submit
   * confirmation to `TmuxProcess`, which confirms it via the paste's
   * correlation token surfacing in a JSONL `user-message` (the only
   * reliable signal; capture-pane false-positives on a collapsed
   * `[Pasted text #N]` placeholder).
   *
   * @param {string} name  tmux session
   * @param {string} text  prompt body
   */
  async function pasteAndEnter(name, text) {
    const release = await inputLock.acquire(name);
    try {
      const res = await pasteText(name, text);
      await sendControl(name, 'Enter');
      // L3 fix: small post-Enter drain so back-to-back
      // pasteAndEnter calls don't race in the claude TUI's input
      // handler. Pre-fix, when two injectUserMessage calls fired in
      // quick succession (spike multi-2-rapid, ~2/5 failure rate),
      // the TUI sometimes only enqueued ONE of the two pastes —
      // the second's bracketed-paste-start collided with the first
      // Enter's processing. 50ms is enough on the TUI we tested
      // against (claude v2.1.142); see AGENTS.md pinned version.
      await new Promise((r) => setTimeout(r, 50));
      return res;
    } finally {
      release();
    }
  }

  /**
   * Push a multi-line text prompt into the pane.
   *
   *   1. sanitize()  strips C0/DEL bytes (G5b)
   *   2. \n → MULTILINE_SEPARATOR  (F-spike-3)
   *   3. set-buffer + paste-buffer  (atomic; bracketed-paste-aware
   *      in modern claude TUI versions)
   *   4. brief drain delay so a subsequent send-keys (e.g. Enter) is
   *      processed as a key event by the TUI, NOT consumed as part of
   *      the paste's bracketed-paste content.
   *
   * INCIDENT (0.10.0-rc.2): without the drain delay, send-keys Enter
   * fired immediately after paste-buffer was being swallowed by
   * claude TUI's bracketed-paste handler — the paste sat in the input
   * area unsubmitted. Manual `tmux send-keys ... Enter` unstuck it.
   * 80ms is enough on macOS tmux 3.6a for the close-bracket ESC[201~
   * to land before any subsequent key arrives.
   *
   * NO Enter is sent here. Caller follows up with
   * `sendControl(name, 'Enter')` when they want to submit.
   */
  async function pasteText(name, text) {
    const sanitized = sanitize(text);
    const oneLine = sanitized.replace(/\r?\n/g, MULTILINE_SEPARATOR);
    const bufName = `water-buf-${crypto.randomBytes(3).toString('hex')}`;
    await runFn('tmux', ['set-buffer', '-b', bufName, oneLine]);
    try {
      // -d (delete after) so the buffer doesn't accumulate.
      await runFn('tmux', ['paste-buffer', '-t', name, '-b', bufName, '-d']);
    } catch (err) {
      // Best-effort buffer cleanup if paste fails.
      await runFn('tmux', ['delete-buffer', '-b', bufName]).catch(() => {});
      throw err;
    }
    // Drain delay — see incident note above.
    await new Promise((r) => setTimeout(r, 80));
    return { sanitized, oneLine, stripped: text.length - sanitized.length };
  }

  /**
   * Capture pane content. By default returns the last 1000 lines with
   * line-wrapped lines joined (`-J`) — handles wrapping artifacts
   * regardless of pane-width setting.
   *
   * For frequent polling (ready/streaming/approval-prompt detection),
   * pass a smaller `lines` value — the indicators all live in the
   * bottom ~50 lines of the pane. Polling 1000 lines each poll spawns
   * a heavier tmux capture subprocess unnecessarily.
   */
  async function capturePane(name, { lines = 1000, joinWrapped = true } = {}) {
    const args = ['capture-pane', '-t', name, '-p'];
    if (joinWrapped) args.push('-J');
    args.push('-S', `-${lines}`);
    const { stdout } = await runFn('tmux', args);
    return stdout;
  }

  /**
   * Wide capture — alias for capturePane with -J always on. Use when
   * regex parsing is sensitive to line wrapping.
   */
  async function captureWide(name, opts = {}) {
    return capturePane(name, { ...opts, joinWrapped: true });
  }

  async function sessionExists(name) {
    try {
      await runFn('tmux', ['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }

  async function killSession(name) {
    await runFn('tmux', ['kill-session', '-t', name]).catch(() => {});
  }

  /**
   * List polygram-managed tmux sessions on the host. Optional `botName`
   * narrows the prefix; without it returns all `water-*` sessions.
   */
  async function listPolygramSessions(botName = null) {
    try {
      const { stdout } = await runFn('tmux', ['list-sessions', '-F', '#{session_name}']);
      const all = stdout.trim().split('\n').filter(Boolean);
      const prefix = botName ? `water-${String(botName).replace(/[^\w-]/g, '_')}-` : 'water-';
      return all.filter((n) => n.startsWith(prefix));
    } catch {
      return [];
    }
  }

  return {
    spawn,
    sendControl,
    pasteText,
    pasteAndEnter,
    capturePane,
    captureWide,
    sessionExists,
    killSession,
    listPolygramSessions,
    sessionName,
    debugLogPath,
    ensureLogDir,
    sanitize,
    // Test hook
    _run: runFn,
  };
}

module.exports = {
  createTmuxRunner,
  sessionName,
  debugLogPath,
  sanitize,
  MULTILINE_SEPARATOR,
  CONTROL_CHAR_RE,
};

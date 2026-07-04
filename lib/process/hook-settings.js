// provenance: polygram@0.17.11 lib/process/hook-settings.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * hook-settings — build the per-session `--settings <file>` JSON
 * polygram injects at claude-spawn time for the H1 hook-based
 * observability stream.
 *
 * See docs/0.10.0-tmux-hook-observability.md. The settings file
 * registers a single command-type hook on every event we want to
 * observe; the command is `water-hook-append.js` (a Node helper at
 * a fixed absolute path) which appends each event as a compacted JSON
 * line to the per-session ndjson.
 *
 * Path layout:
 *   ~/.water/<bot>/hooks/<sid>.settings.json   (this file's output)
 *   ~/.water/<bot>/hooks/<sid>.ndjson          (hook stream sink)
 *
 * 2.1.142 spike findings (2026-05-21) baked into the schema:
 *  - hooks DO fire alongside `--strict-mcp-config
 *    --setting-sources project,local --settings <file>` (so the file
 *    is the right transport for the Music topic).
 *  - hooks are non-blocking by default → no `async`/`timeout` needed,
 *    but `timeout: 30` is included as a belt-and-braces backstop in
 *    case a future CLI release flips the default to sync. 30 s is a
 *    safe ceiling (the helper is single-syscall fast in practice).
 *  - registered events: the five confirmed in the spike +
 *    `Notification` (not yet observed; harmless to register).
 *    `SubagentStart` is intentionally omitted — it did not fire for
 *    general-purpose subagents on 2.1.142 and the design does not
 *    depend on it.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const HOOK_HELPER_ABS_PATH = path.resolve(__dirname, 'water-hook-append.js');

// Events we register hooks for. Order is informational only — claude
// merges by event name.
const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStop',
  'Stop',
  'Notification',
  // 0.12.0-rc.13: compaction lifecycle. PreCompact fires when claude is about
  // to (auto-)compact — the moment that detaches the channels MCP bridge.
  // PostCompact fires after, when context has dropped (used to re-arm the
  // per-chat compaction warning). Both confirmed supported by the pinned CLI
  // (2.1.142) and carry a `trigger: auto|manual` field.
  'PreCompact',
  'PostCompact',
];

/**
 * Per-bot hooks dir (parent of both settings + ndjson files).
 * Mirrors `lib/tmux/tmux-runner.js#debugLogPath`'s `~/.water/<bot>/logs`
 * convention. No /tmp fallback when HOME is unset — fail loud (audit
 * M4 style — symlink races on world-writable dirs).
 *
 * @param {string} botName
 * @param {string} [hooksDir]  override (for tests)
 */
function hooksBaseDir(botName, hooksDir) {
  if (!hooksDir && !process.env.HOME) {
    throw Object.assign(
      new Error('HOME env var unset; refusing /tmp fallback for hooks dir'),
      { code: 'HOME_UNSET' },
    );
  }
  const safeBot = String(botName).replace(/[^\w-]/g, '_');
  return hooksDir || path.join(process.env.HOME, '.water', safeBot, 'hooks');
}

function hookNdjsonPath(botName, sessionId, hooksDir) {
  return path.join(hooksBaseDir(botName, hooksDir), `${sessionId}.ndjson`);
}

function hookSettingsPath(botName, sessionId, hooksDir) {
  return path.join(hooksBaseDir(botName, hooksDir), `${sessionId}.settings.json`);
}

/**
 * Build the settings-JSON object that claude reads via `--settings`.
 *
 * @param {object} opts
 * @param {string} opts.ndjsonPath    absolute path the helper appends to
 * @param {string} [opts.helperPath]  absolute path to water-hook-append.js
 *                                    (defaults to the one shipped with polygram)
 */
// 0.12 SEC-03: shell-quote helper + ndjson paths in the command string.
// claude's hook runner shells out via execvp on a parsed argv. If either
// path contains characters the shell tokenizer would split on (most
// commonly: spaces in HOME like `/Users/Ivan Shumkov/...`), the helper
// receives the wrong argv and exits with code 2 ("missing ndjson path").
// Silent-drop of all hook events on bots whose HOME has a space.
//
// Single-quote escaping rule: replace any literal `'` with `'\''` (close
// quote, escaped quote, re-open quote), then wrap the whole thing in
// single quotes. POSIX-shell safe; no special chars inside single quotes
// except `'` itself.
function _shqSingle(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildHookSettings({ ndjsonPath, helperPath = HOOK_HELPER_ABS_PATH } = {}) {
  if (!ndjsonPath || !path.isAbsolute(ndjsonPath)) {
    throw new TypeError('buildHookSettings: ndjsonPath must be an absolute path');
  }
  if (!path.isAbsolute(helperPath)) {
    throw new TypeError('buildHookSettings: helperPath must be an absolute path');
  }
  const command = `node ${_shqSingle(helperPath)} ${_shqSingle(ndjsonPath)}`;
  // Per-event entry: PreToolUse/PostToolUse take a matcher (".*" =
  // every tool); the lifecycle events don't.
  const matched = (matcher) => [{ matcher, hooks: [{ type: 'command', command, timeout: 30 }] }];
  const unmatched = () => [{ hooks: [{ type: 'command', command, timeout: 30 }] }];
  const hooks = {};
  for (const evt of HOOK_EVENTS) {
    hooks[evt] = (evt === 'PreToolUse' || evt === 'PostToolUse') ? matched('.*') : unmatched();
  }
  return { hooks };
}

/**
 * Write the settings JSON to disk (creates parent dirs). Returns the
 * absolute path. Caller pushes `--settings <path>` to the spawn args.
 *
 * The empty ndjson sink is also touched here so the LogTail's
 * fs.watch can attach immediately (LogTail handles ENOENT, but touching
 * eliminates a small race window on the first hook event).
 */
function writeHookFiles({ botName, sessionId, hooksDir, helperPath, fsImpl = fs } = {}) {
  const settingsPath = hookSettingsPath(botName, sessionId, hooksDir);
  const ndjsonPath = hookNdjsonPath(botName, sessionId, hooksDir);
  fsImpl.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const settings = buildHookSettings({ ndjsonPath, helperPath });

  // 0.12 SEC-04: write both files with mode 0o600. The ndjson stream
  // carries every tool_input (file paths, Bash commands, write content,
  // partial outputs) — load-bearing observability in CliProcess, NOT the
  // tmux-backend observe-only surface this code was originally built for.
  // umask 022 default leaves the files world-readable; mirror the existing
  // 0o600 pattern from cli-process.js mcp-config writes.
  fsImpl.writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  // Touch the ndjson so fs.watch attaches before the first hook fires.
  // Use openSync with mode 0o600 so a brand-new file is created restricted
  // from birth; if the file already exists (re-spawn case) the mode flag
  // is silently ignored, which is fine because writeHookFiles' caller
  // (CliProcess._spawnTmuxClaude) controls the parent dir's lifecycle.
  const fd = fsImpl.openSync(ndjsonPath, 'a', 0o600);
  fsImpl.closeSync(fd);
  // Defensive re-chmod on both — in case umask interfered with the mode
  // arg above. Same belt-and-suspenders pattern as cli-process.js:404-406.
  try { fsImpl.chmodSync(settingsPath, 0o600); } catch {}
  try { fsImpl.chmodSync(ndjsonPath, 0o600); } catch {}
  return { settingsPath, ndjsonPath };
}

/**
 * Best-effort unlink of both files. Called on kill + orphan-sweep.
 * Errors are swallowed (ENOENT is the common case after a clean kill).
 */
function removeHookFiles({ botName, sessionId, hooksDir, fsImpl = fs } = {}) {
  for (const p of [hookSettingsPath(botName, sessionId, hooksDir),
                   hookNdjsonPath(botName, sessionId, hooksDir)]) {
    try { fsImpl.unlinkSync(p); } catch { /* swallow */ }
  }
}

module.exports = {
  HOOK_HELPER_ABS_PATH,
  HOOK_EVENTS,
  hooksBaseDir,
  hookNdjsonPath,
  hookSettingsPath,
  buildHookSettings,
  writeHookFiles,
  removeHookFiles,
};

// provenance: polygram@0.17.11 lib/tmux/orphan-sweep.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Boot-time tmux orphan sweep — kill any `water-<botName>-*` tmux
 * sessions left over from a prior daemon.
 *
 * Why this exists:
 *   - `lib/process-guard.js#claimPidFile` (rc.50) kills the prior
 *     polygram daemon at boot, but tmux sessions OUTLIVE their parent
 *     process — they're owned by the tmux server, not by polygram.
 *   - When the new daemon's TmuxProcess.start() tries to spawn a
 *     session with the bot-prefixed name, `tmux new-session` fails
 *     with EEXIST because the old session is still there.
 *   - The old session is unrecoverable: claudeSessionId is fresh per
 *     turn, the daemon writing to JSONL was SIGKILLed mid-turn, and
 *     any user-visible reply was already lost to the dead daemon.
 *
 * Strategy: list, kill, log. Best-effort — if tmux isn't running or
 * the kill races a concurrent operator, swallow the error and proceed.
 *
 * @see lib/process-guard.js (claimPidFile)
 * @see lib/tmux/tmux-runner.js (listPolygramSessions, killSession)
 */

'use strict';

const { createTmuxRunner } = require('./tmux-runner');

/**
 * Sweep all `water-<botName>-*` tmux sessions on the host.
 *
 * @param {object} opts
 * @param {string} opts.botName       — only sweep sessions for THIS bot
 * @param {object} [opts.runner]      — injected TmuxRunner (for tests)
 * @param {object} [opts.logger=console]
 * @returns {Promise<{ swept: string[], errors: Array<{name:string, error:string}> }>}
 */
async function sweepTmuxOrphans({ botName, runner, logger = console } = {}) {
  if (!botName) throw new TypeError('sweepTmuxOrphans: botName required');
  // SECURITY (audit M2): dashes in bot names risk prefix-match
  // collision when two bots share a prefix (e.g. `shumabit` matches
  // `water-shumabit-prod-*` too). Warn so the operator can rename.
  // The trailing `-` in the listPolygramSessions filter prevents an
  // exact-prefix collision but DOES NOT prevent `shumabit` vs
  // `shumabit-prod`. Defense-in-depth: surface it.
  if (typeof botName === 'string' && botName.includes('-')) {
    logger.warn?.(
      `[orphan-sweep] bot name "${botName}" contains '-'; orphan-sweep `
      + `prefix matching could collide with other bot names sharing a `
      + `prefix. Consider renaming (e.g. use _ instead).`,
    );
  }
  const r = runner || createTmuxRunner({ logger });
  let names;
  try {
    names = await r.listPolygramSessions(botName);
  } catch (err) {
    // Most common: tmux not running. Best-effort = no-op.
    logger.log?.(`[orphan-sweep] list-sessions failed (${err.message}); assuming no orphans`);
    return { swept: [], errors: [] };
  }
  if (names.length === 0) {
    logger.log?.(`[orphan-sweep] no water-${botName}-* orphans`);
    return { swept: [], errors: [] };
  }
  logger.log?.(`[orphan-sweep] killing ${names.length} orphan tmux session(s): ${names.join(', ')}`);
  const errors = [];
  const swept = [];
  for (const name of names) {
    try {
      await r.killSession(name);
      swept.push(name);
    } catch (err) {
      errors.push({ name, error: err.message });
      logger.warn?.(`[orphan-sweep] kill ${name} failed: ${err.message}`);
    }
  }
  return { swept, errors };
}

module.exports = { sweepTmuxOrphans };

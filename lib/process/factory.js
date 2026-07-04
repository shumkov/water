// provenance: polygram@0.17.11 lib/process/factory.js (git 746bca6) — adapt: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Process factory — chooses + constructs the right Process subclass
 * per session, based on chat / topic / bot config.
 *
 * Backends (post-0.12):
 *   - 'sdk' → SdkProcess (long-lived SDK Query, per-token API billing)
 *   - 'cli' → CliProcess (claude TUI in tmux + Channels MCP bridge + hooks ndjson,
 *                          subscription billing; default production path)
 *
 * Config aliases (back-compat for existing chat configs):
 *   - 'channels' → 'cli' (0.11.0-channels driver folded into CliProcess)
 *   - 'tmux'     → 'cli' (0.10.0 tmux backend deleted in 0.12 Phase 4;
 *                          existing configs keep working via this alias)
 *
 * Backend selection precedence:
 *   topicConfig.pm > chatConfig.pm > config.bot.pm > 'sdk'
 *
 * Per-backend wiring requirements:
 *   cli — tmuxRunner + botName + toolDispatcher + claudeBin
 *
 * If a backend is configured but its wiring is missing, we log a loud
 * warning and fall back to SDK so the daemon stays up (R2-F7 — never
 * silent-fail config).
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §6.4
 * @see docs/0.11.0-channels-driver-plan.md
 * @see docs/0.12.0-cli-driver-plan.md
 */

'use strict';

// water v1 is cli-only. The SDK backend is the documented escape hatch (SPEC §4.3)
// if the research-preview channels flag is ever withdrawn — the factory seam is kept
// warm, but sdk-process is not ported yet, so selecting it throws a clear error
// instead of silently failing. Port sdk-process here to activate it.
class SdkProcess {
  constructor() {
    throw new Error(
      "water v1: pm:'sdk' backend is not available (deferred escape hatch). " +
      "Use pm:'cli' (the default). See docs/SPEC.md §4.3 and §17.",
    );
  }
}
const { CliProcess } = require('./cli-process');

// Aliases — config values that map to a different canonical backend.
// Each alias emits ONE deprecation warn per-bot-process lifetime
// (tracked in `_warnedAliases` below). Avoids per-spawn log flooding
// on multi-chat deploys.
const ALIASES = new Map([
  ['channels', 'cli'],
  ['tmux',     'cli'],   // 0.12 Phase 4: tmux backend deleted; existing configs alias to cli
]);

const _warnedAliases = new Set();
function _maybeWarnAlias(alias, canonical, logger) {
  if (_warnedAliases.has(alias)) return;
  _warnedAliases.add(alias);
  logger.warn?.(
    `[factory] pm:'${alias}' is deprecated and now aliases to pm:'${canonical}'. ` +
    `Update chat config to silence this warning. ` +
    `See docs/0.12.0-cli-driver-plan.md §"Open questions resolved here" / Q5.`,
  );
}

// 0.12 Phase 4.5.3 (R12 mitigation): chats migrating from pm:'tmux' (the
// 0.10 backend with implicit pane-scrape approval gating) to pm:'cli'
// silently lose approvals unless the operator explicitly sets
// permissionMode. Warn ONCE per (botName, chatId, threadId) tuple so
// the migration trade-off is deliberate, not a surprise regression.
// Fires at pickBackend time (factory.js is the choke point for backend
// resolution).
const _warnedR12Chats = new Set();
function _maybeWarnR12Migration({ rawPm, canonical, chatId, threadId, chatCfg, topicCfg, logger }) {
  if (rawPm !== 'tmux' || canonical !== 'cli') return;
  // Resolved permissionMode honors the same precedence cli-process.js
  // uses: topic > chat > opt-default. Check both topic and chat config
  // here; we don't know opt-default (set inside CliProcess.start), but
  // its default is 'bypassPermissions' so absence = bypass.
  const explicitMode = topicCfg?.permissionMode || chatCfg?.permissionMode;
  if (explicitMode && explicitMode !== 'bypassPermissions') return;
  const key = `${chatId}:${threadId ?? ''}`;
  if (_warnedR12Chats.has(key)) return;
  _warnedR12Chats.add(key);
  logger.warn?.(
    `[factory] R12 migration warning: chat=${chatId}${threadId ? ` thread=${threadId}` : ''} ` +
    `was configured as pm:'tmux' and now aliases to pm:'cli'. The 0.10 tmux backend gated ` +
    `Bash/Edit/etc tool calls via pane-scrape approval cards; the 0.12 CliProcess defaults to ` +
    `permissionMode:'bypassPermissions' (no approvals). To preserve approval gating on this ` +
    `chat, set permissionMode: 'default' (or 'acceptEdits' / 'plan') in chat or topic config. ` +
    `See docs/0.12.0-cli-driver-plan.md §"Security posture" + R12.`,
  );
}

/**
 * @param {object} opts
 * @param {object} opts.config            — runtime config object
 * @param {Function} opts.spawnFn          — buildSdkOptions (SDK backend only)
 * @param {object} [opts.db]               — for SdkProcess._logEvent + clearSessionId
 * @param {object} [opts.logger]
 * @param {number} [opts.queueCap]
 * @param {number} [opts.queryCloseTimeoutMs]
 * @param {object} [opts.tmuxRunner]       — required when ANY chat routes to 'cli'
 * @param {string} [opts.botName]          — required when ANY chat routes to 'cli'
 * @param {Function} [opts.toolDispatcher] — required when ANY chat routes to 'cli'.
 *   async ({sessionKey, chatId, threadId, toolName, text, files}) => {ok, error?}.
 *   Called when Claude's reply (or react/edit_message) tool fires inside a
 *   CliProcess. Polygram supplies the actual Telegram-send wiring.
 * @param {string} [opts.channelsClaudeBin] — absolute path to pinned claude binary;
 *   required when ANY chat routes to 'cli'. (Name kept for back-compat with
 *   existing wiring; can be renamed to `claudeBin` in a future refactor.)
 * @returns {Function} processFactory(sessionKey, ctx) → Process
 */
function createProcessFactory({
  config,
  spawnFn,
  db = null,
  logger = console,
  queueCap,
  queryCloseTimeoutMs,
  tmuxRunner = null,
  botName = null,
  toolDispatcher = null,
  channelsClaudeBin = null,
} = {}) {
  // spawnFn (buildSdkOptions) is only used by the deferred SDK backend; water v1 is
  // cli-only, so it is optional here (a missing SDK wiring surfaces as the SdkProcess
  // constructor's clear "not available" error, not a factory-construction failure).

  return function processFactory(sessionKey, ctx) {
    const chatId = ctx?.chatId ?? null;
    const threadId = ctx?.threadId ?? null;
    const label = ctx?.label || sessionKey;

    const choice = pickBackend({ config, chatId, threadId, logger });

    if (choice === 'cli') {
      const missing = [];
      if (!tmuxRunner) missing.push('tmuxRunner');
      if (!botName) missing.push('botName');
      if (typeof toolDispatcher !== 'function') missing.push('toolDispatcher');
      if (!channelsClaudeBin) missing.push('channelsClaudeBin');
      if (missing.length) {
        logger.warn?.(
          `[${label}] config requests pm:'cli' but ${missing.join(', ')} not wired; ` +
          `falling back to SdkProcess. Pass these to createProcessFactory.`,
        );
      } else {
        return new CliProcess({
          sessionKey, chatId, threadId, label,
          tmuxRunner,
          botName,
          claudeBin: channelsClaudeBin,
          toolDispatcher,
          logger,
          db,                  // Parity P1: telemetry parity with sdk/tmux
        });
      }
    }

    return new SdkProcess({
      sessionKey, chatId, threadId, label,
      spawnFn,
      db,
      logger,
      queueCap,
      queryCloseTimeoutMs,
    });
  };
}

/**
 * Per-chat / per-topic backend choice.
 *
 * Honors topicConfig.pm / chatConfig.pm / config.bot.pm. Resolves aliases
 * (e.g., 'channels' → 'cli') and emits a once-per-process deprecation warn.
 *
 * Review AC3: unknown `pm` values (typos like `'channel'` singular) used to
 * silently fall through to 'sdk' with no warning — violates R2-F7 "never
 * silent-fail config". Now logs a warn and falls back to the default.
 */
const CANONICAL_BACKENDS = new Set(['sdk', 'cli']);

function pickBackend({ config, chatId, threadId, logger = console } = {}) {
  if (!chatId) return 'cli';
  const chatCfg = config?.chats?.[chatId];
  const topicCfg = threadId && chatCfg?.topics?.[threadId];
  const raw = topicCfg?.pm || chatCfg?.pm || config?.bot?.pm || 'cli';

  // Resolve alias (e.g., 'channels' → 'cli'). Warns once per process per
  // alias kind, NOT per spawn — multi-chat deploys shouldn't flood logs.
  let picked = raw;
  if (ALIASES.has(raw)) {
    picked = ALIASES.get(raw);
    _maybeWarnAlias(raw, picked, logger);
    // R12 — per-chat migration warning when pm:'tmux' aliases to 'cli'
    // without an explicit non-bypass permissionMode override.
    _maybeWarnR12Migration({
      rawPm: raw,
      canonical: picked,
      chatId, threadId,
      chatCfg, topicCfg,
      logger,
    });
  }

  if (!CANONICAL_BACKENDS.has(picked)) {
    logger.warn?.(
      `[factory] unknown pm value '${raw}' for chat=${chatId} thread=${threadId ?? ''}; ` +
      `falling back to 'sdk'. Valid: ${[...CANONICAL_BACKENDS].join(', ')} ` +
      `(aliases: ${[...ALIASES.keys()].join(', ')}).`,
    );
    return 'sdk';
  }
  return picked;
}

// _resetAliasWarnings — test-only helper. Resets the once-per-process warn
// tracking so unit tests can verify alias-warn + R12-migration-warn behavior
// across multiple pickBackend() invocations within a single test run.
function _resetAliasWarnings() {
  _warnedAliases.clear();
  _warnedR12Chats.clear();
}

module.exports = { createProcessFactory, pickBackend, _resetAliasWarnings, ALIASES, CANONICAL_BACKENDS };

// provenance: polygram@0.17.11 lib/process/hook-event-tail.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * hook-event-tail — typed-event parser around the per-session hook
 * ndjson that `water-hook-append.js` writes for the H1 hook-based
 * turn observability (docs/0.10.0-tmux-hook-observability.md).
 *
 * Mirrors the JSONL stream's `pipeToParser(tail)` shape so TmuxProcess
 * wires it the same way `_armSessionLogTail` wires the JSONL tail.
 *
 * Per-line behaviour:
 *  - Parse JSON. If the line is missing, malformed, or the helper
 *    wrapped it with `polygram_parse_error`, emit a `parse-error`
 *    event (observability — H1 soak measures how often this fires).
 *  - Discriminate on `hook_event_name`. Known events become typed
 *    HookEvent records with normalized fields; unknown event names
 *    pass through as `unknown` with the raw object attached so we
 *    can investigate without re-deploying.
 *  - Empty lines are ignored (atomic-append interleave between two
 *    helper invocations can produce them in theory — H1 measures
 *    whether it happens in practice on macOS).
 *
 * Normalized HookEvent shape (the fields downstream code may rely on
 * once H1's observer-only soak proves the stream — H2+ phases consume
 * these):
 *
 *   {
 *     type: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit'
 *         | 'Stop' | 'SubagentStop' | 'Notification' | 'unknown'
 *         | 'parse-error',
 *     sessionId, transcriptPath, cwd, permissionMode,           // common
 *     toolName, toolUseId, toolInput, toolResponse, durationMs, // tool events
 *     agentId, agentType,                                       // subagent-inner
 *     agentTranscriptPath,                                      // SubagentStop
 *     prompt,                                                   // UserPromptSubmit
 *     stopHookActive, lastAssistantMessage,                     // Stop
 *     receivedAtMs, raw,                                        // always
 *   }
 *
 * Per the 2.1.142 spike, `parent_tool_use_id` is NOT a field, and
 * `SubagentStart` does not fire (for general-purpose subagents) —
 * neither is in the typed shape.
 */

'use strict';

const { LogTail } = require('../tmux/log-tail');

const KNOWN_EVENT_NAMES = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStop',
  'Stop',
  'Notification',
  // 0.12.0-rc.13: compaction lifecycle (carry `trigger` + custom_instructions).
  'PreCompact',
  'PostCompact',
]);

/**
 * Normalize one raw hook payload (already JSON.parsed) into the
 * shape downstream code consumes. Unknown shapes pass through as
 * `unknown` so a 2.1.143-style schema drift doesn't silently lose
 * events.
 */
function normalizeHookEvent(raw) {
  if (raw && typeof raw === 'object' && raw.polygram_parse_error) {
    return {
      type: 'parse-error',
      error: raw.polygram_parse_error,
      receivedAtMs: raw.polygram_received_at_ms ?? null,
      raw,
    };
  }
  const name = raw && typeof raw === 'object' ? raw.hook_event_name : null;
  const type = KNOWN_EVENT_NAMES.has(name) ? name : 'unknown';
  return {
    type,
    sessionId:           raw?.session_id ?? null,
    transcriptPath:      raw?.transcript_path ?? null,
    cwd:                 raw?.cwd ?? null,
    permissionMode:      raw?.permission_mode ?? null,
    toolName:            raw?.tool_name ?? null,
    toolUseId:           raw?.tool_use_id ?? null,
    toolInput:           raw?.tool_input ?? null,
    toolResponse:        raw?.tool_response ?? null,
    durationMs:          raw?.duration_ms ?? null,
    agentId:             raw?.agent_id ?? null,
    agentType:           raw?.agent_type ?? null,
    agentTranscriptPath: raw?.agent_transcript_path ?? null,
    prompt:              raw?.prompt ?? null,
    stopHookActive:      raw?.stop_hook_active ?? null,
    lastAssistantMessage: raw?.last_assistant_message ?? null,
    // PreCompact/PostCompact payload: trigger distinguishes auto vs manual
    // compaction; custom_instructions is the `/compact <hint>` text (manual).
    trigger:             raw?.trigger ?? null,
    customInstructions:  raw?.custom_instructions ?? null,
    receivedAtMs:        raw?.polygram_received_at_ms ?? null,
    raw,
  };
}

/**
 * Wrap a LogTail with line-by-line hook parsing. Forwards parsed
 * events via `'event'` (same shape as claude-session-jsonl.pipeToParser).
 *
 * @returns the same emitter (chainable).
 */
function pipeHookParser(tail) {
  tail.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return; // blank-line guard (interleave-paranoid)
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      tail.emit('event', {
        type: 'parse-error',
        error: err.message,
        receivedAtMs: Date.now(),
        raw: trimmed.length > 1024 ? trimmed.slice(0, 1024) + '…' : trimmed,
      });
      return;
    }
    tail.emit('event', normalizeHookEvent(raw));
  });
  return tail;
}

/**
 * One-shot helper: build a LogTail at the given path with the
 * H1-typical config (watch mode), wire the hook parser, and return
 * it. Caller calls `.start()` and `.on('event', ...)`.
 *
 * `skipExisting`:
 *   - false (default) for a FRESH spawn — the ndjson was just
 *     touched at start time and is empty, so any future write IS a
 *     new event.
 *   - true for a `--resume` spawn — `writeHookFiles` uses 'a' mode
 *     (append) and never truncates, so the prior session's hook
 *     events are still on disk. Without skipExisting they replay
 *     into the fresh process, arming a Stop synth against the
 *     fresh turn (H4) and heartbeating it (H3) from stale events.
 *     rc.42 #5 (review-driven): mirror what `_armSessionLogTail`
 *     already does for the JSONL tail.
 */
function createHookTail({ path: filePath, skipExisting = false, logger = console } = {}) {
  const tail = new LogTail({
    path: filePath,
    intervalMs: 50,
    skipExisting,
    useWatch: 'auto',
    logger,
  });
  return pipeHookParser(tail);
}

module.exports = {
  KNOWN_EVENT_NAMES,
  normalizeHookEvent,
  pipeHookParser,
  createHookTail,
};

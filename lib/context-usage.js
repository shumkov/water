// provenance: polygram@0.17.11 lib/context-usage.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * context-usage — read live context occupancy from a Claude Code session
 * transcript (JSONL).
 *
 * Used by the per-chat compaction warning (0.12.0-rc.13). polygram has no
 * usage payload on the channels/CLI backend (hook events carry none — see
 * the rc.13 spike), so the only source of "how full is the context" is the
 * transcript itself. We read it ONCE per turn-end (Stop hook), not on a
 * poll loop, so a single streamed pass is fine.
 *
 * What "occupancy" means: Claude's own context-% / auto-compact threshold is
 * measured against what's fed INTO the model each turn —
 *   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 * (cache_read dominates once the conversation is warm). output_tokens is the
 * reply, not context, so it's excluded.
 *
 * We take the LAST main-thread (non-sidechain) assistant frame with a usage
 * block. Subagents write to their own agent_transcript_path so sidechain
 * frames don't normally appear here, but we skip them defensively: a format
 * change that inlined a subagent's large usage would otherwise spike the
 * parent's apparent context and trigger a false "you're full" warning.
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

// Standard Claude context window (sonnet/opus, non-beta). The warning is a
// heuristic ("you're getting full"), so an approximate denominator is fine;
// callers can pass a different window for 1M-beta sessions.
const DEFAULT_WINDOW_TOKENS = 200_000;

/**
 * @param {string} transcriptPath
 * @returns {Promise<{inputTokens:number, cacheReadTokens:number, cacheCreationTokens:number, total:number} | null>}
 *   null when the path is falsy/unreadable or no usable usage frame exists.
 */
async function readContextTokens(transcriptPath) {
  if (!transcriptPath) return null;

  let stream;
  try {
    stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    let last = null;
    // Resolve only once — error and close can both fire.
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    stream.on('error', () => finish(null));

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    // readline forwards the input stream's 'error' (e.g. ENOENT on open) to
    // the interface; without this handler that re-emit is unhandled and
    // crashes the process even though we resolved null on the stream error.
    rl.on('error', () => finish(null));
    rl.on('line', (line) => {
      if (!line) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }  // skip partial/non-JSON lines
      if (!o || o.type !== 'assistant' || o.isSidechain === true) return;
      const u = o.message?.usage;
      if (!u) return;
      const inputTokens = Number(u.input_tokens) || 0;
      const cacheReadTokens = Number(u.cache_read_input_tokens) || 0;
      const cacheCreationTokens = Number(u.cache_creation_input_tokens) || 0;
      const total = inputTokens + cacheReadTokens + cacheCreationTokens;
      if (total > 0) last = { inputTokens, cacheReadTokens, cacheCreationTokens, total };
    });
    rl.on('close', () => finish(last));
  });
}

/**
 * Fraction (0..1) of the context window currently occupied. Clamps to 0 on
 * non-positive / non-finite inputs so callers never see NaN/Infinity.
 *
 * @param {number} totalTokens
 * @param {number} [windowTokens=DEFAULT_WINDOW_TOKENS]
 * @returns {number}
 */
function contextPct(totalTokens, windowTokens = DEFAULT_WINDOW_TOKENS) {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return 0;
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return 0;
  return totalTokens / windowTokens;
}

module.exports = { readContextTokens, contextPct, DEFAULT_WINDOW_TOKENS };

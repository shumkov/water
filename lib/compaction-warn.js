// provenance: polygram@0.17.11 lib/compaction-warn.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * compaction-warn — per-chat config resolution + warn-once state for the
 * compaction warning (0.12.0-rc.13).
 *
 * The warning is OFF by default. A chat (or topic) opts in via
 * `compactionWarnings`:
 *   true                                   → enabled, default threshold
 *   { enabled: true, thresholdPct: 80 }    → enabled, custom threshold
 *   false / absent / object w/o enabled    → off
 *
 * `thresholdPct` is the context-fill % at which the PROACTIVE warning fires
 * (propose /compact before claude auto-compacts mid-turn). Default 75 — below
 * claude's own auto-compact threshold so the user gets a window to act.
 */

'use strict';

const DEFAULT_THRESHOLD_PCT = 75;

/**
 * @param {object|undefined} cfg  resolved topic/chat config (getTopicConfig result)
 * @returns {{enabled: boolean, thresholdPct: number}}
 */
function resolveCompactionWarnConfig(cfg) {
  const raw = cfg?.compactionWarnings;
  const off = { enabled: false, thresholdPct: DEFAULT_THRESHOLD_PCT };

  if (raw === true) return { enabled: true, thresholdPct: DEFAULT_THRESHOLD_PCT };
  if (raw && typeof raw === 'object' && raw.enabled === true) {
    const t = Number(raw.thresholdPct);
    const thresholdPct = (Number.isFinite(t) && t > 0 && t < 100) ? t : DEFAULT_THRESHOLD_PCT;
    return { enabled: true, thresholdPct };
  }
  return off;
}

/**
 * Per-session "have we already warned on this climb?" state. Warn ONCE per
 * session until reset — without this the proactive warning would re-fire on
 * every turn-end while the context stays high. Reset on a successful
 * compaction (PostCompact → context dropped) or a fresh session so the next
 * climb can warn again. Mirrors the autoResumeTracker shape.
 */
function createCompactionWarnTracker() {
  const warned = new Set();
  return {
    shouldWarn(sessionKey) { return !warned.has(sessionKey); },
    markWarned(sessionKey) { warned.add(sessionKey); },
    reset(sessionKey) { warned.delete(sessionKey); },
    resetAll() { warned.clear(); },
    _size() { return warned.size; },
  };
}

module.exports = {
  resolveCompactionWarnConfig,
  createCompactionWarnTracker,
  DEFAULT_THRESHOLD_PCT,
};

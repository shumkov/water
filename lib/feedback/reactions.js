/**
 * Status-reaction state machine.
 *
 * PORTED verbatim from polygram lib/telegram/reactions.js — the state machine
 * is transport-agnostic (it only calls an injected `apply(emoji|null)` sink), so
 * water reuses it unchanged to drive WhatsApp reactions (WuzAPI /chat/react) via
 * lib/feedback/feedback.js. WhatsApp accepts arbitrary emoji, so water passes
 * `availableEmojis: null` (→ the first emoji of each fallback chain is used).
 *
 * Goal: give users a silent, non-intrusive progress signal during a turn.
 * Reactions are delivered quietly (no notification), update in place, and are
 * one emoji per message. Perfect for state like "thinking → coding → web → done".
 *
 * The state machine below translates Claude's turn event stream into a small set
 * of states, each mapped to an emoji. The caller (water's feedback controller)
 * holds a ReactionManager per turn and calls setState() at transition points.
 *
 * Design choices:
 *   - We pick emojis from Telegram's default-available set so groups
 *     that haven't customised `available_reactions` still work. Callers
 *     can pass an allowlist probed from getChat().available_reactions
 *     for groups that have — we fall back through a chain for each
 *     state until we find an allowed one.
 *   - Rate-limit changes to every 800ms (Telegram allows ~1/s per
 *     message). Intermediate states are dropped.
 *   - Terminal states (DONE/COMPLETE/ERROR/TIMEOUT/AUTOSTEERED) always
 *     flush, ignoring throttle, so the user sees the final outcome.
 *     (water adds COMPLETE ✅ for a handled turn that sent no text reply.)
 *   - On abort or cleanup we clear the reaction entirely rather than
 *     leaving a stale "thinking" emoji.
 */

// Ordered fallback chains — first emoji is the preferred one; follow-ups
// are progressively safer. All endings in this list are in Telegram's
// default available reactions as of 2026-04.
const STATES = {
  QUEUED:           { label: 'queued',           chain: ['👀', '🤔']       },
  // rc.32: progressive-deepening cascade. setState('THINKING') auto-
  // promotes through THINKING_DEEPER → THINKING_DEEPEST as time passes
  // without a state change. Thresholds calibrated to Ivan DM 14-day
  // production: 8% turns finish <5s, 33% in 5-15s (so 8s catches the
  // meaty band), 25% in 15-30s (20s threshold catches them mid-flow),
  // 17% over 60s (existing 45s STALL still fires for the truly long).
  // All three emoji on Telegram's curated standard reaction list.
  THINKING:         { label: 'thinking',         chain: ['🤔']             },
  THINKING_DEEPER:  { label: 'thinking-deeper',  chain: ['🤨', '🤔']       },
  // rc.37: 🧐 (face with monocle) is REACTION_INVALID for bots — only
  // Telegram Premium users can pick arbitrary emoji; bots are limited
  // to ~70 standard reactions and 🧐 isn't on the list. Production
  // log: `reaction apply failed (THINKING_DEEPEST → 🧐): 400: Bad
  // Request: REACTION_INVALID`. 🤓 (nerd face, intellectual focus) is
  // on the list and reads as "deeper than skeptical-eyebrow".
  THINKING_DEEPEST: { label: 'thinking-deepest', chain: ['🤓', '🤔'] },
  CODING:           { label: 'coding',           chain: ['👨‍💻', '✍', '🤔'] },
  WEB:              { label: 'web',              chain: ['⚡', '🔥', '🤔']  },
  TOOL:             { label: 'tool',             chain: ['🔥', '🤔']       },
  WRITING:          { label: 'writing',          chain: ['✍', '🤔']        },
  // 0.8.0-rc.11: terminal "your follow-up was incorporated into the
  // in-flight turn" state. Used by polygram's autosteer block when a
  // mid-turn user message is buffered for the next PostToolBatch
  // injection.
  AUTOSTEERED: { label: 'autosteered', chain: ['✍', '👀']        },
  // 0.12 (Findings L9/L14): distinct in-progress reaction for a running
  // subagent (Agent PreToolUse → SubagentStop). Driven by onSubagentStart.
  // Preferred 👾 (NOT 🤖 — 🤖 is REACTION_INVALID for bots, same class as
  // the rc.37 🧐 bug); falls back to 🔥 then 🤔, all bot-usable.
  SUBAGENT:    { label: 'subagent',    chain: ['👾', '🔥', '🤔']  },
  DONE:        { label: 'done',        chain: ['👍']             },
  // water addition: a durable "seen + handled, no text reply" ack (NO_REPLY /
  // tool-only turn). Left in place rather than cleared, so a partner doesn't see
  // the bot notice-then-dismiss them. Terminal (flushes, holds until stop).
  COMPLETE:    { label: 'complete',    chain: ['✅']             },
  ERROR:       { label: 'error',       chain: ['🤯', '🤔']       },
  STALL:       { label: 'stall',       chain: ['🥱', '🤔']       },
  TIMEOUT:     { label: 'timeout',     chain: ['😨', '🤯']       },
};

// Terminal states bypass throttle, disarm stall promotion, and the
// reactor stays at this emoji until explicitly cleared. AUTOSTEERED
// is included so setState('AUTOSTEERED') flushes immediately
// (matters because the autosteer code path returns from
// handleMessage right after — we don't want the apply to be
// scheduled-and-cancelled by reactor.stop in the outer finally).
const TERMINAL_STATES = new Set(['DONE', 'COMPLETE', 'ERROR', 'TIMEOUT', 'AUTOSTEERED']);
const DEFAULT_THROTTLE_MS = 800;
// 0.7.4 (item A): after this long with no setState() call (Claude is
// silently chugging on a long tool / model latency), auto-flip to STALL
// (🥱) so the user has a visible cue that the bot is alive but slow.
// rc.25: bumped from 10s → 45s. The original 10s matched OpenClaw, but
// SDK pm with effort=high reasoning routinely thinks for 15-30s before
// firing any tool or text chunk — under the old threshold the 🥱 was
// firing on EVERY substantive turn, training users to ignore it.
const DEFAULT_STALL_MS = 45_000;
// rc.25: bumped from 30s → 180s (3 min). The 😨 TIMEOUT was firing
// during ordinary multi-step agent runs (Ivan DM at 11:32 — bot was
// actively replying within 20s, but the trigger message stayed at
// 😨 because the OUTER turn ran for 100+ s across multiple replies
// and tool calls). Real "stuck" state would be 3+ min of nothing,
// which 180s captures while letting routine work breathe. Pm has its
// own 5-minute hard idle timeout that actually rejects stuck turns.
const DEFAULT_FREEZE_MS = 180_000;
// rc.32: thinking-deepening cascade thresholds. Calibrated to Ivan DM
// 14-day production data (445 turns) — 8% finish <5s, 33% in 5-15s,
// 25% in 15-30s. rc.35 bump: 8s→12s, 20s→30s. User feedback after
// rc.32 deploy was that the cascade kicked in too eagerly — most
// 5-15s turns showed 🤨 briefly before resolving, and the resulting
// emoji churn felt noisy rather than informative. Bumping deeper to
// 12s lets the entire 5-15s bracket (33%) resolve on plain 🤔, and
// deepest to 30s lets the 15-30s bracket (25%) resolve on 🤨 without
// cascading. STALL still fires at 45s for the genuinely-long 17%.
// CODING / TOOL / WEB / WRITING reset the cascade (any state-change
// in setState clears the deepening timers).
const DEFAULT_THINKING_DEEPER_MS = 12_000;
const DEFAULT_THINKING_DEEPEST_MS = 30_000;

// Tool name → state classifier. Case-insensitive substring match so we
// don't have to enumerate every existing or future tool. Order matters:
// WEB checks first because "WebFetch" contains "fetch" but should map
// to ⚡, not whatever the generic fetcher gets. Skill-prefixed tools
// (e.g. "mcp__plugin_playwright_playwright__browser_click") are still
// caught by the substring check.
//
// 0.7.4 (item C): pre-fix, anything not exactly matching a tiny regex
// (e.g. WebSearch_v2, custom Bash variants, MCP-namespaced tools) fell
// through to generic TOOL (🔥), losing the more-specific signal. The
// substring match recovers the right state for both built-ins and most
// MCP/skill tools without listing them by name.
//
// 0.12 Phase 2.2 (Finding D-01): falsy name OR name that doesn't substring-
// match any classifier → 'TOOL' (🔥 → 🤔 chain). This is the canonical
// unknown-tool fallback for ALL backends — sdk, tmux, and (new in 0.12) cli.
// CliProcess emits PreToolUse for arbitrary MCP tools (e.g. a future
// mcp__random__action that polygram has never seen), and the reactor must
// produce SOME visible state rather than silently drop or throw — otherwise
// the operator sees a frozen previous emoji for an unknown action.
function classifyToolName(name) {
  if (typeof name !== 'string' || !name) return 'TOOL';
  const n = name.toLowerCase();
  if (n.includes('web') || n.includes('fetch') || n.includes('browser') || n.includes('search')) return 'WEB';
  // WRITING before CODING: "TodoWrite" contains both "todo" and "write" —
  // we want it to land at ✍ (WRITING), not 👨‍💻 (CODING).
  if (n.includes('todo') || n.includes('task') || n.includes('skill')) return 'WRITING';
  if (n.includes('read') || n.includes('write') || n.includes('edit')
      || n.includes('bash') || n.includes('grep') || n.includes('glob')
      || n.includes('notebook')) return 'CODING';
  // Unknown-tool fallback — see header comment.
  return 'TOOL';
}

// 0.7.4 (item J): generic, almost-universally-available fallbacks. Used
// when a group's `available_reactions` allowlist excludes every emoji in
// a state's preferred chain. Better to show *some* reaction (e.g. 👍 for
// "done" in a group that only allows thumbs) than to silently emit
// nothing and leave the user wondering whether the bot is alive.
const GENERIC_FALLBACKS = ['👍', '👀', '🔥'];

// Module-scope sentinel for flush()'s `fromStateOverride` parameter.
// Distinguishes "caller didn't pass fromState" from "caller passed
// null (= reactor had no prior state)". Module-scoped so we don't
// allocate a fresh symbol on every flush call.
const FROM_STATE_UNSET = Symbol('flush.fromState-unset');

/**
 * Resolve the best-available emoji from a chain given an allowlist.
 * If allowlist is null/undefined, assume default-available set and
 * return the first entry.
 */
function resolveEmoji(chain, allowlist) {
  if (!allowlist) return chain[0];
  const allowed = allowlist instanceof Set ? allowlist : new Set(allowlist);
  for (const emoji of chain) {
    if (allowed.has(emoji)) return emoji;
  }
  for (const emoji of GENERIC_FALLBACKS) {
    if (allowed.has(emoji)) return emoji;
  }
  // Nothing in the chain or generic set is allowed — signal "no
  // reaction possible".
  return null;
}

/**
 * Create a reaction manager for a single turn.
 *
 * @param {object} deps
 * @param {(emoji: string|null) => Promise<void>} deps.apply   invoked with the
 *     resolved emoji when state changes. `null` means "clear reaction".
 * @param {string[]|Set<string>|null} [deps.availableEmojis]  allowlist probed
 *     from getChat().available_reactions. Null/undefined = assume defaults.
 * @param {number} [deps.throttleMs]  minimum ms between non-terminal changes.
 * @param {(msg: string) => void} [deps.logError]
 * @param {(transition: object) => void} [deps.onStateChange]
 *     rc.39: called after every visible state transition (state OR
 *     emoji change). Payload shape:
 *     { fromState, toState, fromEmoji, toEmoji, source, ts }
 *     where `source` is one of:
 *       'manual'          — explicit setState() call
 *       'cascade-deeper'  — auto-promotion to THINKING_DEEPER
 *       'cascade-deepest' — auto-promotion to THINKING_DEEPEST
 *       'stall-timer'     — auto STALL after stallMs
 *       'freeze-timer'    — auto FREEZE after freezeMs
 *       'clear'           — clear() call (toEmoji=null)
 *     Used by polygram to emit `reactor-state` events to the events
 *     table for forensic post-hoc reconstruction of any reaction
 *     anomaly. Must be cheap + sync — fired in the hot setState path.
 */
function createReactionManager({
  apply,
  availableEmojis = null,
  throttleMs = DEFAULT_THROTTLE_MS,
  stallMs = DEFAULT_STALL_MS,
  freezeMs = DEFAULT_FREEZE_MS,
  thinkingDeeperMs = DEFAULT_THINKING_DEEPER_MS,
  thinkingDeepestMs = DEFAULT_THINKING_DEEPEST_MS,
  logError = () => {},
  onStateChange = null,
} = {}) {
  if (typeof apply !== 'function') throw new Error('apply function required');
  let currentState = null;
  let currentEmoji = null;
  let lastFlushTs = 0;
  let lastSetStateTs = 0;
  let pendingTimer = null;
  let stallTimer = null;
  let freezeTimer = null;
  let deeperTimer = null;          // rc.32: THINKING → THINKING_DEEPER (8s)
  let deepestTimer = null;         // rc.32: THINKING → THINKING_DEEPEST (20s)
  let stopped = false;
  // 0.8.0-rc.11: serialize Telegram setMessageReaction calls. Without
  // this, multiple flush()es race at the network layer because each
  // calls `await apply(emoji)` from a separate stack — Telegram
  // processes them in arbitrary order and the FINAL visible state is
  // whichever apply landed last. Symptom: 👀 stuck on autosteered
  // messages when the QUEUED apply landed AFTER our explicit ✍ apply.
  // Chaining all applies through `applyChain` guarantees they're sent
  // to Telegram in setState() invocation order.
  let applyChain = Promise.resolve();
  // B3 / 0.17.4: independent "hold the reaction, suppress the 🥱/😨 decay" owners —
  // a sub-agent run AND an open question can each hold concurrently. A boolean would
  // let one release while the other still needs the hold (review MUST-FIX), so track
  // the set of active owners; the decay is suppressed while ANY owner holds.
  const workOwners = new Set();
  // States the auto-stall path may transition to. Once we've already
  // shown STALL or TIMEOUT we don't downgrade or rearm — only an
  // explicit setState() call (Claude resumed) can move us forward.
  // rc.32: THINKING_DEEPER and THINKING_DEEPEST are stall-promotable
  // too — if the model is stuck in a deep-thinking phase past 45s,
  // STALL still fires.
  const STALL_PROMOTABLE = new Set([
    'THINKING', 'THINKING_DEEPER', 'THINKING_DEEPEST',
    'CODING', 'WEB', 'TOOL', 'WRITING',
  ]);

  const flush = async (stateName, source = 'manual', fromStateOverride = FROM_STATE_UNSET) => {
    if (stopped && !TERMINAL_STATES.has(stateName)) return;
    const spec = STATES[stateName];
    if (!spec) return;
    const emoji = resolveEmoji(spec.chain, availableEmojis);
    if (emoji === currentEmoji) return;
    // For telemetry: prefer the caller-supplied fromState override
    // (setState/cascade timers swap currentState BEFORE calling flush;
    // we want the PRE-swap value in the event, not the post-swap
    // self-loop). Sentinel symbol distinguishes "no override" from
    // a legitimate `null` (= reactor had no prior state, e.g. very
    // first setState in a fresh handleMessage).
    const fromState = fromStateOverride === FROM_STATE_UNSET ? currentState : fromStateOverride;
    const fromEmoji = currentEmoji;
    currentEmoji = emoji;
    lastFlushTs = Date.now();
    // rc.39: emit telemetry on the visible-change moment. Fired
    // synchronously so the events.table row's ts ordering matches
    // the ordering of setMessageReaction calls. Wrapped in try/catch
    // so a buggy onStateChange can't break the reactor.
    if (typeof onStateChange === 'function') {
      try {
        onStateChange({
          fromState, toState: stateName,
          fromEmoji, toEmoji: emoji,
          source, ts: lastFlushTs,
        });
      } catch (err) {
        logError(`onStateChange threw: ${err?.message || err}`);
      }
    }
    // Chain through applyChain so concurrent flushes are sent to
    // Telegram serially in invocation order. Returning the chain
    // promise lets callers await this specific flush completing.
    const myApply = applyChain.then(async () => {
      try {
        await apply(emoji);
      } catch (err) {
        logError(`reaction apply failed (${stateName} → ${emoji}): ${err?.message || err}`);
      }
    });
    applyChain = myApply;
    return myApply;
  };

  const clearStallTimers = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    if (freezeTimer) { clearTimeout(freezeTimer); freezeTimer = null; }
  };

  // rc.32: thinking-deepening cascade. When state is THINKING, schedule
  // auto-promotion at 12s (→ THINKING_DEEPER, 🤨) and 30s (→ THINKING_DEEPEST,
  // 🤓). Any other setState (CODING / TOOL / WEB / WRITING / terminal) clears
  // these. heartbeat() does NOT re-arm them — heartbeat is for keeping
  // STALL/TIMEOUT at bay during silent activity, not for resetting
  // visible deepening progression.
  const clearDeepeningTimers = () => {
    if (deeperTimer) { clearTimeout(deeperTimer); deeperTimer = null; }
    if (deepestTimer) { clearTimeout(deepestTimer); deepestTimer = null; }
  };
  const armDeepeningTimers = () => {
    clearDeepeningTimers();
    if (stopped) return;
    if (currentState !== 'THINKING') return;
    deeperTimer = setTimeout(() => {
      deeperTimer = null;
      if (stopped) return;
      if (currentState !== 'THINKING') return;
      // Promote without going through setState — we want the visual
      // change but NOT to reset the deepest timer (which keeps
      // counting from the original THINKING start). Pass the PRE-swap
      // state to flush() so the telemetry event records the actual
      // transition (THINKING → THINKING_DEEPER), not a self-loop.
      const before = currentState;
      currentState = 'THINKING_DEEPER';
      flush('THINKING_DEEPER', 'cascade-deeper', before);
    }, thinkingDeeperMs);
    deeperTimer.unref?.();
    deepestTimer = setTimeout(() => {
      deepestTimer = null;
      if (stopped) return;
      // Promote from THINKING or THINKING_DEEPER (NOT from CODING etc).
      if (currentState !== 'THINKING' && currentState !== 'THINKING_DEEPER') return;
      const before = currentState;
      currentState = 'THINKING_DEEPEST';
      flush('THINKING_DEEPEST', 'cascade-deepest', before);
    }, thinkingDeepestMs);
    deepestTimer.unref?.();
  };

  const armStallTimers = () => {
    clearStallTimers();
    if (stopped) return;
    // B3 / 0.17.4: while any owner holds (a sub-agent in flight, or an open question
    // waiting on the user), a quiet stretch is EXPECTED — not stalled. Don't arm the
    // 🥱/😨 decay; hold the current face until every owner releases.
    if (workOwners.size > 0) return;
    if (!STALL_PROMOTABLE.has(currentState)) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      // Re-check state at fire time — caller may have advanced past a
      // promotable state in the interim.
      if (stopped || TERMINAL_STATES.has(currentState)) return;
      if (!STALL_PROMOTABLE.has(currentState)) return;
      flush('STALL', 'stall-timer');
    }, stallMs);
    stallTimer.unref?.();
    freezeTimer = setTimeout(() => {
      freezeTimer = null;
      if (stopped || TERMINAL_STATES.has(currentState)) return;
      flush('TIMEOUT', 'freeze-timer');
    }, freezeMs);
    freezeTimer.unref?.();
  };

  const setState = (stateName) => {
    if (stopped) return;
    if (!STATES[stateName]) return;
    // rc.39: capture pre-swap state for telemetry. Pre-rc.39 the
    // currentState was set BEFORE flush, so the onStateChange event's
    // fromState always equalled toState (looked like a self-loop).
    // Pass `before` through to flush so the audit trail records the
    // real transition.
    const before = currentState;
    currentState = stateName;
    lastSetStateTs = Date.now();

    // Terminal states flush immediately, bypassing throttle, and
    // disarm any pending stall promotion.
    if (TERMINAL_STATES.has(stateName)) {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      clearStallTimers();
      clearDeepeningTimers();
      return flush(stateName, 'manual', before);
    }

    // Any explicit setState resets the stall clock — Claude clearly is
    // doing *something*. Re-arm only if the new state is promotable
    // (no point arming over QUEUED/STALL/TIMEOUT itself).
    armStallTimers();
    // rc.32: arm/clear deepening cascade. Only THINKING starts the
    // 8s/20s progression; any other state (CODING / TOOL / etc)
    // clears it (the visible state has moved on, deepening would be
    // a regression).
    if (stateName === 'THINKING') armDeepeningTimers();
    else clearDeepeningTimers();

    // 0.8.0-rc.24: drop the 800ms throttle. Pre-rc.24, when a tool-
    // using turn fired QUEUED → THINKING → TOOL within a few ms,
    // the throttle squashed THINKING (pendingTimer flushed
    // currentState which was already overwritten to TOOL by the
    // time the timer fired). Users saw 👀 → ❰long pause❱ → 🔥 →
    // 🥱, missing the 🤔 transition entirely.
    //
    // Why the throttle is now redundant: rc.11 added applyChain
    // which serializes every apply() call to Telegram in
    // setState() invocation order. So three rapid setStates in
    // 30ms produce three sequential network calls, each ~200-300ms
    // round-trip. User sees 👀 → 🤔 → 🔥 progress, smoothly
    // paced by network latency.
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    return flush(stateName, 'manual', before);
  };

  const clear = async () => {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    clearStallTimers();
    clearDeepeningTimers();
    if (currentEmoji == null) return;
    const fromState = currentState;
    const fromEmoji = currentEmoji;
    currentEmoji = null;
    // rc.39: emit telemetry on clear (toEmoji=null is the "we let go
    // of the message" signal). Mirrors the flush() path.
    if (typeof onStateChange === 'function') {
      try {
        onStateChange({
          fromState, toState: null,
          fromEmoji, toEmoji: null,
          source: 'clear', ts: Date.now(),
        });
      } catch (err) {
        logError(`onStateChange threw: ${err?.message || err}`);
      }
    }
    // Same applyChain serialization as flush — clear() is a state
    // transition, just to "no emoji". Without chaining, a clear()
    // racing with a pending apply (e.g. THINKING flush in flight)
    // could land BEFORE that apply, leaving the emoji visible.
    const myApply = applyChain.then(async () => {
      try { await apply(null); }
      catch (err) { logError(`reaction clear failed: ${err?.message || err}`); }
    });
    applyChain = myApply;
    return myApply;
  };

  const stop = () => {
    stopped = true;
    workOwners.clear();   // B3: defense-in-depth if a reactor is ever reused
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    clearStallTimers();
    clearDeepeningTimers();
  };

  // 0.8.0-rc.16: heartbeat — re-arm stall/freeze timers without
  // changing the visible emoji. Used by SDK pm's onStreamChunk
  // callback so long text generation doesn't unfairly trip STALL
  // (🥱) / TIMEOUT (😨) promotions after 10/30s of no explicit
  // setState calls. Each text chunk is "I'm still here" evidence.
  // Pre-rc.16, prolonged streaming with no tool use was reliably
  // promoted to 🥱 within 10s even though the bot was producing
  // output the whole time.
  const heartbeat = () => {
    if (stopped) return;
    if (!STALL_PROMOTABLE.has(currentState)) return;
    lastSetStateTs = Date.now();
    armStallTimers();
  };

  // B3 / 0.17.4: a named owner ('subagent', 'question', …) holds/releases the
  // reaction. While ANY owner holds, the silence is expected (work in flight, or
  // waiting on the user), so the stall/freeze decay is suppressed and the reactor
  // holds its face. The cascade resumes only when the LAST owner releases. A boolean
  // couldn't represent two concurrent owners. docs/progress-is-not-turn-end-spec.md
  const setWorkInFlight = (active, owner = 'default') => {
    const wasHeld = workOwners.size > 0;
    if (active) workOwners.add(owner); else workOwners.delete(owner);
    const isHeld = workOwners.size > 0;
    if (isHeld === wasHeld) return;
    if (isHeld) clearStallTimers();   // first owner → cancel any pending 🥱/😨 decay
    else armStallTimers();             // last owner released → resume the cascade
  };

  return {
    setState,
    clear,
    stop,
    heartbeat,
    setWorkInFlight,
    // Introspection for tests:
    get currentState() { return currentState; },
    get currentEmoji() { return currentEmoji; },
  };
}

module.exports = {
  createReactionManager,
  classifyToolName,
  resolveEmoji,
  STATES,
  TERMINAL_STATES,
  DEFAULT_THROTTLE_MS,
  DEFAULT_STALL_MS,
  DEFAULT_FREEZE_MS,
  DEFAULT_THINKING_DEEPER_MS,
  DEFAULT_THINKING_DEEPEST_MS,
  GENERIC_FALLBACKS,
};

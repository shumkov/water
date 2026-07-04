// provenance: polygram@0.17.11 lib/process-manager.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * ProcessManager — generic collection of `Process` instances.
 *
 * Holds Map<sessionKey, Process>. Doesn't know or care which concrete
 * Process subclass it's holding. SdkProcess + TmuxProcess both
 * implement the same `lib/process/process.js` interface.
 *
 * Per-session dispatch (send, kill, interrupt, etc.) just delegates
 * to the Process. Collection logic (LRU eviction, killChat, shutdown)
 * lives here.
 *
 * Weighted LRU per Phase 0 F-spike-2: tmux backend is ~10× SDK pm's
 * RSS (545MB vs 50MB). We evict to keep Σ Process.cost ≤ budget
 * rather than count ≤ cap. Default: SDK cost=1, tmux cost=3,
 * budget=10 → "10 SDK | 3 tmux | mixed in between."
 *
 * Lifecycle callbacks (onInit, onClose, onStreamChunk, etc.) get wired
 * to each Process's EventEmitter at spawn. Process emits, pm forwards
 * to operator's callback.
 *
 * Phase 1 only (this file): SDK-only factory; ProcessManager behaviour
 * matches the current `lib/sdk/process-manager.js` API exactly. After
 * Phase 1 lands and tests pass, the old per-bot pm class is deleted.
 *
 * See `docs/0.10.0-process-manager-abstraction-plan.md` for the full
 * design.
 */

'use strict';

const DEFAULT_BUDGET = 10;        // total Σ cost (SDK cost=1, tmux cost=3)
const DEFAULT_LRU_WAIT_MS = 300_000;

// callback name → event name
const CALLBACK_TO_EVENT = {
  onInit:                       'init',
  onClose:                      'close',
  onResult:                     'result',
  onStreamChunk:                'stream-chunk',
  onToolUse:                    'tool-use',
  onAssistantMessageStart:      'assistant-message-start',
  onAutonomousAssistantMessage: 'autonomous-assistant-message',
  onCompactBoundary:            'compact-boundary',
  // 0.12.0-rc.13: per-chat compaction warning. CliProcess emits
  // 'compaction-warn' {kind:'proactive'|'reactive', pct?} when (proactive)
  // context crosses the chat's threshold at turn-end, or (reactive) claude is
  // auto-compacting now. The callback posts a chat message proposing /compact
  // — opt-in per chat. See docs/0.12.0-file-send.md / lib/compaction-warn.js.
  onCompactionWarn:             'compaction-warn',
  // 0.12.0 background-work visibility (Use 3). CliProcess emits 'bg-work-status'
  // {state:'running'|'cleared', count?} when a detached background shell is first
  // observed running idle past its turn, and again when it clears. The callback
  // posts/edits a "⏳ working in background" status message so a long job reads as
  // working, not stuck. See docs/0.12.0-background-work-lifecycle-plan.md.
  onBgWorkStatus:               'bg-work-status',
  // 0.16 busy-aware ceiling: CliProcess emits 'turn-extended' the FIRST time a
  // turn passes the 30-min checkpoint while still provably working. The callback
  // posts a one-time "⏳ still working — /stop to cancel" message so a long turn
  // reads as alive (not the old false "stream interrupted"). See
  // docs/0.16-turn-ceiling-busy-aware-spec.md.
  onTurnExtended:               'turn-extended',
  // 0.12 interactive questions: CliProcess emits 'question-asked'
  // {sessionKey, chatId, threadId, turnId, toolCallId, questions} when claude calls
  // the `ask` tool. The callback (polygram) renders the Telegram inline keyboard;
  // the user's tap/typed answer routes back via pm.answerQuestion → writeQuestionAnswer.
  onQuestionAsked:              'question-asked',
  // 0.12.0 question-progress-resume: CliProcess emits 'question-resumed' (no payload) when a
  // blocking `ask` resolves with a real answer and the turn resumes working. The callback
  // re-arms the per-turn reactor (it cleared during the wait, no hooks re-lit it). See
  // docs/0.12.0-question-resume-progress-spec.md.
  onQuestionResumed:            'question-resumed',
  // 0.13 D2: CliProcess emits 'input-dropped' {turnId, msgId, chatId, source}
  // when a ledgered input was confirmed dropped (never seen/acked by cycle-end
  // + confirm window, contract observed). polygram redelivers ONCE via the D4
  // tail (lib/handlers/drop-redeliver.js).
  onInputDropped:               'input-dropped',
  onQueueDrop:                  'queue-drop',
  onThinking:                   'thinking',
  // Tmux backend: TUI shows in-pane approval prompt. SDK backend
  // uses canUseTool callback directly (no event). Polygram wires
  // onApprovalRequired to route tmux prompts through the SAME
  // approval card UI used by SDK's canUseTool flow.
  onApprovalRequired:           'approval-required',
  // 0.13 P4: the tmux-era rows (onExtraTurnReply/-Started, onAutosteerResolution/
  // -MatchMiss) were removed — zero emitters on any backend since the 0.12 tmux
  // deletion; the 'autosteer-resolution' audit trail returns as D2 ledger events.
  // 0.13 D3: 'turn-start' (UserPromptSubmit; payload {hasPending, anchorMsgId})
  // and 'idle' get polygram-side consumers — the session feedback controller's
  // start/stop edges for cycles with no pending turn. ('idle' is ALSO wired
  // internally for LRU waiters in _wireCallbacks — both fire.)
  onTurnStart:                  'turn-start',
  onIdle:                       'idle',
  // R8: tmux backend autosteer paste failure. TmuxProcess.injectUserMessage
  // fires `inject-fail` when its fire-and-forget paste rejects. Before
  // this was wired the event had no consumer — a failed autosteer was
  // silent until the stale-turn sweep caught it turnTimeoutMs later.
  // The handler logs the failure and clears the ✍ on the failed msgId.
  onInjectFail:                 'inject-fail',
  // 0.10.0: tmux backend turn-phase predicate (observer-only Commit 1
  // of the patience-model unification — see docs/0.10.0-tmux-patience-
  // model-solution.md). TmuxProcess emits `phase-change` on every
  // TurnPhase transition; polygram persists it as `turn-phase-change`
  // in the events DB so the soak can verify the predicate's
  // trajectory against real workloads before Commits 2-3 start
  // consuming turn.phase for control flow. SDK backend never emits
  // this — predicate is tmux-specific.
  onPhaseChange:                'phase-change',
  // 0.10.0 H1: tmux backend hook-based turn observability. TmuxProcess
  // tails a per-session ndjson that claude appends to via
  // `--settings`-injected command hooks (PreToolUse/PostToolUse/
  // UserPromptSubmit/Stop/SubagentStop/Notification). Each event is
  // forwarded here so polygram persists it as `hook-event` in the
  // events DB for the H1 soak. OBSERVER-ONLY — no control flow
  // consumes the events yet (mirrors Commit 1 of the patience-model
  // unification). SDK backend never emits — hooks are tmux-specific.
  // See docs/0.10.0-tmux-hook-observability.md.
  onHookEvent:                  'hook-event',
  // 0.10.0 rc.42 (review-driven #1): tmux backend turn-timeout event.
  // Mirrors sdk-process.js's `_logEvent('turn-timeout', ...)` so both
  // backends emit the same diagnostic. Payload distinguishes
  // `idle-ceiling` vs `hard-backstop` (the H3 racers) so operators can
  // tell a wedged-silent subagent from a runaway tool loop.
  onTurnTimeout:                'turn-timeout',
  // 0.10.0 rc.42 (review-driven #8): tmux backend hook-tail
  // degradation event. The hook ndjson is load-bearing for H3 idle
  // heartbeats; a persistently broken tail silently resurrects
  // msg-884-class kills. Emitting the event surfaces the degradation
  // in the events DB so it's visible in forensics, not just
  // logger.warn.
  onHookTailError:              'hook-tail-error',
  // 0.10.0 rc.42 (review-driven #15): tmux backend stop-hook-resolved
  // event. Fires when a turn settled via the H4 Stop-hook synth path
  // instead of the canonical JSONL `result` (i.e. JSONL was broken or
  // stuck and Stop rescued the turn). The synth's `via: 'stop-hook'`
  // field was previously dead — only the tests read it. Persisting
  // the event lets the soak count how often H4 actually fires its
  // rescue contract.
  onStopHookResolved:           'stop-hook-resolved',
  // 0.10.0 rc.43: claude TUI's "This session is N old…" interactive
  // menu auto-dismissed by `_waitForReady`. Surfacing the event so
  // soak can count how often aged-session resumes hit this path.
  onSessionAgePromptDismissed:  'session-age-prompt-dismissed',
  // 0.12 CliProcess observability — typed hook events from cli-process.js
  // _handleHookEvent. Each gets its own callback so polygram can persist
  // structured rows to the events DB for soak-time aggregate queries.
  //   - hook-lag-sample: Phase 1.8 — per-event lag_ms (target: median<2s, p99<5s)
  //   - tool-result:     Phase 1.3 — PostToolUse durationMs per tool
  //   - subagent-start / subagent-done: Phase 1.3 — typed subagent lifecycle
  //     (we DO get tool-use='Agent' via onToolUse, but agent_type + durationMs
  //      only fire on these typed events). SDK backend never emits — hooks
  //     are CliProcess-specific (and were tmux-specific in 0.10–0.11).
  onHookLagSample:              'hook-lag-sample',
  onToolResult:                 'tool-result',
  onSubagentStart:              'subagent-start',
  onSubagentDone:               'subagent-done',
};

class ProcessManager {
  /**
   * @param {object} opts
   * @param {(sessionKey: string, ctx: object) => Process} opts.processFactory
   *   — required. Returns a Process instance (not yet started).
   * @param {number} [opts.budget=10] — weighted LRU budget
   * @param {object} [opts.db] — used for _logEvent (matches today's pm)
   * @param {object} [opts.logger=console]
   * @param {object} [opts.callbacks={}] — keys: onInit, onClose, ...
   * @param {number} [opts.lruWaitMs] — how long getOrSpawn parks
   *   when all entries are in-flight
   */
  constructor({
    processFactory,
    budget = DEFAULT_BUDGET,
    db,
    logger = console,
    callbacks = {},
    lruWaitMs = DEFAULT_LRU_WAIT_MS,
  } = {}) {
    if (typeof processFactory !== 'function') {
      throw new TypeError('ProcessManager: processFactory function required');
    }
    this.processFactory = processFactory;
    this.budget = budget;
    this.db = db;
    this.logger = logger;
    this.callbacks = { ...callbacks };
    this.lruWaitMs = lruWaitMs;
    this.procs = new Map();           // sessionKey → Process
    this._lruWaiters = [];            // [{ resolve, reject, timer }]
    this._shuttingDown = false;
    // sessionKey → in-flight start() Promise. Lets a concurrent
    // getOrSpawn for the same key await the spawn instead of
    // returning a proc whose start() hasn't resolved (see getOrSpawn).
    this._starting = new Map();
  }

  // ─── Introspection ───────────────────────────────────────────────

  has(sessionKey) { return this.procs.has(sessionKey); }
  get(sessionKey) { return this.procs.get(sessionKey) || null; }
  keys() { return [...this.procs.keys()]; }
  get size() { return this.procs.size; }

  /**
   * Current total cost across all live processes.
   */
  get totalCost() {
    let sum = 0;
    for (const p of this.procs.values()) {
      if (!p.closed) sum += p.cost;
    }
    return sum;
  }

  // ─── Spawn + LRU ─────────────────────────────────────────────────

  /**
   * Returns the Process for sessionKey, spawning if absent.
   * Evicts other processes (oldest non-in-flight first) to make room
   * when adding a new Process would exceed budget.
   *
   * @param {string} sessionKey
   * @param {object} spawnContext — passed through to processFactory + start()
   */
  async getOrSpawn(sessionKey, spawnContext) {
    if (this._shuttingDown) throw new Error('shutdown');

    const existing = this.procs.get(sessionKey);
    if (existing && !existing.closed) {
      // getOrSpawn registers the proc in this.procs BEFORE awaiting
      // start(). A concurrent getOrSpawn for the same key (a second
      // Telegram message landing during the ~11s tmux spawn) would
      // otherwise get this still-spawning proc and call send() on it
      // — pasting a turn into a TUI that is not ready, which silently
      // drops the paste and returns an empty turn (shumorobot
      // production 2026-05-16: msg 2 of a 3-message burst returned
      // "No response generated"). Await the in-flight spawn so every
      // caller receives a proc whose start() has fully resolved.
      const pendingStart = this._starting.get(sessionKey);
      if (pendingStart) await pendingStart;
      // Reload-on-drift (cli): a warm cli proc can't hot-swap model/effort
      // (spawn-time flags). If the resolved config has drifted and the proc is
      // idle, kill it (preserves session_id) and fall through to a cold respawn
      // → --resume keeps the conversation, the new --model/--effort takes
      // effect. In-flight cli procs and SDK procs (no wouldReloadFor — they
      // apply model live) are reused unchanged.
      if (typeof existing.wouldReloadFor === 'function' && existing.wouldReloadFor(spawnContext)) {
        this._logEvent('cli-config-reload', {
          sessionKey,
          from_model: existing.model,
          from_effort: existing.effort,
        });
        await this.kill(sessionKey, 'config-reload');
        // fall through to the cold-spawn path below — respawns with --resume
      } else {
        return existing;
      }
    }

    // Provisional new-process cost — ask the factory but don't start yet.
    const newProc = this.processFactory(sessionKey, spawnContext);
    const newCost = newProc.cost;

    while (this.totalCost + newCost > this.budget) {
      const evicted = this._evictLRU();   // skips inFlight + background-job-pinned
      if (evicted) continue;
      // _evictLRU freed nothing. Policy C — split by WHY:
      if (this._hasPinnedSession()) {
        // A DURABLE blocker (live background job) holds a slot. Don't park on it (could be
        // ~an hour) and don't kill it. The budget caps RSS, not correctness — so treat it as
        // SOFT: spawn over budget + warn; the operator reclaims by /reset-ing a chat.
        const pinned = this._pinnedSessionKeys();
        this._logEvent('lru-overflow-pinned', {
          active: this.procs.size,
          totalCost: this.totalCost,
          budget: this.budget,
          newCost,
          pinned,
        });
        this.logger.warn?.(
          `[pm] budget ${this.budget} exceeded (~${this.totalCost + newCost}): all free slots hold ` +
          `live background jobs [${pinned.join(', ')}]. Spawning over limit — /reset one of those ` +
          `chats to reclaim memory.`,
        );
        break;   // soft overflow — spawn anyway
      }
      // No pin — the blockers are all in-flight TURNS (transient, finish in seconds). Keep the
      // existing behavior: park briefly for a slot rather than needlessly overflow.
      await this._awaitLruSlot();
      if (this._shuttingDown) {
        try { await newProc.kill('shutdown'); } catch {}
        throw new Error('shutdown');
      }
      // Loop again — budget may have freed up.
    }

    // A concurrent getOrSpawn for this key may have registered its own
    // process while we were suspended above (awaiting the config-reload
    // kill or parked on an LRU slot). Registering ours now would
    // overwrite that entry — the overwritten process would keep running
    // outside the Map (never evicted, never killed, resuming the same
    // claude session in parallel). Yield to the competitor instead; our
    // provisional process was never started, so dropping it is free.
    const competitor = this.procs.get(sessionKey);
    if (competitor && !competitor.closed) {
      const competitorStart = this._starting.get(sessionKey);
      if (competitorStart) await competitorStart;
      return competitor;
    }

    this._wireCallbacks(newProc);
    this.procs.set(sessionKey, newProc);
    newProc.lastUsedTs = Date.now();
    // Publish the in-flight start() Promise so concurrent getOrSpawn
    // callers (above) can await it instead of racing the spawn.
    const startP = newProc.start(spawnContext);
    this._starting.set(sessionKey, startP);
    try {
      await startP;
    } catch (err) {
      this.procs.delete(sessionKey);
      throw err;
    } finally {
      this._starting.delete(sessionKey);
    }
    return newProc;
  }

  _evictLRU() {
    let oldest = null;
    let oldestKey = null;
    let pinnedSkipped = 0;
    for (const [k, p] of this.procs.entries()) {
      if (p.inFlight) continue;
      // PIN: a session with a live detached background job is NOT evictable — killing it
      // would silently drop the job (and its report-back wakeup). Skip like inFlight.
      if (p.hasActiveBackgroundWork()) { pinnedSkipped++; continue; }
      // PIN (0.13 D1, S9): a session blocked on an open interactive question is
      // NOT evictable — the keyboard is live and claude is blocked on the ask;
      // killing it silently strands both. Skip like inFlight.
      if (typeof p.hasOpenQuestions === 'function' && p.hasOpenQuestions()) { pinnedSkipped++; continue; }
      if (!oldest || (p.lastUsedTs || 0) < (oldest.lastUsedTs || 0)) {
        oldest = p;
        oldestKey = k;
      }
    }
    if (!oldest) {
      this._logEvent('lru-full', {
        active: this.procs.size,
        totalCost: this.totalCost,
        budget: this.budget,
        pinnedSkipped,
      });
      return false;
    }
    this._logEvent('evict', {
      session_key: oldestKey,
      cost: oldest.cost,
      backend: oldest.backend,
      pinnedSkipped,
    });
    oldest.kill('evict').catch(() => {});
    this.procs.delete(oldestKey);
    return true;
  }

  /**
   * A DURABLE eviction blocker: a non-inFlight session holding a slot because it has a live
   * background job (vs an inFlight TURN, which is transient and frees in seconds). Used to
   * split park-vs-overflow when _evictLRU can free nothing.
   */
  _hasPinnedSession() {
    for (const p of this.procs.values()) {
      if (!p.inFlight && p.hasActiveBackgroundWork()) return true;
      // 0.16 (MF-B): an extended busy-aware-ceiling turn is a DURABLE blocker —
      // it can hold its slot up to the hard backstop (90min), not "seconds" like
      // a normal in-flight turn. Treat it as a pin so getOrSpawn SOFT-overflows
      // (spawn over budget + warn) instead of park-then-reject, which would deny
      // service to other chats for the full 5-min LRU wait.
      if (p.inFlight && typeof p.hasExtendedTurn === 'function' && p.hasExtendedTurn()) return true;
    }
    return false;
  }

  _pinnedSessionKeys() {
    const keys = [];
    for (const [k, p] of this.procs.entries()) {
      if (!p.inFlight && p.hasActiveBackgroundWork()) keys.push(k);
      else if (p.inFlight && typeof p.hasExtendedTurn === 'function' && p.hasExtendedTurn()) keys.push(k);
    }
    return keys;
  }

  async _awaitLruSlot() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._lruWaiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this._lruWaiters.splice(idx, 1);
        this._logEvent('lru-wait-timeout', { wait_ms: this.lruWaitMs });
        reject(new Error(`lru wait timed out after ${this.lruWaitMs}ms`));
      }, this.lruWaitMs);
      this._lruWaiters.push({ resolve, reject, timer });
      this._logEvent('lru-wait', {
        active: this.procs.size,
        totalCost: this.totalCost,
        budget: this.budget,
      });
    });
  }

  _maybeSignalLruWaiter() {
    const w = this._lruWaiters.shift();
    if (w) { clearTimeout(w.timer); w.resolve(); }
  }

  // ─── Per-session dispatch ────────────────────────────────────────

  async send(sessionKey, prompt, opts) {
    const proc = this.procs.get(sessionKey);
    if (!proc) throw new Error(`no process for sessionKey ${sessionKey}`);
    proc.lastUsedTs = Date.now();
    return proc.send(prompt, opts);
  }

  async kill(sessionKey, reason = 'kill') {
    const proc = this.procs.get(sessionKey);
    if (!proc) return false;
    this.procs.delete(sessionKey);
    try { await proc.kill(reason); } catch {}
    this._maybeSignalLruWaiter();
    return true;
  }

  async killChat(chatId) {
    const targets = [];
    const idStr = String(chatId);
    for (const [sk, p] of this.procs.entries()) {
      if (p.chatId === idStr) targets.push([sk, p]);
    }
    for (const [sk] of targets) this.procs.delete(sk);
    const results = await Promise.allSettled(
      targets.map(([_, p]) => p.kill('killChat')),
    );
    for (let i = 0; i < targets.length; i++) {
      this._maybeSignalLruWaiter();
    }
    return results;
  }

  async shutdown() {
    this._shuttingDown = true;
    // Reject parked lru waiters.
    for (const w of this._lruWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('shutdown'));
    }
    this._lruWaiters.length = 0;

    const all = [...this.procs.values()];
    this.procs.clear();
    await Promise.allSettled(all.map((p) => p.kill('shutdown')));
  }

  // ─── Optional async — feature-detect at call site if needed ──────

  /**
   * Shared dispatch for the five optional async methods. Returns the
   * Process method's value on success, `unsupportedDefault` when the
   * Process is missing/closed OR throws UNSUPPORTED_OPERATION /
   * NOT_IMPLEMENTED_YET. Other errors propagate.
   */
  async _invokeOptional(sessionKey, methodName, args, unsupportedDefault) {
    const p = this.procs.get(sessionKey);
    if (!p || p.closed) return unsupportedDefault;
    try { return await p[methodName](...args); }
    catch (err) {
      if (err && (err.code === 'UNSUPPORTED_OPERATION' || err.code === 'NOT_IMPLEMENTED_YET')) {
        return unsupportedDefault;
      }
      throw err;
    }
  }

  async interrupt(sessionKey) {
    return this._invokeOptional(sessionKey, 'interrupt', [], false);
  }

  async setModel(sessionKey, model) {
    return this._invokeOptional(sessionKey, 'setModel', [model], false);
  }

  /**
   * Review F#10: return the backend name for a live process so callers
   * (slash-commands) can word their UX accurately. Returns null if no
   * live process exists.
   */
  getBackend(sessionKey) {
    const p = this.procs.get(sessionKey);
    return (p && !p.closed) ? p.backend : null;
  }

  async applyFlagSettings(sessionKey, settings) {
    return this._invokeOptional(sessionKey, 'applyFlagSettings', [settings], false);
  }

  async setPermissionMode(sessionKey, mode) {
    return this._invokeOptional(sessionKey, 'setPermissionMode', [mode], false);
  }

  async resetSession(sessionKey, opts) {
    const p = this.procs.get(sessionKey);
    // No active process for this key — return no-op. Matches the
    // pre-0.10.0 SDK pm semantic (`closed: false` = "we did not close
    // anything"). Caller can distinguish "session was already gone"
    // from "we just closed an active session."
    if (!p) return { closed: false, drainedPendings: 0 };
    try {
      const result = await p.resetSession(opts);
      // The Process's resetSession closes itself; remove from Map
      // and signal LRU.
      if (this.procs.get(sessionKey) === p) {
        this.procs.delete(sessionKey);
      }
      this._maybeSignalLruWaiter();
      return result;
    } catch (err) {
      if (err.code === 'UNSUPPORTED_OPERATION' || err.code === 'NOT_IMPLEMENTED_YET') {
        const drained = p.drainQueue('RESET_SESSION');
        await this.kill(sessionKey, 'reset');
        return { closed: true, drainedPendings: drained };
      }
      throw err;
    }
  }

  async getContextUsage(sessionKey) {
    return this._invokeOptional(sessionKey, 'getContextUsage', [], null);
  }

  // ─── Optional sync hot-path — never throws (R1-F1) ───────────────

  drainQueue(sessionKey, code = 'INTERRUPTED') {
    const p = this.procs.get(sessionKey);
    if (!p) return 0;
    return p.drainQueue(code);
  }

  injectUserMessage(sessionKey, opts) {
    const p = this.procs.get(sessionKey);
    if (!p || p.closed) return false;
    return p.injectUserMessage(opts);
  }

  // 0.12 interactive questions: hand an answer back to a blocking `ask` tool call.
  // Returns false if the session is gone (claude is dead → nothing to answer).
  answerQuestion(sessionKey, toolCallId, result) {
    const p = this.procs.get(sessionKey);
    if (!p || p.closed || typeof p.writeQuestionAnswer !== 'function') return false;
    return p.writeQuestionAnswer(toolCallId, result);
  }

  steer(sessionKey, text, opts) {
    const p = this.procs.get(sessionKey);
    if (!p || p.closed) return false;
    return p.steer(text, opts);
  }

  // ─── Internal helpers ────────────────────────────────────────────

  /**
   * For each callback in this.callbacks, register a listener on the
   * Process that forwards the event payload to the callback. Wire
   * the standard event names; Process subclasses are free to emit
   * additional events that pm doesn't forward.
   *
   * Also subscribes to 'idle' (Process became inFlight=false) and
   * 'close' (Process closed itself) so the pm can signal parked
   * LRU waiters + remove from the Map.
   */
  _wireCallbacks(proc) {
    for (const [cbName, eventName] of Object.entries(CALLBACK_TO_EVENT)) {
      const fn = this.callbacks[cbName];
      if (typeof fn !== 'function') continue;
      proc.on(eventName, (...args) => {
        try { fn(proc.sessionKey, ...args, proc); }
        catch (err) {
          this.logger.error?.(`[pm:${proc.label}] callback ${cbName} threw: ${err.message}`);
        }
      });
    }
    // Generic 'error' channel — log + forward via onError if provided.
    proc.on('error', (err) => {
      this.logger.error?.(`[pm:${proc.label}] process error: ${err.message}`);
      if (typeof this.callbacks.onError === 'function') {
        try { this.callbacks.onError(proc.sessionKey, err, proc); }
        catch (e) { this.logger.error?.(`[pm:${proc.label}] onError threw: ${e.message}`); }
      }
    });
    // 'idle': a turn completed and pendingQueue is empty. Signal any
    // parked LRU waiter that a non-in-flight slot is available.
    proc.on('idle', () => this._maybeSignalLruWaiter());
    // 'close': process closed itself (iteration loop exited or
    // _closeQuery returned). Remove from the Map + signal LRU.
    proc.on('close', () => {
      if (this.procs.get(proc.sessionKey) === proc) {
        this.procs.delete(proc.sessionKey);
      }
      this._maybeSignalLruWaiter();
    });
    // P0 #3: channels backend emits 'bridge-disconnected' when its socket to
    // the spawned bridge dies (claude crash, bridge crash, EOF). The disconnect
    // handler in CliProcess already drained pendingTurns; here we kill
    // the dead Process so it leaves the Map and frees its LRU slot. Next
    // user-msg on the same sessionKey triggers a fresh getOrSpawn — which
    // calls Process.start with the persisted claudeSessionId, recovering the
    // conversation via `claude --resume`.
    //
    // We don't re-spawn proactively: an idle disconnected session shouldn't
    // burn LRU budget. Lazy respawn on next message is the right shape.
    proc.on('bridge-disconnected', () => {
      this.logger.warn?.(`[pm:${proc.label}] channels bridge disconnected — killing dead instance for lazy respawn`);
      // Kill is idempotent and removes the proc from the Map via the 'close'
      // listener wired just above.
      proc.kill('bridge-disconnected').catch(err => {
        this.logger.warn?.(`[pm:${proc.label}] kill on bridge-disconnect failed: ${err.message}`);
      });
    });
  }

  _logEvent(kind, detail) {
    try {
      this.db?.logEvent?.(kind, detail || {});
    } catch (err) {
      this.logger.error?.(`[pm] logEvent ${kind} failed: ${err.message}`);
    }
  }
}

module.exports = {
  ProcessManager,
  DEFAULT_BUDGET,
  CALLBACK_TO_EVENT,
};

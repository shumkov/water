// provenance: polygram@0.17.11 lib/process/process.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Abstract Process — one running Claude session, regardless of backend.
 *
 * Subclasses ship per backend:
 *   - SdkProcess  (lib/process/sdk-process.js)  — long-lived
 *                  @anthropic-ai/claude-agent-sdk Query
 *   - TmuxProcess (lib/process/tmux-process.js) — claude TUI hosted
 *                  inside a tmux session (Phase 2)
 *
 * State machine: spawned → ready → (turn-in-flight | idle) ↔ closed.
 *
 * Public surface mirrors what polygram's handleMessage, slash-commands,
 * autosteer, edit-correction etc. already call on the current SDK pm.
 * Callers don't branch on subclass.
 *
 * Optional methods come in two flavors per the v3 audit:
 *   - Async ones MAY throw UnsupportedOperationError. Callers `await` +
 *     try/catch around them.
 *   - Sync HOT-PATH ones (drainQueue, injectUserMessage) return a
 *     sentinel value, NEVER throw. Per R1-F1: autosteer's call site
 *     has no try/catch — a throw would crash the message handler.
 *
 * Weighted LRU: each Process advertises its `cost`. The pm evicts
 * to keep Σ cost ≤ budget rather than count ≤ cap. SDK Process cost=1,
 * TmuxProcess cost=3 (per Phase 0 F-spike-2: tmux ~545MB vs SDK ~50MB
 * per session).
 *
 * Phase 0 spike findings — `docs/0.10.0-phase0-spike-findings.md`.
 * Spec — `docs/0.10.0-process-manager-abstraction-plan.md`.
 */

'use strict';

const EventEmitter = require('events');

class UnsupportedOperationError extends Error {
  constructor(method, backend) {
    super(`Operation ${method} not supported by ${backend} backend`);
    this.name = 'UnsupportedOperationError';
    this.code = 'UNSUPPORTED_OPERATION';
    this.method = method;
    this.backend = backend;
  }
}

class Process extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.sessionKey      polygram session key
   * @param {string|null} opts.chatId
   * @param {string|null} opts.threadId
   * @param {string} opts.label           human-readable for logs
   */
  constructor({ sessionKey, chatId, threadId, label } = {}) {
    super();
    if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
      throw new TypeError('Process: sessionKey (string) required');
    }
    // Identity — immutable after construction
    this.sessionKey = sessionKey;
    this.chatId = chatId == null ? null : String(chatId);
    this.threadId = threadId == null ? null : String(threadId);
    this.label = label || `${this.chatId || ''}${this.threadId ? '/' + this.threadId : ''}` || sessionKey;
    // backend identifier — subclass overrides
    this.backend = 'abstract';

    // Mutable state
    this.closed = false;
    this.inFlight = false;
    this.pendingQueue = [];
    this.claudeSessionId = null;
  }

  /**
   * Cost weight for LRU eviction (per Phase 0 F-spike-2).
   * Subclass overrides. Defaults to 1 (SDK-equivalent).
   */
  get cost() {
    return 1;
  }

  // ─── REQUIRED methods — subclass MUST override ─────────────────────

  /**
   * Cold-spawn this process. Wire up internals; mark ready when
   * the underlying claude session is responsive.
   *
   * @param {object} opts — backend-specific. Typically includes:
   *   existingSessionId  — for --resume continuity
   *   model, effort, cwd, chatConfig, botName  — spawn params
   */
  async start(_opts) {
    throw new Error(`${this.constructor.name}.start() must be overridden`);
  }

  /**
   * Send a user turn. Resolves with a PmSendResult on completion.
   *
   * @param {string} prompt
   * @param {object} [opts]
   * @returns {Promise<PmSendResult>}
   */
  async send(_prompt, _opts) {
    throw new Error(`${this.constructor.name}.send() must be overridden`);
  }

  /**
   * Close cleanly. Returns when fully torn down.
   * Idempotent.
   *
   * @param {string} [reason]
   */
  async kill(_reason) {
    throw new Error(`${this.constructor.name}.kill() must be overridden`);
  }

  // ─── OPTIONAL async methods — caller awaits + try/catch ────────────

  async interrupt() {
    throw new UnsupportedOperationError('interrupt', this.backend);
  }
  async setModel(_model) {
    throw new UnsupportedOperationError('setModel', this.backend);
  }
  async applyFlagSettings(_settings) {
    throw new UnsupportedOperationError('applyFlagSettings', this.backend);
  }
  async setPermissionMode(_mode) {
    throw new UnsupportedOperationError('setPermissionMode', this.backend);
  }
  async resetSession(_opts) {
    throw new UnsupportedOperationError('resetSession', this.backend);
  }
  async getContextUsage() {
    throw new UnsupportedOperationError('getContextUsage', this.backend);
  }

  // ─── OPTIONAL sync HOT-PATH methods — never throw (R1-F1) ──────────

  /**
   * Reject all pending turns with the supplied error code.
   * Used by /stop, daemon shutdown, /new.
   *
   * @param {string} [_code='INTERRUPTED']
   * @returns {number} count of pendings drained
   */
  drainQueue(_code = 'INTERRUPTED') {
    return 0;
  }

  /**
   * Inject a user message into the in-flight turn (autosteer +
   * edit-correction). Returns false if the backend can't inject
   * right now (e.g. no live turn) — caller falls through to normal
   * pm.send queue path.
   *
   * @returns {boolean}
   */
  injectUserMessage(_opts) {
    return false;
  }

  /**
   * Does this session have a DETACHED background job running (a `run_in_background`
   * shell that outlives the dispatch turn)? Used by ProcessManager._evictLRU to PIN
   * the session — skip it for eviction the same way `inFlight` is skipped — so a live
   * job isn't silently killed under budget pressure. Default: no signal → false.
   * Backends that can detect detached shells (cli) override this. Must be cheap + sync.
   *
   * @returns {boolean}
   */
  hasActiveBackgroundWork() {
    return false;
  }

  /**
   * 0.13 D1 (S9): does this process have an open interactive question?
   * Backends without the ask feature return false; CliProcess overrides.
   * ProcessManager._evictLRU treats true like inFlight (eviction pin).
   */
  hasOpenQuestions() {
    return false;
  }

  /**
   * Push priority='now' style steer (rare; legacy of OpenClaw shape).
   * Hot-path-safe.
   *
   * @returns {boolean}
   */
  steer(_text, _opts) {
    return false;
  }

  /**
   * Fire-and-forget user-message injection regardless of inFlight
   * state. Used by polygram's slash-command paths (/compact, /reload
   * etc) where we want to send a user-shaped message into the
   * underlying claude session BUT NOT wait for the turn to complete.
   *
   * Differs from `injectUserMessage` (which is for mid-stream fold and
   * requires inFlight on tmux) and `send` (which blocks until turn
   * completion). Default returns false; subclasses override.
   *
   * @returns {boolean} true if message was queued/pasted
   */
  fireUserMessage(_text) {
    return false;
  }
}

module.exports = {
  Process,
  UnsupportedOperationError,
};

// provenance: polygram@0.17.11 lib/error/classify.js (git 746bca6) — adapt: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Error classifier — maps any error from any source to a stable shape.
 *
 * Sources covered: SDK iterator throws (`AbortError` named class plus
 * plain `Error`s), `SDKResultMessage` with subtypes
 * `error_during_execution` / `error_max_turns` / `error_max_budget_usd`
 * / `error_max_structured_output_retries`, per-message
 * `SDKAssistantMessage.error` subtypes (`authentication_failed` /
 * `billing_error` / `rate_limit` / `invalid_request` / `server_error`
 * / `unknown` / `max_output_tokens`), 5xx HTTP errors that bubble
 * through the SDK transport, idle timer fires, polygram-internal
 * Errors with `err.code` set (`INTERRUPTED`, `RESET_SESSION`, etc).
 *
 * Returning the same shape regardless of source means
 * `errorReplyText` in polygram.js doesn't grow N branches every time
 * a new error class shows up — we just add a row to PATTERNS or a
 * `code:` short-circuit at the top.
 *
 * Returned shape:
 *   { kind, userMessage, isTransient, autoRecover, shouldResetSession }
 *
 * AUTO_RECOVER actions ('reset_session' etc) let pm self-heal stuck
 * sessions without waiting for the user to type /new.
 */

'use strict';

// Substring/regex patterns matched against the error string. Order
// is significant only when patterns overlap — `transient5xx` is last
// because the others (auth/billing/format) carry their own status
// codes too. First match wins.
const PATTERNS = {
  // Anthropic API rate limit (429) — "rate-limited", "Too Many
  // Requests", token-bucket exhaustion text.
  rateLimit:        /\b429\b|rate[_ ]?limit|too[_ ]many[_ ]requests|tokens? per minute/i,

  // Billing / quota (402, "insufficient credit"). Fires before any
  // model call when the workspace is out of funds.
  billing:          /\b402\b|payment[_ ]required|billing|insufficient[_ ]credit/i,

  // Auth: 401/403, OAuth token expiry, refresh failure. The 0.8.0
  // plan ships an explicit auth-expired UX (admin-chat notify +
  // pause); 0.7.7 just maps to a friendlier user message.
  authExpired:      /\b401\b|\b403\b|unauthor(ized|ised)|forbidden|token[_ ]expired|oauth[_ ]token[_ ]refresh[_ ]failed/i,

  // Context window exceeded — too many tokens for the model. Usually
  // surfaces as `prompt is too long` from Anthropic; sometimes as
  // generic "exceeds maximum context" depending on SDK version.
  contextOverflow:  /context[_ ](window|length)|prompt[_ ]too[_ ]large|exceeds[_ ]maximum[_ ]context|prompt is too long/i,

  // Role alternation / message ordering — fires when transcript has
  // consecutive same-role messages or a tool_use without matching
  // tool_result. Polygram doesn't generate these directly, but they
  // can surface after an interrupted turn.
  roleOrdering:     /role.*alternat|message[_ ]ordering|consecutive (user|assistant)/i,

  // Tool call missing required `input` field. Indicates corrupted
  // history; user-facing message tells them to /new. Word order
  // varies across Anthropic SDK versions — accept either
  // "input...missing" or "missing...input" within a tool_use mention.
  missingToolInput: /tool[_ ]use.*(input.*missing|missing.*input)|missing tool call input|tool input required/i,

  // Anthropic API rejected an image content block in the conversation.
  // 2026-05-13: shumabit Dina DM hit this after accumulating 53 images
  // over 2 weeks — every new turn 400'd with raw API JSON dumped to
  // the user. Most common cause: a persisted image in the resumed
  // transcript that the API now considers invalid (model snapshot
  // drift, expired URL, bad base64, dimension/size cap, format the
  // API stopped accepting). Recovery: reset_session — /compact has
  // to load the same history so it usually fails too.
  //
  // Anchor on the literal Anthropic phrase to avoid false positives
  // on routine "image" mentions. Tightened by requiring an
  // image-failure verb co-located with "image" or "photo".
  imageProcess:     /(could not process|cannot process|failed to (process|load|decode)|unsupported|invalid|corrupt(?:ed)?)[^\n]{0,80}\b(image|photo)\b|\b(image|photo)\b[^\n]{0,80}(could not process|failed to (process|load|decode)|is (invalid|corrupted|unsupported))/i,

  // Idle/wall-clock timeout from polygram's pm timers, OR
  // model-side timeout. Mapped to a single class; user message is
  // identical either way.
  timeout:          /timed[_ ]out|deadline|idle with no Claude activity|wall-clock ceiling/i,

  // Generic format/validation errors (400 with no other class
  // matching). Rare in practice; included so we don't fall through
  // to "unknown".
  format:           /invalid[_ ]request|invalid[_ ]json|malformed|bad request/i,

  // CLI/channels backend: the claude process exited unexpectedly mid-life
  // ("Claude Code process exited with code N" — e.g. 129/SIGHUP seen on
  // shumabit). A respawn fixes it, so it's transient; the user gets a calm
  // line, never the raw exit code. (known-issue #2.1)
  processExit:      /process exited with code|claude code process exited|exited with (signal|code)/i,

  // Transient HTTP (5xx upstream Anthropic outage / overload). Only
  // these get retried by pm. 521-524/529 are Cloudflare codes seen
  // when Anthropic's edge is degraded.
  transient5xx:     /\b5(00|02|03|2[1-4]|29)\b|temporarily overloaded|server[_ ]error|service unavailable/i,
};

// User-facing message per kind. Polygram-style emoji + concise
// action hint. `null` means "suppress the user-facing reply" (used
// for INTERRUPTED inside the abort-grace window — the user already
// saw their /stop ack).
const USER_MESSAGES = {
  rateLimit:        '⚠️ Rate-limited by Anthropic. Try again in a minute.',
  billing:          '💳 Billing issue on Anthropic — operator needs to top up credits.',
  authExpired:      '🔑 Claude auth expired. Operator has been notified.',
  contextOverflow:  '📚 Conversation got too long. Send /new to start fresh.',
  roleOrdering:     '⚠️ Conversation got into a tangled state. Try /new.',
  missingToolInput: '⚠️ Session history looks corrupted. Try /new.',
  imageProcess:     '🖼 One of the images in this conversation can\'t be re-processed by Claude — likely an older one in the history. Starting a fresh session for this chat.',
  timeout:          '⏳ I went quiet too long without finishing. Try resending or simplifying.',
  format:           '⚠️ Invalid request format. Try rephrasing or /new.',
  processExit:      '🔄 My Claude process stopped unexpectedly — resend in a moment and I\'ll restart it.',
  // Used both for in-flight retry attempts AND for the post-retry-failed
  // bubble-up message. Avoid promising "retrying once" since by the
  // time the user reads it pm has already retried and given up.
  transient5xx:     '☁️ Server hiccup — please try again in a moment.',
};

// Auto-recovery actions for kinds where the session is irrecoverable
// without a reset. polygram.js consults this when result.error fires
// and dispatches `pm.resetSession()` accordingly.
//
// Values map to action names that pm understands:
//   'reset_session' — close current Query, clear sessionId, fresh start
//   (future) 'compact' — manual compact request, if SDK exposes it
const AUTO_RECOVER = {
  roleOrdering:     'reset_session',
  contextOverflow:  'reset_session',
  missingToolInput: 'reset_session',
  imageProcess:     'reset_session',
};

// Typed-code short-circuits — set on errors polygram throws itself
// (see lib/process-manager-sdk.js), not pattern-matched. Keep these
// in sync with the codes pm emits.
const CODES = {
  // 0.7.6 (item H): queue cap drop. Pre-empts pattern matching so
  // the queue-overflow message is exact, not classified.
  QUEUE_OVERFLOW: {
    kind: 'queueOverflow',
    userMessage: '⏭ Couldn\'t keep up — this message was skipped while I was processing newer ones. Resend if it still matters.',
    isTransient: false,
    autoRecover: null,
  },
  // Set on pendings rejected via pm.interrupt() (e.g. /stop). Matched
  // here so the abort-grace silence works — user already saw the
  // /stop ack, no need to surface another error.
  INTERRUPTED: {
    kind: 'interrupted',
    userMessage: null,
    isTransient: false,
    autoRecover: null,
  },
  // Set when pm.resetSession() drains the queue for any reason
  // (auto-recovery, /new, /reset, auth-expired).
  RESET_SESSION: {
    kind: 'resetSession',
    userMessage: '✨ Started a fresh session.',
    isTransient: false,
    autoRecover: null,
  },
  // 0.8.0 auth-expired path — set on every pending the daemon
  // rejects after a 401 surface. Distinct from authExpired pattern
  // because it's polygram saying "I already noticed and paused"
  // rather than "I just hit a 401 and am about to handle it".
  AUTH_EXPIRED: {
    kind: 'authExpired',
    userMessage: '🔑 The bot needs re-auth. The operator has been notified. Try again in a few minutes.',
    isTransient: false,
    autoRecover: null,
  },
  // Review F#5: channels-specific error codes. Pre-fix these fell through
  // to the generic 'unknown' kind (errorReplyText: "Hit a snag. Try
  // resending.") which lies about what happened. Mirrors the rc.46→rc.47
  // tmuxToolWedge fix where backend-specific codes needed their own kinds.
  //
  // BRIDGE_DISCONNECTED: thrown by CliProcess when the mcp-bridge
  // socket drops mid-turn (claude crashed, bridge process died, etc).
  // isTransient: true because the daemon retries spawning the backend.
  BRIDGE_DISCONNECTED: {
    kind: 'bridgeDisconnected',
    userMessage: '🔌 Lost the bridge to Claude mid-turn. Retrying — please resend if I don\'t reply in 30s.',
    isTransient: true,
    autoRecover: null,
  },
  // CHANNELS_HANDSHAKE_TIMEOUT: bridge process never sent session_init
  // within the handshake window during start(). Usually means the bridge
  // crashed pre-init or the socket file is stale.
  CHANNELS_HANDSHAKE_TIMEOUT: {
    kind: 'channelsHandshakeTimeout',
    userMessage: '⏳ Couldn\'t start a Claude session — the bridge didn\'t respond in time. Try again in a moment.',
    isTransient: true,
    autoRecover: null,
  },
  // CHANNELS_DIALOG_TIMEOUT: a permission / usage-limit / context-overflow
  // dialog opened mid-turn and we couldn't auto-respond within the dialog
  // window. The turn is dead; user needs to retry.
  CHANNELS_DIALOG_TIMEOUT: {
    kind: 'channelsDialogTimeout',
    userMessage: '🚧 Claude hit a dialog (permission/usage-limit) mid-turn and I couldn\'t auto-respond in time. Please resend.',
    isTransient: false,
    autoRecover: null,
  },
  // TMUX_SESSION_GONE: claude exited during spawn so the tmux session vanished
  // before the channel went live (the startup-gate's captureWide hit "can't
  // find pane"). Usual cause: an unresumable aged session whose "Resume from
  // summary?" /compact exits code 0. The dispatcher poison-clears the session
  // on this code, so a resend genuinely starts fresh and works — hence the
  // calm "send it again" copy instead of the old raw "[startup-gate]…" leak.
  TMUX_SESSION_GONE: {
    kind: 'tmuxSessionGone',
    userMessage: '🔄 That chat got stuck starting up, so I reset it. Send your message again and I\'ll pick it up fresh.',
    isTransient: false,
    autoRecover: null,
  },
  // TURN_TIMEOUT: per-turn time cap fired because the turn went QUIET with no
  // detectable progress (0.16: the busy-aware checkpoint extends a turn that's
  // provably working, so reaching this code means the probe saw no streaming /
  // no active shell — a genuine stall/wedge, not a long-but-working turn). Not
  // transient. Copy must not name a number (the 2026-06-11 UMI false-⏱ rendered
  // "10-minute" under a 60-minute cap).
  TURN_TIMEOUT: {
    kind: 'turnTimeout',
    userMessage: '⏱ This one went quiet with no progress, so I stopped waiting — send /stop to clear it, or resend if you still need it.',
    isTransient: false,
    autoRecover: null,
  },
  // TURN_MAX_EXCEEDED (0.16): the busy-aware checkpoint kept extending a turn
  // that WAS still working, until it hit the hard wall-clock backstop
  // (turnHardMaxMs, default 90 min). Distinct from TURN_TIMEOUT (which means
  // "went quiet") — here it ran genuinely long and we capped it for safety.
  TURN_MAX_EXCEEDED: {
    kind: 'turnMaxExceeded',
    userMessage: '⏱ This ran past the max time and I had to stop it. Resend if you still need it — or break it into smaller steps.',
    isTransient: false,
    autoRecover: null,
  },
};

/**
 * Classify an error from any source.
 *
 * Accepts:
 *   - Error / object with `code` / `message`
 *   - SDKResultMessage with `subtype` and optional `error`
 *   - SDKAssistantMessage.error (string subtype like 'rate_limit')
 *   - plain string
 *   - null/undefined (returns the 'unknown' shape)
 *
 * Returns an object with stable shape:
 *   {
 *     kind: 'rateLimit' | 'billing' | ... | 'unknown' | code-keyed kind,
 *     userMessage: string | null,   // null means suppress reply
 *     isTransient: boolean,         // true → pm should retry once
 *     autoRecover: 'reset_session' | null,
 *   }
 */
function classify(err) {
  // Typed-code short-circuit takes priority over pattern matching.
  // Errors polygram constructs internally (QUEUE_OVERFLOW etc.) set
  // `err.code` so we don't depend on string content.
  const code = err?.code;
  if (code && CODES[code]) {
    return { ...CODES[code] };
  }

  // SDKAssistantMessage.error is a short string code from a fixed
  // union — match those directly, not via regex. Result subtypes
  // are checked LATER (after pattern matching) so a more-specific
  // pattern in the message text (e.g. 'HTTP 401' inside an
  // error_during_execution subtype) wins over the generic subtype
  // mapping that defaults the entire error_during_execution class
  // to transient.
  if (typeof err === 'string') {
    const sdkMessageError = matchSdkMessageError(err);
    if (sdkMessageError) return sdkMessageError;
  }

  const msg = extractMessage(err);
  for (const [kind, re] of Object.entries(PATTERNS)) {
    if (re.test(msg)) {
      return {
        kind,
        userMessage: USER_MESSAGES[kind],
        isTransient: kind === 'transient5xx' || kind === 'rateLimit' || kind === 'processExit',
        autoRecover: AUTO_RECOVER[kind] ?? null,
      };
    }
  }

  // After pattern matching: try SDK result subtypes. A bare string
  // like 'error_during_execution' (no message context) lands here
  // and gets the friendly transient5xx kind. Object inputs with a
  // subtype field also land here when their message text didn't
  // match a more specific pattern.
  if (typeof err === 'string') {
    const sdkResultSubtype = matchSdkResultSubtype(err);
    if (sdkResultSubtype) return sdkResultSubtype;
  }
  if (err?.subtype && typeof err.subtype === 'string') {
    const sdkResultSubtype = matchSdkResultSubtype(err.subtype);
    if (sdkResultSubtype) return sdkResultSubtype;
  }

  // Fall-through: an error we couldn't classify. Do NOT echo the raw text
  // to the user (known-issue #2.2) — it leaks internal identifiers (tmux
  // names, gate vocabulary, pane dumps; the 2026-06-03 incident). The full
  // raw string is preserved by callers in the events log
  // (handler-error.detail_json) for forensics; the user gets a calm,
  // generic, actionable line.
  return {
    kind: 'unknown',
    userMessage: '⚠️ Something went wrong on my end — try resending. If it keeps happening, send /new.',
    isTransient: false,
    autoRecover: null,
  };
}

// Pull a string out of whatever shape the caller passed.
function extractMessage(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  if (err.error) return String(err.error);
  return String(err);
}

// SDKAssistantMessage.error fields are a small fixed union
// (sdk.d.ts:2343). Map directly so we don't depend on transport-
// specific error text.
const SDK_MESSAGE_ERROR_MAP = {
  authentication_failed: 'authExpired',
  billing_error:         'billing',
  rate_limit:            'rateLimit',
  invalid_request:       'format',
  server_error:          'transient5xx',
  unknown:               'unknown',
  max_output_tokens:     'format', // closest match — model gave up
};
function matchSdkMessageError(s) {
  const kind = SDK_MESSAGE_ERROR_MAP[s];
  if (!kind) return null;
  if (kind === 'unknown') return null; // fall through to pattern match
  return {
    kind,
    userMessage: USER_MESSAGES[kind] ?? null,
    isTransient: kind === 'transient5xx' || kind === 'rateLimit',
    autoRecover: AUTO_RECOVER[kind] ?? null,
  };
}

// SDKResultMessage.subtype values (sdk.d.ts:3121). Most are
// terminal-error indicators that don't have a clean pattern equivalent.
//
// `error_during_execution` is the SDK's catch-all for "something went
// wrong mid-turn" — could be a transient stream/network blip OR a
// systemic model issue. We treat it as transient (1 retry is cheap;
// if it's systemic the second attempt fails fast). Pre-rc.5 this was
// mapped to 'unknown' which fell through to the default "Hit a snag:
// error_during_execution" template — leaking the SDK enum to users.
const SDK_RESULT_SUBTYPE_MAP = {
  error_during_execution:           'transient5xx',
  error_max_turns:                  'format',
  error_max_budget_usd:             'billing',
  error_max_structured_output_retries: 'format',
};
function matchSdkResultSubtype(s) {
  if (s === 'success') return null;
  const kind = SDK_RESULT_SUBTYPE_MAP[s];
  if (!kind || kind === 'unknown') return null;
  return {
    kind,
    userMessage: USER_MESSAGES[kind] ?? null,
    // Derive transience from the kind so error_during_execution →
    // transient5xx → isTransient=true, matching the pattern-match
    // branch's behaviour. pm guards retry with firstAssistantSeen=
    // false, which prevents budget waste when the turn already had
    // billable assistant output.
    isTransient: kind === 'transient5xx' || kind === 'rateLimit',
    autoRecover: AUTO_RECOVER[kind] ?? null,
  };
}

// True if pm's iteration loop should sleep and retry the user
// message ONCE before giving up. Currently only transient5xx and
// rateLimit. Per v4 plan §6.6 H1/M2, retry only fires when the
// turn produced ZERO assistant messages (idempotency); pm checks
// that flag, not this function.
function isTransientHttpError(err) {
  return classify(err).isTransient;
}

// 2026-05-13: detect the case where SDK reports result_subtype=success
// BUT the assistant text is actually an API error JSON the SDK wrapped
// as if it were the model's reply. Happens when the resumed session's
// transcript has data the API can't reload — most commonly an image
// content block. Pattern is distinctive ("API Error: <code> {...
// type:error ...}") so false positives are unlikely.
//
// When this matches:
//   - The text we'd deliver to Telegram is garbage (raw JSON).
//   - The Claude session is wedged — every future turn will fail the
//     same way until reset.
// Returns the same shape as classify() so callers can use it uniformly,
// or null when the text looks like a legitimate assistant reply.
const WEDGED_SESSION_RE = /^API Error: \d{3}\s+\{[^}]*"type"\s*:\s*"error"/;

function detectWedgedSessionError(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (!WEDGED_SESSION_RE.test(text)) return null;
  // Once we've confirmed it's a wrapped API error, run classify on the
  // text — it picks up imageProcess / rateLimit / billing / etc. from
  // the JSON body. classify is robust to JSON-ish input.
  const cls = classify(new Error(text));
  // If classify fell through to 'unknown', return a safe imageProcess
  // shape — wedged sessions are most commonly image-driven and the
  // recovery action (reset_session) is correct for all wedge classes.
  if (cls.kind === 'unknown') {
    return {
      kind: 'imageProcess',
      userMessage: USER_MESSAGES.imageProcess,
      isTransient: false,
      autoRecover: 'reset_session',
    };
  }
  return cls;
}

/**
 * 0.16: decide how the streamed-reply catch (polygram.js handleMessage) should
 * cap the bubble + set the reactor when a turn ends in error. Extracted as a
 * pure fn so the decision is unit-testable (the catch itself isn't unit-reachable).
 *
 * Returns { errorSuffix, reactorState }:
 *   - errorSuffix: appended to streamer.finalize('') (null = no suffix)
 *   - reactorState: reactor.setState(...) value
 *
 * Turn-end timeouts (TURN_TIMEOUT = went quiet, TURN_MAX_EXCEEDED = hit hard cap)
 * are real stops → the "stream interrupted" suffix is honest here. Note: the cli
 * backend's TURN_TIMEOUT err.message is `turn timeout (...)` which does NOT match
 * the legacy /wall-clock ceiling|idle.../ regex, so we branch on err.code, not
 * the message text (a v1-review correction).
 */
function classifyTurnEndError(err) {
  const code = err?.code;
  // The cli backend sets err.code (TURN_TIMEOUT / TURN_MAX_EXCEEDED). The SDK +
  // tmux backends reject with a MESSAGE and NO code (e.g. "Turn exceeded 1800s
  // wall-clock ceiling" / "Timeout: 600s idle with no Claude activity"), so we
  // MUST keep the legacy message regex as a fallback — without it those
  // backends' timeouts flip from the calm ⏱ TIMEOUT reactor to the scary ERROR
  // one (regression caught in the 0.16 code review).
  const isTimeout = code === 'TURN_TIMEOUT'
    || code === 'TURN_MAX_EXCEEDED'
    || /wall-clock ceiling|idle with no Claude activity/i.test(err?.message || '');
  return { errorSuffix: 'stream interrupted', reactorState: isTimeout ? 'TIMEOUT' : 'ERROR' };
}

module.exports = {
  classify,
  classifyTurnEndError,
  detectWedgedSessionError,
  isTransientHttpError,
  PATTERNS,
  USER_MESSAGES,
  AUTO_RECOVER,
  CODES,
};

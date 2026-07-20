# AUTH_DISABLED handling — Design Spec

## 1. Problem

When Anthropic disables Claude Code / subscription access on an account (e.g.
non-payment), the `claude` CLI streams a policy-string text ("disabled Claude
subscription access... enable (Claude Code) access... use an Anthropic API key
instead") instead of an HTTP 401/403. Nothing in the stack recognizes this
today, so the turn sits until the 10-minute idle-ceiling fires with
`err.code = 'TURN_TIMEOUT'`. `lib/error/classify.js`'s `TURN_TIMEOUT` case maps
that to the generic "went quiet" canned reply: 10 minutes late, with no real
cause surfaced. Worse, the adjacent `authExpired` case (a different condition —
OAuth token expiry) claims "Operator has been notified", which is not true for
today's TURN_TIMEOUT fallback and must not be copied verbatim onto this new
condition unless we actually wire an escalation (we do, below).

**UPDATE (2026-07-20): the orchestra sibling fix shipped mid-implementation
of this spec** — `@shumkov/orchestra` 0.4.0 (`fix/auth-disabled-detection`
merged, `fix: detect Anthropic subscription-access-disabled mid-turn
(AUTH_DISABLED)`) adds a two-consecutive-poll, bounded-tail regex match on
Anthropic's fixed disablement string to `CliProcess._pollMidTurnDialogs`
(the existing 5s tmux pane-capture watchdog), and on confirmation rejects
every pending turn with `err.code = 'AUTH_DISABLED'`, mirroring
`resetSession`'s match-and-reject drain shape. water's `package.json` has
been bumped to `^0.4.0` and `npm install`ed — the contract below is now
verified against real orchestra source, not assumed. Original paragraph
(now historical): this was drafted against an *unimplemented* branch (0
commits ahead of `main`), building only against the documented contract
shape (`err.code === 'AUTH_DISABLED'`), matching `TURN_TIMEOUT`'s pattern.

## 2. Contract being built against

```
err.code === 'AUTH_DISABLED'
```

Same shape/pattern as `TURN_TIMEOUT` / `TURN_MAX_EXCEEDED` — an `Error` object
with a `.code` string, thrown/rejected out of `pm.send()` inside
`dispatcher.js`'s `dispatch()` try block. No other fields are guaranteed by
the (not-yet-written) contract, so we key off `err.code` only, exactly like
the existing timeout codes (`lib/error/classify.js:454`).

**Verified against real orchestra 0.4.0 source** (`node_modules/@shumkov/orchestra/lib/process/cli-process.js`
after the version bump): `_rejectPendingTurnsAuthDisabled()` constructs
`err.code = 'AUTH_DISABLED'` with a static, non-PII `err.message` and calls
`pending.reject(err)` for every entry in `pendingTurns` (and matching
`pendingQueue` rows) — exactly the shape assumed here. Two details worth
carrying forward: (1) `err.message` deliberately excludes the captured pane
excerpt (their own privacy precedent, cli-process.js's L13-incident note) —
so nothing PII-bearing flows through `classify()` from this code path either
way; (2) orchestra's own `classify()` does NOT get an `AUTH_DISABLED` entry,
by deliberate decision documented in their spec — it's unreachable from
`CliProcess` (only imported by the unrelated SDK backend), so water/polygram
each own their own `classify()` case, which is exactly what §3.1 does.

## 3. Design

### 3.1 Layer 1 — `lib/error/classify.js`

Add a `CODES.AUTH_DISABLED` entry, mirroring the existing typed-code
short-circuits. Every existing `CODES` entry documents itself with a block
comment **above** the key, not inline trailing comments (see `AUTH_EXPIRED`,
`TURN_TIMEOUT`) — match that:

```js
// AUTH_DISABLED: Anthropic disabled Claude Code / subscription access on this
// account (e.g. non-payment). Account-wide, not session-local — resetting the
// session accomplishes nothing, and it isn't a retry-able blip, so no
// autoRecover and not transient. Silence to the WhatsApp partner (userMessage:
// null) — a billing/infra outage on our end isn't their problem (§3.4).
AUTH_DISABLED: {
  kind: 'authDisabled',
  userMessage: null,
  isTransient: false,
  autoRecover: null,
},
```

`classify()`'s existing typed-code short-circuit (`if (code && CODES[code])`)
picks this up for free — no changes to the matching logic itself, only a new
table entry, exactly like `TURN_TIMEOUT`/`BRIDGE_DISCONNECTED`/etc.

### 3.2 Layer 3 — a dedicated ops module, not state inside the dispatcher

**Revised after review** (see review notes at the end of this section) — the
original draft put a dedupe flag + the `escalate` call directly inside
`lib/handlers/dispatcher.js`'s catch block. Two review findings killed that:

1. Every other stateful escalation consumer in this codebase
   (`sla-watchdog.js`, `transport-watchdog.js`) is its own file under
   `lib/ops/`, unit-tested in `tests/ops.test.js`. `dispatcher.js` today has
   exactly two pieces of closure state, both **per-session** (`locks`,
   `inFlightSenders`, `dispatcher.js:25,32`) — it has no account-wide state,
   and deliberately delegates side effects to injected callbacks
   (`classify`, `errorReply`, `deliverFallback`, `feedback`). Account-wide
   escalation state doesn't belong there.
2. Calling `escalate()` synchronously (awaited) inside the catch block would
   hold that chat's per-session dispatch lock (`dispatcher.js:51`,
   `release()` only runs in `finally`) for however long `escalate()` takes —
   up to its IPC call's timeout. No other escalate call site in this
   codebase runs while holding a chat lock; this would be a new risk class.

**New module: `lib/ops/auth-disabled-gate.js`**, same shape as
`sla-watchdog.js`/`transport-watchdog.js` (constructor takes `escalate`,
`logEvent`, `logger`; returns plain functions; own section in
`tests/ops.test.js`):

```js
'use strict';

function createAuthDisabledGate({ escalate = null, logEvent = () => {}, logger = console } = {}) {
  let escalated = false; // provisional latch — true means "an escalate attempt is in flight
                          // or confirmed sent for the current outage", not "outage is active"

  function onFailure({ sessionKey, msgId } = {}) {
    // Fires on EVERY AUTH_DISABLED-coded turn failure, not deduped — this is what feeds
    // the heartbeat.js counter (§3.3), independent of whether escalate() itself dedupes.
    logEvent('auth-disabled', { chatJid: sessionKey, msgId });
    logger.error?.(`[auth] Claude Code access disabled — turn for ${sessionKey} rejected. Re-enable in the Anthropic Console or set ANTHROPIC_API_KEY.`);

    if (escalated) return;
    escalated = true; // set BEFORE the async call — synchronous check-and-set, no interleaving
                       // across concurrently-failing chats (see review note on ordering below)
    if (!escalate) return;
    // Fire-and-forget: must NOT be awaited by the caller (dispatcher's catch block), so a
    // slow/hung IPC call never holds a per-chat dispatch lock.
    Promise.resolve(escalate('CRITICAL', 'water: Claude Code access disabled -- re-enable in Console or set ANTHROPIC_API_KEY'))
      .then((sent) => { if (!sent) escalated = false; })  // no-op (no ipcBot) or failed send →
      .catch(() => { escalated = false; });                // un-latch so the NEXT occurrence retries
  }

  // Any successful turn proves the outage ended (AUTH_DISABLED is account-wide — nothing can
  // succeed while it's active), so this re-arms even if called on every successful dispatch.
  function onSuccess() { escalated = false; }

  return { onFailure, onSuccess };
}

module.exports = { createAuthDisabledGate };
```

Design notes (folded in from review):
- **Not "latch on attempt"** — the original draft set the flag `true` and
  left it there regardless of whether `escalate()` actually delivered. That
  meant a single transient Telegram/IPC hiccup on the *first* AUTH_DISABLED
  turn would silently suppress escalation for the rest of a potentially
  multi-hour outage, with no other alerting path guaranteed (§3.3's doctor
  check is not yet agreed scope — see Open Questions). The revised design
  un-latches (`escalated = false`) when `escalate()` returns `false` (no-op
  / not configured) or throws, so the *next* AUTH_DISABLED occurrence
  retries. This trades stricter "exactly once" dedupe for "don't ever go
  permanently silent from one bad attempt" — the right trade for a paging
  path.
- **The flag set precedes the async call, unconditionally** (not gated on
  `escalate()`'s resolution) specifically so concurrent chats failing in the
  same tick can't double-fire — the check-and-set is synchronous, matching
  Node's run-to-completion semantics (no `await` between the `if
  (escalated)` check and setting it `true`). If this is ever refactored to
  `await escalate(...)` before setting the flag, that reintroduces the race
  across concurrently-failing chats. Keep the ordering.
- **Precedent**: `sla-watchdog.js`'s `latched` `Set` (keyed per stuck
  message, never manually reset — a new stuck message gets a new key) is
  the existing "escalate once" pattern in this codebase. A single boolean
  is the right granularity here (not a per-message Set) because
  AUTH_DISABLED is account-wide, not per-turn — but the *shape* (state
  checked synchronously before any side effect, set on the attempt) follows
  that precedent rather than inventing a new one.

**`lib/handlers/dispatcher.js` changes** — minimal, matches its existing
object-shaped-dependency-with-no-op-default pattern (see `feedback = {
begin: () => ({ end() {} }) }`, `dispatcher.js:23`):

- New constructor dependency: `authDisabledGate = { onFailure: () => {},
  onSuccess: () => {} }`.
- In the catch block, when `info?.kind === 'authDisabled'`:
  `authDisabledGate.onFailure({ sessionKey, msgId: msg.msgId });`
- On the happy path, right before the existing `return result;`
  (`dispatcher.js:111`): `authDisabledGate.onSuccess();` — cheap/no-op when
  not currently latched, so calling it on every successful turn (not just
  ones following an outage) is fine.

`errorReply` is **not** called for this kind (`userMessage: null` already
guards that via the existing `if (!isReplay && info?.userMessage &&
errorReply)` check — no new branch needed).

**`water.js` wiring** — the original draft said "pass `escalate: (sev, t) =>
escalator.escalate(sev, t)` into `createDispatcher({...})` at
`water.js:165-169`", but review caught that `createEscalator(...)` isn't
constructed until `water.js:184` — **after** `createDispatcher` runs at
line 165. That ordering must change: hoist the `esc = acc.escalation || {}`
+ `createEscalator({...})` lines (currently `water.js:183-184`) to just
before the `createDispatcher({...})` call, construct
`createAuthDisabledGate({ escalate: (sev, t) => escalator.escalate(sev, t),
logEvent, logger })` right after, and pass `authDisabledGate` into
`createDispatcher({...})`. This is a small reorder (moving ~2 lines up
~15 lines), not a restructure — nothing between the old and new
`createEscalator` call sites depends on dispatcher or vice versa.

### 3.3 Netdata diagnosability — `lib/ops/heartbeat.js`

Ivan's requirement: this condition must be diagnosable in Netdata as **its
own signal**, distinct from the generic `escalated` counter, and must surface
**even if the Telegram escalate path is a no-op** (see §4 finding).

Add a new prepared statement + snapshot field, mirroring the existing
`escalated` (count of `escalation-failed` events in the trailing hour)
exactly, just keyed on the new event kind:

```js
const authDisabled = db.prepare("SELECT COUNT(*) c FROM events WHERE kind='auth-disabled' AND ts > ?");
...
authDisabled: authDisabled.get(now() - 3600_000).c,
```

Exposed in both `snapshot()` (written to `heartbeat.json`) and
`healthPayload()` (the `/healthz` JSON body) — literally "feed the /healthz
payload" as instructed.

**Caveat, important:** `/healthz`'s 200-vs-503 decision
(`lib/transport/webhook-receiver.js:55`) is driven **only** by
`heartbeatAgeS` staleness, not by any of the counts in the payload. Adding
`authDisabled` to the JSON body does not, by itself, cause netdata's
httpcheck to alert — netdata's httpcheck here checks HTTP status code, not
JSON field values (nothing in this repo configures a body-match check). So
satisfying the *letter* of "feeds the /healthz payload" does not by itself
satisfy the *intent* ("Netdata surfaces an active auth-disabled outage").

**Open question, not designed here (downgraded from the original draft's
implementation sketch after review — see Open Questions §7):** the
heartbeat.json/`/healthz` change makes the condition *diagnosable*
(a human checking `/healthz` or `heartbeat.json` during an incident can see
`authDisabled > 0`), but does not make netdata *auto-page* on it, since
`/healthz`'s 200-vs-503 is staleness-only and nothing in-repo configures a
body-match httpcheck. Whether that gap is worth closing (e.g. via a
`bin/water-doctor.js` check, since its 5-minute cron's non-zero exit is
this project's documented netdata-visible fallback per
`docs/SPEC.md:507-509`) is a scope decision for Ivan, not pre-built here.

### 3.4 Silence to the WhatsApp partner

`userMessage: null` on `CODES.AUTH_DISABLED` — the partner sees no reply
during the outage (`errorReply` is skipped, same mechanism as `INTERRUPTED`
and `RESET_SESSION`'s `null` messages today). Rationale: a billing/infra
outage on our end isn't the partner's problem, and leaking "the bot's Claude
subscription got disabled" is bad optics for a paid product surface. This
matches the existing house precedent this codebase already documents for
outages of this class — total silence over a soft "back shortly" holding
message. (The SLA watchdog's holding-reply is a *different* mechanism, keyed
off stuck-turn duration, not off this specific error kind — it is not
triggered or suppressed by this change; a message during an AUTH_DISABLED
outage would still eventually get a holding reply from the SLA watchdog once
it crosses `holdAfterMs`, since that path doesn't consult `classify()`. This
is accepted as-is — out of scope for this fix — but noted since it means the
"total silence" decision is not airtight against the SLA watchdog's separate
holding-reply trigger.)

## 4. Finding: is `escalation.ipcBot` actually configured for the deployed umi water account?

**Cannot be verified from this repo.** `config.json` is gitignored
(`.gitignore:7`) and not present in this worktree — the deployed value is
unknown. `docs/SPEC.md:779` and `config.example.json` both show
`escalation.ipcBot: "shumabit"` as the *documented design intent*, but:

- Per this project's own memory (`project-water-whatsapp-daemon.md`, dated
  2026-07-04): water was **not yet deployed** as of that date — "current
  Baileys bot still serves prod." Recent commits (#6-#9, dated after that
  memory) suggest active development continued, but none confirm a
  production cutover or a real `~/water/config.json` on the VPS.
  Recent-commit content deals with WhatsApp typing/media/ask-tool fixes
  unrelated to deployment status.
- `~/INFRASTRUCTURE.md` (this Mac's authoritative infra doc) does not
  mention `water` or the `water-umi.service` systemd unit anywhere — only
  the *polygram* `shumabit`/`umi-assistant` bots (now on the UMI VPS,
  unrelated repo).

So whether `escalate('CRITICAL', ...)` actually reaches Ivan's Telegram in
production is **unknown** from what's checkable in this repo/session. This
materially affects whether §3.2's escalate wiring has any live effect today
— which is exactly why §3.3's water-doctor/Netdata path matters as a
config-independent fallback: it works whether or not `ipcBot` is set,
because water-doctor.js's exit code is what feeds netdata regardless of the
Telegram path's config state (`createEscalator`'s own no-op branch,
`escalate.js:28-33`, already documents this precedent: "Netdata is the
single alert surface for this deployment" when `ipcBot` is unset).

## 5. Test plan (TDD-for-bug-fixes)

All new tests are added against **mocked/stubbed** rejections
(`Object.assign(new Error('...'), { code: 'AUTH_DISABLED' })`), the same
pattern the existing `TURN_TIMEOUT` tests use in the sibling polygram repo's
`tests/error-classify.test.js:92-98` — water currently has **no**
`tests/classify.test.js` at all (untested by dedicated file, only reachable
indirectly), so this also adds first-ever direct coverage for `classify()`
in this repo.

1. **`tests/classify.test.js` (new file):**
   - RED: a test asserting `classify({code:'AUTH_DISABLED', message:'...'})`
     returns `kind: 'authDisabled'` — run against pre-fix `classify.js`,
     confirm it currently falls through pattern-matching to `kind: 'unknown'`
     (no pattern matches "disabled Claude subscription access" text, no
     CODES entry exists) — this is the reproduction of the gap.
   - GREEN: after adding `CODES.AUTH_DISABLED`, same test passes.
   - Additional assertions: `userMessage === null`, `isTransient === false`,
     `autoRecover === null`.
   - Extend the existing `CODES` shape-invariant test (mirrors polygram's
     `tests/error-classify.test.js:493-497` pattern, if water has an
     equivalent — else add one) so `AUTH_DISABLED` is covered by any
     "every CODES entry has the required shape" loop.

2. **`tests/ops.test.js` (extend — new `--- auth-disabled gate ---` section,
   same file/pattern as the existing escalator/SLA/transport-watchdog
   sections):**
   - `onFailure()` calls `escalate('CRITICAL', ...)` exactly once across two
     consecutive calls (dedupe).
   - `onFailure()` logs `logEvent('auth-disabled', ...)` on **every** call,
     even the deduped ones (independent of the escalate dedupe).
   - When the injected `escalate` resolves `false` (simulating no-op/failed
     send), the *next* `onFailure()` call escalates again (un-latch on
     failed delivery — the fix for the failure-modes review's high-severity
     finding).
   - When injected `escalate` rejects (throws), same un-latch behavior, and
     the rejection does not propagate out of `onFailure()` (fire-and-forget
     — `onFailure()` itself must not return a rejected promise or throw).
   - `onSuccess()` re-arms: after a `false`/thrown escalate un-latches
     naturally, an explicit `onSuccess()` also resets `escalated` back to
     `false` even if it was `true` (confirmed-sent case).
   - Concurrency: two `onFailure()` calls issued back-to-back (no `await`
     between them, simulating two chats failing in the same tick) result in
     exactly one `escalate` call — pins the synchronous check-and-set
     ordering the design note (§3.2) calls load-bearing.

3. **`tests/dispatcher-auth-disabled.test.js` (new file, harness copied from
   `tests/dispatcher-feedback.test.js`'s `mkDeps`):**
   - A turn rejecting with `AUTH_DISABLED` calls the injected
     `authDisabledGate.onFailure({ sessionKey, msgId })`.
   - A successful dispatch calls `authDisabledGate.onSuccess()`.
   - `errorReply` is never called for `AUTH_DISABLED` (silence to partner).
   - A default (no-op) `authDisabledGate` — matching the dependency's
     default value — does not crash `dispatch()`'s error or success paths.
   - This test file intentionally does NOT re-test dedupe/re-arm semantics
     (that's `lib/ops/auth-disabled-gate.js`'s own unit tests, item 2 above)
     — only that dispatcher wires the two calls at the right points.

4. **`tests/ops.test.js` (extend existing heartbeat section):**
   - Insert an `events` row with `kind='auth-disabled'`, assert
     `heartbeat.snapshot().authDisabled === 1` and
     `heartbeat.healthPayload().authDisabled === 1`.
   - An old (>1h) `auth-disabled` event does not count (mirrors the existing
     `escalated` trailing-window behavior).

5. **`bin/water-doctor.js` (confirmed at sync — see §7.1):** new test
   (`tests/water-doctor.test.js` if none exists, else extend `run()`'s
   coverage) asserting the new `auth-disabled` check fails when a temp
   `heartbeat.json` has `authDisabled > 0`, passes when `0` or the field is
   absent (back-compat with an old heartbeat.json shape), and fails closed
   when the file is missing/corrupt.

6. **Still not exercised end-to-end in this session** (orchestra shipped
   mid-implementation — see §2 update): a real `claude` CLI actually hitting
   a disabled account, inside a real tmux pane, driving orchestra's live
   `_pollMidTurnDialogs` detector, is not something this session reproduces
   — all water-side tests here use mocked/stubbed `err.code='AUTH_DISABLED'`
   rejections. The contract itself is now verified by reading orchestra's
   shipped source (§2) and by orchestra's own test suite
   (`tests/auth-disabled-detection.test.js`, 11 cases, in the orchestra
   repo) — what's *not* verified from water's side is the live tmux/CLI
   integration.

## 7. Open questions for Ivan (from the multi-agent spec review)

These are decisions this session isn't making unilaterally — folding them in
as questions rather than silently picking an answer:

1. **RESOLVED (2026-07-19, confirmed by Ivan at sync): build the
   `bin/water-doctor.js` check.** Add a new check that reads
   `heartbeat.json` and fails (non-`ok`) when `authDisabled > 0`, mirroring
   the existing `pending-outbound`/`sla` checks (`water-doctor.js:31-34`) —
   read the file, `JSON.parse` it, `add('auth-disabled', (parsed.authDisabled
   || 0) === 0, ...)`. Wrap the read in try/catch like the existing
   `heartbeat` freshness check (`water-doctor.js:46-51`) so a missing/corrupt
   heartbeat.json fails closed (reported as a failure) rather than throwing.
2. **`[auth]` log prefix vs. water's own `[water]`/`[<module>]`
   convention.** The task instruction explicitly asked for `[auth]` to
   match polygram's auth-expiry gate, for cross-bot log-grep consistency.
   Domain-fit review counter-argues that water has its own established
   prefix convention (`[water]` for daemon/account-wide conditions, e.g.
   the STANDBY line; `[<module>]` like `[questions]` for module-scoped
   ones) and no existing `[auth]` usage — and that polygram's `[auth]`
   comes from a different logging architecture (raw `console.error`, no
   injected `logger`). Current spec keeps `[auth]` per the explicit
   instruction; flagging the tension in case cross-repo grep-consistency
   isn't actually the priority.
3. **RESOLVED (mostly) — coverage gap narrowed, not eliminated, now that
   orchestra's detector is visible (§2 update):** detection requires (a) a
   `pendingTurns` entry (a turn actually in flight) and (b) two consecutive
   5s-apart tmux-pane polls both matching the fixed disablement string in
   the last ~40 captured lines. Real, narrow residual gaps documented in
   orchestra's own spec: detection is suppressed while an interactive `ask`
   is open (`_openQuestions.size > 0`); a turn that hits the outage right as
   its *very first* poll fires still needs a second confirming poll (~5s)
   before rejecting. Both are bounded to single-digit seconds, not the old
   10-minute wall — a chat could only fall through to `TURN_TIMEOUT` in the
   `ask`-open case, and only if the outage started and ended entirely within
   that narrow window. Effectively closed for the mainline case; noting the
   `ask`-open edge case for completeness.
4. **RESOLVED — the flapping/skew concern does not apply as designed.**
   Detection is per-`CliProcess` (per chat's own tmux pane), not a
   process-wide cache: each chat's pane independently shows the same fixed
   Anthropic text once *that* chat has a pending turn during the outage, and
   orchestra's own docs confirm no time-windowed dedup — a resent turn into
   a still-disabled session gets rejected again on the very next poll
   (≤5s). There's no "auth is fine, cached" state a warm process could serve
   stale — every chat with an active turn during a genuine outage gets its
   own `AUTH_DISABLED` rejection within ~10s, so a chat succeeding while the
   outage is still active (the scenario this open question worried about)
   shouldn't happen under normal operation.
5. **If §7.1 is built:** the `authDisabled` heartbeat counter (like the
   existing `escalated` counter it mirrors) is a trailing-1-hour count, not
   a live "is this active right now" flag — a resolved outage would keep a
   hard doctor pass/fail gate red for up to ~59 more minutes after actual
   recovery. Same property `escalated` already has today (not a new flaw),
   but worth knowing if a doctor check is wired directly to it.

## 8. Out of scope / explicitly not done here

- Any change to `orchestra`'s `cli-process.js` (sibling repo, sibling
  session).
- Any change to the SLA watchdog's holding-reply behavior (noted as a gap in
  §3.4 but not fixed here — would need its own review of whether
  `classify()` should gate the holding reply, which is a bigger change than
  this fix's scope).
- Pushing this branch or opening a PR (explicit instruction — stop after
  review + green tests).

## 9. Implementation record

- `lib/error/classify.js` — `CODES.AUTH_DISABLED` entry (§3.1).
- `lib/ops/auth-disabled-gate.js` (new) — dedupe/re-arm/escalate module (§3.2).
- `lib/handlers/dispatcher.js` — `authDisabledGate` dependency, wired at the
  two call sites (§3.2).
- `water.js` — hoisted `createEscalator` ahead of `createDispatcher`,
  constructed `authDisabledGate`, wired into both (§3.2).
- `lib/ops/heartbeat.js` — `authDisabled` counter, trailing-1h, in both
  `snapshot()` and `healthPayload()` (§3.3).
- `bin/water-doctor.js` — `auth-disabled` check reading `heartbeat.json`
  (§7.1, confirmed at sync).
- `package.json` — `@shumkov/orchestra` bumped `^0.2.0` → `^0.4.0`
  (orchestra's fix shipped mid-implementation of this spec — §2 update);
  `npm install` + `npm rebuild better-sqlite3` run.
- Tests (all TDD red→green): `tests/classify.test.js` (new),
  `tests/ops.test.js` (extended — auth-disabled gate section + heartbeat
  counter test), `tests/dispatcher-auth-disabled.test.js` (new),
  `tests/water-doctor.test.js` (new).

## 10. Code review (3 independent agents against the actual diff)

Ran silent-failure, correctness, and test-coverage reviews in parallel
against the implemented diff (not the spec). Correctness review found no
runtime-breaking bugs (confirmed the water.js reorder, the classify() code
short-circuit, and the synchronous check-and-set ordering all work exactly
as designed, verified against the real installed `@shumkov/orchestra@0.4.0`
contract). Silent-failure and test-coverage reviews found four real,
worth-fixing gaps, all closed (each with a red→green test):

1. **`lib/ops/auth-disabled-gate.js`'s `.catch()` silently swallowed
   unexpected `escalate()` failures** — the *expected* failure modes
   (Telegram down, no ipcBot) are already logged inside `escalate.js`
   itself, but a genuinely unexpected throw (the one case an operator most
   needs to hear about, given this feature's whole purpose is paging) got
   no log line at all. Fixed: the `.catch()` now logs
   `[auth-disabled-gate] escalate() threw unexpectedly: ...` and emits a
   distinct `auth-disabled-escalate-error` event.
2. **`lib/handlers/dispatcher.js`'s calls into `authDisabledGate.onFailure()`
   and `.onSuccess()` were the only side-effecting calls in `dispatch()` not
   wrapped in try/catch** (unlike `errorReply`, `fb?.end()`, the media-fetch
   loop). A bug inside the gate would have replaced the real turn error (for
   `onFailure`) or turned a genuinely successful turn into a rejected one
   (for `onSuccess`) — confirmed by a red test reproducing each before the
   fix. Both call sites now wrapped, matching the file's existing
   `try {} catch (e) { logger.error?.('label', e?.message); }` convention.
3. **`bin/water-doctor.js`'s new check used `hb.authDisabled || 0` with a
   strict `n === 0` comparison** — a stringified count (e.g. `"0"` from a
   hand-edited or future-schema heartbeat.json) would have been truthy and
   `!== 0`, producing a false failure (paging on a healthy state). Fixed:
   `Number(hb.authDisabled) || 0`.
4. **The "missing/corrupt" test only covered "missing"** — added a dedicated
   corrupt-JSON test case, plus a test pinning the fix for #3.

Full suite after all fixes: **238 passed, 1 skipped (pre-existing gated
`E2E_REAL_CLAUDE` test, unrelated), 0 failed.**

One item flagged by review but deliberately left as-is (matches Rule 3 —
touch only what you must): `water-doctor.js`'s bare `catch {}` on the new
check conflates "file missing" / "corrupt JSON" / "permission denied" into
one message, same as the pre-existing `heartbeat` freshness check two lines
above it. Fixing this would mean touching an unrelated, working check outside
this fix's scope — noted as a legitimate future follow-up, not fixed here.

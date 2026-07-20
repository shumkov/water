# water — agent replies never quote the user (missing participant) — SPEC

**Status:** IMPLEMENTED, pre-review. **Cross-repo** change — threads the participant through
the shared `@shumkov/orchestra` lib (in-memory, no per-reply DB read) and water. Owner chose
this over the water-only DB-lookup alternative (§2.1) to avoid an extra query on every reply.
Changes **outward-facing** behavior (every bot reply's threading), so it runs the full pipeline.

## 1. Problem

In production the bot's `reply` tool sends **plain, un-threaded** messages — it does not
quote (reply-to) the user's message. Visible in the WhatsApp group: answers appear as
standalone bubbles. The code *intends* to quote, so this is a silent regression.

### 1.1 Root cause (traced end-to-end against deployed code)

A quote is emitted only when **both** `sourceMsgId` **and** `participantJid` are truthy.
`sourceMsgId` flows through; `participantJid` is dropped at the first hop and never carried
on the agent reply path, so the wire-level `ContextInfo` is skipped entirely (including
`StanzaID` — so it fails for DMs too, not just groups):

1. `lib/handlers/dispatcher.js` `pm.send` context carries only `sourceMsgId`; the sender
   JID is passed as a display string (`user`) but not as a participant.
2. `@shumkov/orchestra` `cli-process.js` — the InputLedger and the tool-call it builds
   carry no participant field (`grep participant` = 0 hits).
3. `lib/process/channels-tool-dispatcher.js:128` therefore destructures `participantJid`
   as `undefined`; the quote object carries `undefined`.
4. `lib/transport/client.js:76-84` — `if (quote?.msgId && quote?.participantJid)` is false,
   so **no** `ContextInfo` (no `StanzaID`, no `Participant`) is sent.

The only path that quotes today is `water.js:163` (`deliverFallback`, the no-reply rescue),
which passes `participantJid: msg.sender.jid` directly to the dispatcher — bypassing
orchestra. The normal agent `reply` tool (the vast majority of replies) does not.

## 2. Key decisions

- **Thread the participant through orchestra, mirroring `sourceMsgId`.** The participant
  rides the same InputLedger entry as the quote target, so author and target can never
  disagree. Carried in-memory (context → ledger → tool-call) — no per-reply DB read.
- **Do NOT loosen the client `&&` guard — it is load-bearing.** WuzAPI dereferences
  `ContextInfo.Participant` **unconditionally** the moment `StanzaID` is set; sending
  `StanzaID` without `Participant` **nil-panics WuzAPI → HTTP 500** (verified against WuzAPI
  handler source). Both-or-neither is a crash-prevention requirement, not a style choice.
  **Invariant: never emit `StanzaID` to WuzAPI without a non-empty `Participant`.**
- **Pass the captured sender JID verbatim — never LID→PN normalize it.** `Participant` must
  match the addressing whatsmeow used for that inbound message (LID when LID-addressed, phone
  JID otherwise). Converting via `altJid`/resolve would render the quote blank when the chat
  is LID-addressed. **Invariant: quote `Participant` = `msg.sender.jid`, as-is.**
- **Guard synthetic senders at the source.** Cron/inject envelopes carry
  `sender.jid='water:inject'` (a non-routable sentinel) with a synthetic `msgId='inj-…'`.
  water omits the participant for any sender whose JID isn't a real routable JID (no `@`), so
  such turns stay unquoted instead of building a quote WuzAPI would reject.
- **Media replies stay unquoted** (today `sendMedia` is called with no `quote`). Unchanged
  and out of scope — noted so it isn't later logged as a regression.

Non-goals: loosening the guard; SDK backend (`sdk-process.js`); persisting the outbound quote
flag in SQLite; quoting media replies; changing which chunk quotes (first chunk only,
unchanged); Telegram/polygram behavior.

### 2.1 Rejected alternative — water-only DB resolution
water already persists `messages.sender_jid` (`Info.Sender` verbatim) keyed by
`(chat_jid, msg_id)`, so the dispatcher could look the participant up locally with one
indexed read and skip the orchestra change entirely (no publish, no version bump). Rejected
by the owner: it adds a DB query on **every** reply. The orchestra route carries the value
already in hand through the ledger, at the cost of touching the shared lib. (Kept here
because it remains the fallback if the cross-repo release proves painful.)

## 3. Design (orchestra threading)

Value threaded: `msg.sender.jid` (the individual sender = WhatsApp participant), tied to the
same InputLedger `sourceEntry` that already yields `sourceMsgId`.

### 3.1 water — put the guarded participant in the turn context (`lib/handlers/dispatcher.js`)
```js
// Synthetic senders (sender.jid='water:inject') have no routable JID — omit the participant.
const participantJid = msg.sender?.jid?.includes('@') ? msg.sender.jid : undefined;
const result = await pm.send(sessionKey, prompt, {
  context: { user: msg.sender.pushName || msg.sender.jid, sourceMsgId: msg.msgId, participantJid },
});
```

### 3.2 orchestra — carry it on the ledger entry (`cli-process.js` `_ledgerAdd`)
`_ledgerAdd(turnId, { source, msgId, participantJid = null })` stores
`participantJid: participantJid != null ? String(participantJid) : null`. The primary-send
ledger call passes `participantJid: opts.context?.participantJid`. Every other `_ledgerAdd`
caller (system, steer/inject) defaults to `null` → inert.

### 3.3 orchestra — emit it on the tool-call, gated on the resolved quote target (`cli-process.js`)
```js
sourceMsgId,                                                     // existing
participantJid: sourceMsgId != null ? (sourceEntry?.participantJid ?? null) : null,  // same entry
```
Present exactly when there's a resolved quote target; `null` otherwise (never a half-built
quote).

### 3.4 water — dispatcher + client already correct
`channels-tool-dispatcher.js:178` already builds `quote: { msgId: sourceMsgId, participantJid }`
on the first chunk; `client.js:76-84` maps it to `ContextInfo.{StanzaID,Participant}`. No
change once the value arrives.

## 4. Edge cases

- **Synthetic cron/inject sender** (`sender.jid='water:inject'`, `msgId='inj-<ts>'`): the
  `includes('@')` guard at §3.1 omits `participantJid` → context has no participant → ledger
  stores `null` → tool-call passes `null` → no quote → safe. Without the guard this path
  would send `Participant:'water:inject'` + `StanzaID:'inj-…'` — a dangling quote or a WuzAPI
  500. `feedback.js:28` already special-cases `water:inject`, confirming it's a recognized case.
- **Follow-up / steer-injected turns**: the steer path ledgers with `participantJid` default
  `null` (out of scope) — those follow-ups stay unquoted, matching today's behavior. A future
  enhancement can thread a participant there.
- **`react` tool**: the tool-call now also carries `participantJid`, but the dispatcher
  passes it to `transport.react` **only when reacting to this turn's source message**
  (`String(messageId) === String(sourceMsgId)`). Reacting to the source message gains a
  correct group `Participant` (previously `undefined`); reacting to any other message keeps
  `undefined` (we don't know that message's author — never mislabel it).

## 5. Failure modes

- **`sender.jid` absent / synthetic** → `participantJid` undefined → `null` through the chain
  → unquoted fallback. Safe.
- **Real `sender.jid` present:** quote renders; matches the every-turn `react` path that
  already ships this exact value as `Participant` (§7 evidence).
- **Wrong-participant quote:** impossible by construction — participant and `sourceMsgId` come
  from the **same** `sourceEntry`, so they can't point at different messages.
- **Multi-reply / multi-chunk turn:** unchanged — first chunk only (`i===0`); `_quoteUsed`
  still spends the quote target after the first delivered reply.
- **Guard invariant preserved:** the tool-call sets `participantJid` only when `sourceMsgId`
  is non-null, and the client sets `quote` only with **both** fields — WuzAPI never gets
  `StanzaID` without `Participant` (no 500).
- **Telegram/polygram:** `context.participantJid` is undefined there → ledger `null` →
  tool-call `null` → Telegram dispatcher ignores it. Inert.

## 6. Known gaps (explicitly out of scope)

- **SDK backend** (`sdk-process.js`) still never carries a participant. water doesn't use it;
  flagged so a future SDK port doesn't inherit the bug silently.
- **Media replies** don't quote (no `quote` passed to `sendMedia`). Unchanged.
- **Steer/inject follow-ups** stay unquoted (§4). Deliberate; not wired.
- **No DB persistence of the outbound quote flag** — `messages.quote_msg_id` stays `NULL` for
  `direction='out'`. Separate optional follow-up.

## 7. Test / verification plan

Bug-fix TDD (red before green), demonstrated in both repos.

- **orchestra (integration, `tests/cli-process-integration.test.js`):** drive a `reply`
  tool-call after `send({context:{sourceMsgId,participantJid}})`; assert the fake
  `toolDispatcher` receives `participantJid`. Second test: no ledgered participant →
  dispatcher gets `participantJid: null` (never garbage). **Red** on pre-fix source, green
  after §3.2–3.3. ✔ done.
- **water (unit, `tests/dispatcher-quote-participant.test.js`):** real group/phone sender →
  context carries `participantJid` verbatim; synthetic `water:inject` sender → no participant.
  **Red** on pre-fix `dispatcher.js`, green after §3.1. ✔ done.
- **water (existing `tests/delivery.test.js`):** already proves the dispatcher turns an
  explicit `participantJid` into `quote` on the first chunk → `ContextInfo.{StanzaID,
  Participant}` via `client.js`. Composes with the above to cover the full chain.
- **Production smoke (real gate):** after deploy, send one group message to the umi chat and
  confirm the reply renders as a quoted reply. The every-turn group **reaction** already
  proves the `Participant` *value* (`feedback.js:121,131`), but only the smoke test proves
  WuzAPI binds `ContextInfo` on `/chat/send/text` (reactions use a different endpoint). The DB
  won't show it (§6) — verify visually.

## 8. Files touched

- `@shumkov/orchestra` `lib/process/cli-process.js` — `_ledgerAdd` (+`participantJid` field),
  primary-send ledger call, tool-call construction. + integration tests.
- `water/lib/handlers/dispatcher.js` — guarded `participantJid` into the `pm.send` context.
  + unit tests.
- No schema change. **Requires an orchestra release + a water dependency bump — see §9.**

## 9. Release

water **already committed** `@shumkov/orchestra: ^0.4.0` (package.json + lockfile resolve
0.4.0); only `node_modules` is stale at 0.2.0 (the bump was committed but never `npm
install`ed). So there is no version-line decision — the orchestra change just needs to be
published as a **new** version (0.4.0 is immutable on npm and lacks the fix) and installed:

1. **orchestra** — commit the working-tree change; bump to **0.4.1**; tag; `npm publish`.
2. **water** — set the pin floor to **`^0.4.1`** (so a fresh clone/CI can't resolve the
   fix-less 0.4.0), `npm install` to refresh the stale `node_modules`, run the suite.
3. **Deploy** water to the VPS (`shumabit@umi-vps`, systemd).
4. **Smoke test** (§7): one group message → confirm the reply renders quoted.

The 0.2→0.4 delta water inherits on install is small and wanted: two additive orchestra
changes (`checkClaudeAuthHealth`, mid-turn `AUTH_DISABLED` detection — the counterpart to
water's own `f05745b`). No removed/changed API that water depends on. polygram is already on
`^0.4.0` and passes no `participantJid`, so it stays inert.

Until steps 1–2 run, the change is code-complete and tested in both repos but **not wired
into water's installed dependency**, so it is not yet live.

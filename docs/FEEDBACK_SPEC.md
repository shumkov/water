# water — responsiveness feedback (reactions + typing) — SPEC

**Status:** v2 — reviewed (feasibility + scope + adversarial, 2026-07-06), must-fixes folded ·
DRAFT for sync. Closes the polygram-parity gap in the umi-vps-infra runbook TODO. Companion to
`docs/SPEC.md` §4.2.

## 1. Problem

A water turn gives partners **no live feedback** — nothing until the final text reply (7–17s,
longer for tool-heavy turns; a cold tmux+claude spawn alone is ~11s). Polygram shows a "typing…"
indicator + a reaction cascade on the user's message. water wires **neither**: `setPresence` has
zero callers, `ackReaction` is validated but read nowhere (dead), and the CLI backend water runs
never reads `context.reactor` (only the SDK backend does) — so the only working reaction path is
the agent *choosing* to call the `react` bridge tool. (All verified against the code by review.)

## 2. Scope — reframed after review

The two halves have **very different risk/reward** (adversarial premise check):
- **Reactions (G2)** — cheap, self-contained, **high + durable signal** (a 👀 the partner sees
  even after closing the chat), API confirmed working. **Ship first.**
- **Typing (G1)** — riskier: `setPresence` has *never run against real WuzAPI* (group presence
  may need a prior subscription and can silently no-op), it can perpetuate up to `maxTurnHard`
  (90 min) if mishandled, and it's a *weaker*, transient signal. **Ship second, probe-gated.**

So: **Phase A = ack reaction. Phase B = typing (after a live presence probe). Phase C = full
progress cascade** (deferred; now confirmed feasible — see §7).

Goals: **G1** typing while a turn runs · **G2** an ack reaction on the user's message that
resolves on completion · **G3** best-effort — feedback NEVER delays, blocks, or fails a turn ·
**G4** account-level config, safe defaults, no regressions. Non-goals: the progress cascade
(§7), replacing the agent `react` tool.

## 3. Where it attaches — and the lock-safety rule (must-fix F-lock)

`dispatcher.js dispatch()` wraps the turn in a per-session lock + try/finally. Feedback attaches
here, but **carelessly it deadlocks the chat forever**, so this is normative:

```js
let ok = false;
let fb = null;                                   // hoisted ABOVE try (else out of scope in finally)
const release = await lockFor(sessionKey).acquire();
try {
  status.markDispatched(row.id);
  fb = feedback.begin(msg, { isReplay, addressed });  // ← right after markDispatched (see §4.0)
  await pm.getOrSpawn(...); ... 
  const result = await pm.send(...);
  ...
  if (result.alreadyDelivered) { status.markReplied(row.id); ok = true; delivered = true; }
  ...
} catch (e) { ... } finally {
  try { fb?.end({ ok, delivered }); } catch (e) { logger.error?.('feedback.end', e?.message); }
  release();                                     // ← ALWAYS runs, after end, even if end throws
}
```

Rules: `begin`/`end` **must never throw** (internal try/catch, best-effort); `end` is idempotent;
`release()` runs unconditionally after `end`. Without this, an `end()` throw leaks the lock and
every future turn in that chat blocks (feasibility-F1 / adversarial-F1).

## 4. Design — `createFeedback({ transport, settings, logger })`

`settings` = the resolved account feedback config (computed once in water.js). `begin(msg, {
isReplay, addressed })` → a handle with `.end({ ok, delivered })`. **Narrow deps** — no
`resolveChat`/`gate` (scope-F4): dm/group comes from `msg.chatType` (already normalized);
addressing comes from the threaded `addressed` bit (§4.2).

### 4.0 Fire on dispatch, not before pm.send (must-fix F-early)
`begin` runs **right after `markDispatched`**, before `getOrSpawn`. A cold spawn is ~11s; firing
just before `pm.send` would land typing + 👀 up to 11s late on exactly the slow turns that need
them. Safe — the message is already gated to dispatch.

### 4.1 Ack reaction — Phase A (G2)
- **Skip entirely** when `isReplay` (boot replay re-runs messages up to 2h old — a stale 👀 is
  wrong; mirrors the existing replay apology-suppression) OR the turn is injected/synthetic
  (`msg.msgId` starts `inj-` / `sender.jid === 'water:inject'`). (adversarial-F5/F3b, feasibility-F4)
- Policy from `feedback.ackReaction.{dm,group}` (`never|mentions|always`). `mentions` uses the
  threaded **`addressed`** bit (see §4.2), NOT a recomputed guess.
- **begin:** `transport.react({ chatJid: msg.chatJid, msgId: msg.msgId, emoji: '👀',
  participantJid: msg.sender.jid })`. `participantJid` is **required for group reactions**
  (it's the message author's key) — bind it explicitly. (feasibility-F2 / adversarial-F3)
- **end (resolution)** — driven by `{ ok, delivered }`:
  - error (`!ok`) → **🤯**.
  - completed but **no reply delivered** (`ok && !delivered` — NO_REPLY / tool-only / silence) →
    leave **✅** (do NOT clear; clearing makes the partner see "bot noticed then dismissed me").
    (adversarial-F8)
  - completed **and** a reply was delivered → **clear** the 👀 (polygram-style: success = a clean
    text answer), UNLESS the agent's `react` tool already set a reaction on this `sourceMsgId`
    (see §4.3) — then leave it.
- Hardcoded emojis (👀/✅/🤯) — not config (scope-F3).

### 4.2 The `addressed` bit (must-fix — `mentions` is otherwise unimplementable)
The gate computes `isMentioned` and **throws it away** (`gate.decide` returns only `{action,
reason}`), and "every dispatched message in a requireMention chat is mentioned" is **false**
(album-sibling media dispatches with no mention; `requireMention:false` groups dispatch *before*
mention is evaluated). So the controller has no addressing signal. Fix: `gate.decide` returns an
`addressed` boolean; thread it `decide → processInbound → dispatch → feedback.begin(msg, {
addressed })`. Album-sibling + `requireMention:false` non-mention paths set `addressed:false`.
(scope-F5 / adversarial-F4)

### 4.3 Agent `react`-tool collision (must-fix — NG2 "independent" is false)
The bot is a **single reactor per message**. The agent is handed `sourceMsgId` and may call the
`react` tool on it mid-turn (channels-tool-dispatcher). If it does, the auto-ack's end-clear
would **erase the agent's deliberate reaction**. Fix: the tool-dispatcher records when a `react`
fired against the turn's `sourceMsgId`; `fb.end` reads that and **does not clear** in that case.
(adversarial-F7)

### 4.4 Typing — Phase B (G1)
- `begin`: fire `setPresence(msg.chatJid, 'composing')` once, then every `REFRESH_MS` (a hardcoded
  constant ≈ the WuzAPI ~5s expiry per `docs/wuzapi-contract.md` — NOT config; scope-F2).
- **Cap the loop** at `MAX_TYPING_MS` (= 180_000 ms / 3 min, « the 90-min `maxTurnHard`): a
  "typing…" that persists for tens of minutes reads as *wedged*. **Implementation note:** the
  original concern here — coordinating the cap with the SLA **holding reply** so typing stops
  before the "a human will follow up" message — turned out **moot by construction**. The holding
  reply fires at ~92 min (well past `maxTurnHard`), while typing is hard-capped at 3 min, so the
  loop is always long dead before any holding message could contradict it. No shared turn identity
  between the feedback controller and the SLA watchdog is needed; the cap alone suffices.
  (adversarial-F2 — resolved: coordination unnecessary.)
- `end`: clear the interval + one `setPresence(msg.chatJid, 'paused')`.
- Typing may also fire on replay (the turn genuinely runs now) — but NOT on injected/synthetic
  turns (no human waiting). Sub-5s turns flicker briefly; acceptable (adversarial-F10).

## 5. Config + validation (must-fix F-validate — fail-loud is a repo value)
```jsonc
"feedback": {
  "typing":      { "enabled": false },                 // Phase B: default off until the probe passes
  "ackReaction": { "dm": "always", "group": "mentions" }
}
```
- **Rename** `ackReaction` → `feedback.ackReaction` outright — no back-compat shim; it's dead
  config, nothing to stay compatible with (scope-F1). Update `config.example.json` + the ansible
  template in the same change.
- **Validate** `feedback.typing.enabled` (bool) and `feedback.ackReaction.{dm,group}` (enum) in
  `validateConfig`, at BOTH account and chat level (config.js currently validates only account
  `ackReaction`, and not the chat loop) — a typo must fail-loud, not boot silently (adversarial-F9).
- **Precedence:** account-level only for v1 (G4 says "account"; drop any per-chat claim). If a chat
  override is wanted later, add it to `resolveChat`'s merge explicitly.

## 6. Failure modes (consolidated)
Presence/react 4xx/5xx or WuzAPI down → logged at debug, swallowed, turn unaffected · react on a
non-reactable/old id → swallowed · lock never leaks (§3) · begin/end serialized per chat by the
lock · edit **fold** does NOT double-start (the fold branch returns before `dispatch`) · edit
**redispatch** reacts on the original user message (correct target) · own-message reactions
impossible (target is always the inbound user msg).

## 7. Phase C — full progress cascade (deferred, feasibility-CONFIRMED)
Feasible: orchestra exposes host-facing callbacks via `new ProcessManager({ callbacks })` →
`CALLBACK_TO_EVENT` (onTurnStart/onThinking/onToolUse/onSubagentStart/onIdle), and **`turn-start`
carries `anchorMsgId`** (the source-message id the cascade needs). Design notes for that spec:
subscribe via the **PM callbacks map**, not `proc.on()` (procs respawn on LRU/reload; direct
listeners die); latch `anchorMsgId` and apply thinking/tool reactions to it until idle; one
controller drives it (no SDK `context.reactor` dual-path). Not started until Phase A/B ship.

## 8. Decisions for the sync
1. **Phased rollout** — Phase A (ack) first, Phase B (typing) after a live presence probe,
   Phase C later? *(recommended — de-risks the weak/unvalidated half)*
2. **Ack resolution** confirmed: 🤯 on error / ✅ on completed-no-reply / clear on
   completed-with-reply (unless the agent reacted). OK?
3. **`addressed` threading** through the gate *(recommended)* vs. scoping `mentions` to
   `requireMention:true` only for v1.
4. **Live probes** before Phase B: does group **typing** actually render, and are 👀/✅/🤯
   accepted as reactions in the partner groups?

## 9. Test plan
- **Lock-safety:** `begin`/`end` throwing does NOT leak the lock (a following turn acquires) and
  does NOT mask the turn error. `end` runs exactly once from `finally`.
- **Ack:** `always`+dispatch → `react('👀', sourceMsgId, participant=sender.jid)` at begin;
  error→🤯; ok-no-reply→✅; ok-with-reply→clear; agent-reacted→no-clear. `never`→no react.
  `mentions` honors the threaded `addressed` bit. `isReplay`/`inj-`→no ack.
- **Typing:** composing at begin (immediately), paused at end, interval cleared; capped at
  MAX_TYPING_MS (SLA-holding coordination is moot by construction — see §4.4); skipped for
  injected turns.
- **Best-effort:** transport throwing on presence/react leaves the turn result unchanged.
- **Config:** invalid `feedback.*` fails validation (account + chat level).

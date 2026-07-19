# water — canned reply for non-allowlisted DMs — SPEC

**Status:** DRAFT for review + sync. Small feature; follows the spec pipeline because it
changes **outward-facing** behavior (the bot begins messaging people it currently ignores).

## 1. Problem

`dmPolicy: allowlist` means a DM from anyone **not** in the `chats` map is dropped at
`gate.js:80` (`if (!chat) return ignore('unknown-chat')`) — the sender gets **silence**.
For a business assistant that's a dead end: a customer who finds UMI's WhatsApp and DMs it
hears nothing. Desired: a non-allowlisted DM gets a short canned reply telling them DMs
aren't monitored and to use the contact page — **without** spinning up a Claude turn.

## 2. Scope + decisions (confirmed with owner)

- **DMs only.** Non-allowlisted **groups** stay a silent drop (`unknown-chat`) — unchanged.
- **English only.** One plain-string message (not the bilingual `{en,th}` shape of
  `holdingReply`). Owner chose English-only.
- **One reply per sender per 24h.** A cheap in-memory per-`(chat,sender)` guard: at
  most one canned reply per sender in a rolling 24h window (not persisted — resets on
  restart). Chosen after spec review found the original "every message, no limit"
  design's stated loop-mitigation (`isFromMe`) doesn't actually cover the risk it names
  (see §6, corrected).
- **No agent.** The canned text is sent directly via the existing reply path; **no
  `pm.send`, no session spawn, no feedback cascade.** The message is still recorded and
  marked terminal (`ignored`) so it can never trip replay or the SLA watchdog.
- **Opt-in.** Behavior is off unless `feedback`-independent config
  `account.dmRestrictedReply` is a non-empty string. Absent/empty ⇒ today's silent drop
  (full back-compat; no forced behavior change on any other deployment).

Non-goals: bilingual/auto-detected language, rate-limiting, group replies, customizing per
chat, any change to allowlisted-DM or group routing.

## 3. Design

### 3.1 Gate — new terminal action `restricted-dm` (lib/handlers/gate.js)
The gate stays pure. Inject two new deps: `restrictedDmEnabled` (bool; = config
`dmRestrictedReply` is a non-empty string, computed in water.js) and
`hasRecentRestrictedReply(chatJid, senderJid) -> bool` (default `() => false`, same
injection pattern as `hasOpenQuestionFor`). `sessionKey` must be hoisted above the
`if (!chat)` check — it's referenced inside that branch now, and declaring it on the
next line (as today) would be a temporal-dead-zone crash, not just "out of scope" (caught
in spec review). At the fail-closed check:

```js
function decide(msg) {
  const chat = resolveChat(msg.chatJid);
  const sessionKey = msg.chatJid;   // hoisted: needed inside the !chat branch below

  // 1. configured-chat check (fail-closed allowlist)
  if (!chat) {
    // A DM from someone not on the allowlist: optionally answer with a canned "DMs
    // aren't monitored" note (no turn), capped at one per sender per 24h so an
    // auto-responder loop or a DM flood can't run unbounded. Groups stay a silent
    // drop. Never answer our own sends.
    if (restrictedDmEnabled && msg.chatType === 'dm' && !msg.isFromMe) {
      if (hasRecentRestrictedReply(msg.chatJid, msg.sender.jid)) {
        return ignore('restricted-dm-capped', sessionKey);
      }
      return { action: 'restricted-dm', sessionKey };
    }
    return ignore('unknown-chat');   // unchanged: no sessionKey, matches today + existing tests
  }
  ...
```

- The plain `ignore('unknown-chat')` call keeps its current no-`sessionKey` shape — only
  the two new outcomes (`restricted-dm`, `restricted-dm-capped`) carry `sessionKey`. This
  keeps `tests/gate.test.js`'s existing `sessionKey: undefined` assertion for
  `unknown-chat` valid without modification.
- The `!msg.isFromMe` guard is defensive: `onMessage` already returns before the gate for
  own sends, but the gate matrix must be self-contained/testable (Rule 7 / gate is
  exhaustively unit-tested).
- Ordering: this sits at step 1, so a stranger's DM never reaches abort/admin/mention
  logic — correct: none of those apply to an unconfigured chat.

### 3.2 Caller — handle the action (water.js `processInbound`)
```js
case 'restricted-dm':
  // Canned "we don't do DMs here" note. Skip on boot replay (the sender already got it
  // live; a restart must not re-blast old DMs). Mark the sender BEFORE the send so a
  // burst of near-simultaneous messages can't all slip past the cap. Send is
  // best-effort; the row is terminal either way so it can't replay or trip the SLA.
  if (!isReplay) {
    markRestrictedDmReplied(msg.chatJid, msg.sender.jid);
    try { await restrictedReply(msg); }
    catch (e) { logger.error?.('restricted-dm reply', e?.message); }
  }
  return status.markIgnored(rowId, 'restricted-dm');
```

`markRestrictedDmReplied` / the `hasRecentRestrictedReply` gate dep share one in-memory
`Map<'chatJid|canonical-identity', lastReplyTsMs>` created alongside the gate in water.js.
The key resolves the sender through `jidMap.identitySet` (same pn/lid resolution
`authorize()` already uses elsewhere in the gate — caught in code review: keying on the
raw `sender.jid` would let the same person dodge the cap by being addressed under a
different form across messages) before composing the key. A read prunes/checks against a
fixed 24h window (`RESTRICTED_DM_WINDOW_MS`, not configurable in v1 — this is a safety cap,
not a product knob). Not persisted: a daemon restart clears it, so the worst case after a
restart is one extra reply per sender, never an unbounded loop.

`restrictedReply(msg)` reuses the canonical send+record path (identical to `errorReply` /
SLA-holding — sends *and* writes the out-row so the echo isn't mistaken for a human-device
send):

```js
async function restrictedReply(msg) {
  await toolDispatcher({ sessionKey: msg.chatJid, chatId: msg.chatJid, toolName: 'reply', text: dmRestrictedReply });
}
```

The existing `logEvent('gate-restricted-dm', …)` line (already generic on `d.action`) gives
us the observability row for free.

### 3.3 Config (lib/config.js + template + example)
- New optional account field `dmRestrictedReply: string`. Validate: **if present, must be a
  string** (`typeof === 'string'`); empty string ⇒ treated as disabled. Fail-loud on a
  non-string (repo convention). No chat-level override in v1.
- `config.example.json`: add the field to the `umi` account with the drafted copy.
- Ansible: `water_dm_restricted_reply` role var (default = the drafted copy) + a line in
  `config.json.j2`. Rendered into the account block next to `holdingReply`.

Drafted copy (owner to confirm exact wording at sync):
> 👋 Hi! This is UMI's assistant — direct messages here aren't monitored for support.
> Please reach our team at https://umi.store/pages/contact and we'll be glad to help.

## 4. Interface / data flow
inbound stranger DM → `onMessage` (not isFromMe) → `recordInbound` (in-row) →
`processInbound` → `gate.decide` → `{action:'restricted-dm'}` → `restrictedReply` (out-row,
`source='bot-reply'`, sent) → `markIgnored(row,'restricted-dm')`. No session, no metrics row.

## 5. Failure modes
- transport/send 4xx/5xx or WuzAPI down → caught + logged; row still `markIgnored` (no
  retry storm, no leak). Sender simply gets no note that once — acceptable.
- crash between send and `markIgnored`: row stays `received` → boot replay re-gates it, but
  §3.2 **skips the send on replay**, so no duplicate blast; it's just marked ignored.
- own-send / linked-device DM into an unconfigured chat → `!msg.isFromMe` guard + the
  `onMessage` pre-gate both prevent a self-reply.
- allowlisted DM (Ivan, the partner DM) → `chat` is truthy → never enters this branch;
  routes to the agent as today.

## 6. Risk — auto-responder loops and DM floods (corrected during spec review)

The original draft claimed the `!msg.isFromMe` guard mitigates a bot-ping-pong loop. It
does not: `isFromMe` only identifies this account's **own** linked-device echoes/human
sends (see `onMessage`'s human-device recording branch) — it says nothing about a message
arriving from a genuinely different WhatsApp number. A separate auto-responder DMing UMI
would look like an ordinary stranger DM and, with no cap, the two sides would answer each
other's canned replies indefinitely. Separately, a script rapid-firing DMs at the number
could force unbounded WuzAPI sends (cost, and risk of an anti-spam action on the number).

**Mitigation (this spec, not deferred):** §2/§3.1's one-reply-per-sender-per-24h in-memory
cap bounds both scenarios to at most one send per sender per day, regardless of message
volume. Residual risk: the cap is in-memory (not persisted), so a crash/restart resets it —
worst case is one extra reply per sender right after a restart, not an unbounded loop. If a
higher-fidelity guard (persisted, cross-restart) is ever needed, promote the map to the
`events` table (a `gate-restricted-dm` row already exists per reply — no new logging), but
that's explicitly out of scope for v1: this in-memory cap is the fix, not a placeholder for
a future one.

## 7. Test plan
- **gate matrix:** unconfigured DM + `restrictedDmEnabled` → `restricted-dm`; same DM with
  `restrictedDmEnabled:false` → `ignore('unknown-chat')`; unconfigured **group** → always
  `ignore('unknown-chat')` (never restricted-dm, regardless of the cap dep); unconfigured
  DM that `isFromMe` → `ignore`; unconfigured DM with `hasRecentRestrictedReply` true →
  `ignore('restricted-dm-capped')` (not `restricted-dm`, no second send); unconfigured
  `unknown-chat` (feature off) still returns `sessionKey: undefined` (regression guard for
  the hoist); **configured** DM/group → unaffected (dispatch paths unchanged).
- **caller:** `restricted-dm` sends exactly one reply with the configured text + marks the
  row `ignored('restricted-dm')`; `isReplay` → **no** send but still marks ignored; a
  throwing send still marks ignored (best-effort, no leak); a second message from the same
  sender within the window is capped by the gate before the caller ever sees
  `restricted-dm` again (verified via the gate test above, not re-verified at the caller
  layer).
- **config:** non-string `dmRestrictedReply` fails `validateConfig`; empty/absent ⇒
  disabled (gate returns `unknown-chat`).
- **no-regression:** allowlisted DM + group-mention dispatch unchanged; no session/metrics
  row created for a restricted-dm.
```

# water — `ask` tool (interactive questions) — SPEC

**Status:** REVIEWED (3 independent lenses: feasibility / wedge-correctness / scope) + synced.
Reframed to **DM-only** after sync. Fixes a **critical production bug**: the agent's `ask`
tool hangs forever and wedges the chat (a "create order" turn in a partner GROUP asked a
question and froze that group for 46 min). Research folded (whatsmeow buttons + the orchestra
resolve seam); review must-fixes folded (asker correlation, no-lock consume, sweep-is-sole-safety).

## 1. Problem

The agent is told (orchestra's system prompt) to call `mcp__water-bridge__ask` for any
choice/confirmation. That call **blocks inside the bridge** (`await awaitQuestionAnswer`,
channels-bridge.mjs:418) until a host answers. **water never answers it**, so no question is
delivered, the tool call never returns, the turn's `pm.send` never resolves, and the per-chat
dispatch lock is held — every later message in that chat queues behind it. The daemon even
**defers its own turn-timeouts** while a question is open (cli-process.js:2367), so nothing but
a host-side sweep can free it; the bridge's only backstop is 24h.

## 2. Scope — DM-only (the key reframe)

`ask` is **only meaningful in a DM**. In a group it is wrong twice over: the question is a
message **broadcast to every participant** (private clarification made public), and the
answer-routing + lock-wedge problems exist *only* in multi-participant chats. So:

- **DM → implement `ask` for real** (blocking): deliver the numbered question, the user's
  reply answers it, a short safety-timeout guarantees it can't hang. A DM has exactly one
  human, so there is no "other participant" traffic to delay and correlation is trivial.
- **GROUP → never block.** water intercepts an `ask` from a group turn and resolves the tool
  call **immediately** with `{cancelled:true, reason:"…"}` (existing bridge shape, no orchestra
  change) so the turn ends and the lock frees at once. The `reason` tells the model to ask in a
  normal reply instead — which it phrases naturally and the partner answers with an ordinary
  @mention/reply (a normal turn). **The group can never wedge on a question.** This makes the
  reported incident structurally impossible.

Non-goals: group `ask`, native WhatsApp buttons/lists (research: unavailable for whatsmeow —
Meta gates them; WuzAPI returns 200 but they don't render), native polls (deferred, §7).

## 3. Design

New module `lib/handlers/questions.js` — `createQuestions({ db, pm, deliver, inFlightSender,
logEvent, logger, timeoutMs })`. `deliver(chatJid, text)` = the existing reply path (SLA-holding
pattern). `inFlightSender(sessionKey)` = the dispatcher-stashed sender (see §3.5). Wired in water.js.

### 3.1 On `question-asked` → branch on chat type (gaps: PM callback + handler)
Add PM callback `onQuestionAsked: (sk, payload) => questions.onAsked(sk, payload)` to water.js's
`callbacks:` map (verified real: `CALLBACK_TO_EVENT.onQuestionAsked → 'question-asked'`,
process-manager.js:67; payload `{sessionKey, chatId, threadId, turnId, toolCallId, questions,
backend}`). `onAsked`:

```
if chatId is a GROUP (endsWith '@g.us'):
    pm.answerQuestion(sessionKey, toolCallId, { cancelled:true,
      reason:"Questions aren't available in group chats — ask it in a normal reply and the "
             "member will answer." })          // resolves the ask AT ONCE → turn ends, no wedge
    logEvent('question-group-degraded', {...}); return
// DM path:
if an 'open' row already exists for this chat:   // parallel tool_uses in one turn
    pm.answerQuestion(sessionKey, toolCallId, { cancelled:true, reason:"one question at a time" })
    return                                        // (BEFORE any await — §3.1 atomicity, N3)
asker = inFlightSender(sessionKey)                // the one DM human (see §3.5)
INSERT pending_questions(tool_call_id, session_id=sessionKey, chat_jid=chatId,
    asker_jid=asker, questions_json=questions, status='open')     // session_id MUST == sessionKey (§3.5)
deliver(chatId, renderNumbered(questions[0]))     // v1: first question only (§7)
```
`renderNumbered` → the question text + `1. <label>` lines + a one-line hint (conditional on
`multiSelect`/`allowOther`). `header` is metadata, not shown.

### 3.2 Inject `hasOpenQuestionFor` into the gate (dead today)
water.js passes `hasOpenQuestionFor: (chatJid, senderJid) => questions.isOpenFor(chatJid,
senderJid)` to `createGate`. `isOpenFor` = an `open` row for `chat_jid` whose `asker_jid`
intersects the sender's identity set (via `jidMap`, so a LID/PN form mismatch still matches).
The gate's `consume` branch sits **before** the mention gate (gate.js:112, step 5 < step 7) —
verified — so a bare reply answers even without an @mention. (In a DM the sender is always the
asker; this is trivially true.)

### 3.3 Handle `consume` → parse → answer (no-op today)
`processInbound`'s `case 'consume'` (currently `markIgnored`) becomes — **and this MUST NOT go
through `dispatcher.dispatch`** (which would `lockFor(chat).acquire()` and deadlock behind the
wedged turn — the single most important invariant, reviewer-confirmed; bold comment + regression
test):
```js
case 'consume': {                       // runs OUTSIDE the dispatch lock (fire-and-forget intake)
  const r = questions.consume(msg);     // parse + pm.answerQuestion (synchronous) + mark row
  return status.markIgnored(rowId, r.ok ? 'answered-question' : 'question-reparse');
}
```
`questions.consume(msg)`:
1. Load the `open` row for `(chatJid, asker)`; none → `{ok:false}` (race; fall through).
2. **Guarded claim** (TOCTOU, reviewer S3): `UPDATE … SET status='answered' WHERE id=? AND
   status='open'`; if `changes===0` another reply already claimed it → `{ok:false}` so this
   message isn't swallowed.
3. **Parse** `msg.text` against the stored options → `{answers:[{header, selected:[label], other?}]}`:
   number (`2` / `2.` / `2)` / `take 2`); multiple numbers if `multiSelect` (`1,3`); option-label
   (case-insensitive exact→prefix); else if `allowOther` → whole text as `other`. Unparseable and
   not-allowOther → leave `status='open'` (revert the claim), re-prompt once via `deliver`; a
   second failure → `pm.answerQuestion(…, {cancelled:true})` + mark `expired` (never loop).
4. `const ok = pm.answerQuestion(session_id, tool_call_id, result)` — **log if it returns
   `false`** (proc gone; the turn already settled — harmless but diagnosable, reviewer N3).
   `session_id` is the pm sessionKey, so `procs.get(sessionKey)` hits (reviewer M2).

### 3.4 Store + sweep + boot-expire (the anti-wedge guarantee)
- **Store**: a thin prepared-statement wrapper folded into `questions.js` (house style is a
  `lib/db/*` module, but for one table it's plumbing, not a 4th "gap"): `open`, `getOpenFor`,
  `getOpenForChat`, `claimAnswered(id)`, `markExpired(id)`, `openOlderThan(ts)`. **Not**
  orchestra's `createQuestionStore` (schema-incompatible — different columns/status domain).
- **Sweep** (SOLE anti-wedge for the DM path — the daemon won't time out an open ask, so this
  is the only thing that frees the lock): a periodic timer (heartbeat cadence) finds `open` rows
  older than `timeoutMs` (**hardcoded 5 min** — a DM clarifying answer; short so an abandoned
  question frees the DM fast), calls `pm.answerQuestion(session_id, tool_call_id, {timedout:true})`,
  marks them `expired`. The model gets `{timedout}` and proceeds. **Note:** the bridge's 24h
  backstop (cli-process.js:617) is unaffected/irrelevant — water's 5-min sweep always fires first.
- **Abort coherence** (reviewer S1): `case 'abort'` must also `questions.expireChat(chatJid)` —
  `interrupt()` frees the lock but leaves the DB row `open`, which would mis-route the user's
  next message as a stale answer until the sweep. Expire the row on abort.
- **Boot-expire** (reviewer N1): on startup mark all `open` rows `expired` **without** answering
  — the bridge/promise died with the old process, so there's nothing to resolve; this only stops
  a stale row from swallowing a future message. (`deliver` wrote a `source='bot-reply'` out-row,
  so boot-replay already skips re-asking the delivered question.)

### 3.5 Asker correlation (reviewer M1 — the happy path depends on it)
The `question-asked` payload carries **no sender** and `turnId` is an orchestra UUID, not
water's `msg_id` — so `asker_jid` is not derivable from the event. Fix: the dispatch lock
guarantees exactly one in-flight turn per chat, so the **dispatcher stashes the current
`msg.sender.jid` keyed by `sessionKey`** right before `pm.send` (and clears it in `finally`);
`questions.onAsked` reads it via `inFlightSender(sessionKey)`. In a DM this is always the DM
human. Add a test that a real reply from the asker's identity consumes.

## 4. Flow (DM)
```
ask:     claude → bridge CallTool(ask) [BLOCKS] → daemon emit('question-asked')
         → onAsked: INSERT open + deliver(numbered)            [group → answer {cancelled} now]
answer:  user reply → gate consume (outside lock) → questions.consume: guarded-claim + parse
         → pm.answerQuestion(sessionKey, tool_call_id, {answers}) → bridge resolves
         → ask returns → wedged turn's pm.send resolves → dispatch finally { release() }
timeout: sweep(5min) → pm.answerQuestion(…,{timedout:true}) → mark expired → lock frees
abort:   /stop → interrupt() + expireChat(chat)
restart: boot → mark open rows expired (bridge promise is dead; do NOT answer)
```

## 5. Failure modes
- **Group can't wedge**: group asks resolve `{cancelled}` immediately (no held lock, ever).
- **DM can't wedge > 5 min**: the sweep is the guarantee (a DM only delays the *same* user's
  own next message meanwhile; a group has no ask to delay). **Residual (reviewer S2):** a model
  that re-asks after `{timedout}` re-arms a new 5-min window — bounded per cycle, not a single
  global ceiling; accepted (the model rarely loops).
- **No deadlock**: `consume` resolves the ask via synchronous `pm.answerQuestion` **without**
  acquiring the dispatch lock (§3.3). A future refactor routing consume through `dispatch` would
  deadlock — guarded by comment + test.
- **deliver fails** (WuzAPI down): row stays `open`, sweep reclaims in ≤5 min; user saw nothing
  that once. Safe, logged.
- **Late/duplicate answer**: guarded-claim (§3.3.2) makes the loser fall through to normal
  gating instead of being swallowed; `pm.answerQuestion` on a resolved id is a safe no-op.
- **best-effort**: `questions.*` never throws into intake or the PM callback.

## 6. Config
`timeoutMs` hardcoded (5 min) and prompt wording hardcoded — no config field for v1 (a single
internal safety timer; promote to config only if someone needs to tune it). `ask` handling is
always on (a correctness fix, not a toggle).

## 7. Deferred (post-v1)
- **Multi-question** asks (2–4): v1 renders only `questions[0]`, logs `question-multi-truncated`.
- **Native polls** for pure multiple-choice DMs (nicer taps; needs a `pollVote` ingestion path
  + a restart-safe option→hash map; can't do free-text).
- **Orchestra nudge** (optional, your repo): one system-prompt line "`ask` is for DMs; in a
  group, ask in your reply" so the model doesn't call it in groups at all (water degrades it
  safely regardless).

## 8. Test plan
- **Group degrade**: `onAsked` for a `@g.us` chat → `pm.answerQuestion(sk, tcid,
  {cancelled:true, reason})` and **no** row written / nothing blocks.
- **DM unblock**: `onAsked` writes an `open` row + delivers numbered text; a matching reply →
  `pm.answerQuestion(sk, tool_call_id, {answers:[{header, selected:[label]}]})` + row `answered`
  (assert the exact shape the bridge expects; assert `session_id === sessionKey`).
- **Parser matrix**: `2`/`2.`/`2)`/`take 2`/label/`1,3`(multiSelect)/free-text(allowOther)/
  out-of-range → re-prompt once → second failure cancels.
- **No-lock consume** (regression for the deadlock): `consume` never calls `lockFor(...).acquire`.
- **Sweep**: an old `open` row → `pm.answerQuestion(…,{timedout:true})` + `expired`.
- **Abort**: `/stop` with an open question expires the row; next message isn't swallowed.
- **Restart**: boot marks pre-existing `open` rows `expired`; a later message isn't consumed.
- **TOCTOU**: two concurrent replies → one answers, the other falls through (not swallowed).
- **Correlation**: only the asker's identity (LID/PN via jidMap) consumes.
- **No-wedge invariant** (the incident regression): a DM turn that calls `ask` and is never
  answered is unblocked within 5 min and the lock releases; a GROUP turn that calls `ask` never
  holds the lock at all.

# water — Design Spec

WhatsApp daemon for Claude Code. One interactive Claude session per WhatsApp chat
(group or DM), driven over WuzAPI (whatsmeow), inheriting polygram's
production-hardened reliability architecture.

Status: DRAFT v3 — after two adversarial review rounds (34 + 32 findings folded).
Author: designed with Ivan, 2026-07-03.
Inputs: "UMI WhatsApp Bot — Reliability Options Analysis" (Google Doc, 2026-07-01/02),
polygram@0.17.10 source, wuzapi@7064214 source, whatsapp-claude-plugin@b907bce source,
umi-vps-infra, live VPS + live WuzAPI-spike inspection (2026-07-03).

---

## 1. Problem

The UMI WhatsApp bot (Claude channel plugin + Baileys, one shared interactive session
in tmux) has failed repeatedly for months; on 2026-07-01 a customer waited 4 hours and
was lost. Root causes are structural, not tunable:

- **RC-1** one long-lived session shared by every chat — any stall blocks all chats;
- **RC-2** no durable queue between transport and Claude — an MCP stall or bun crash
  silently drops messages;
- **RC-3** flat-file JSONL persistence with non-atomic rewrite-in-place;
- **RC-4** advisory recovery (Claude must remember to call `unreplied`);
- **RC-5** no binary pinning — claude auto-update to 2.1.197 broke the channel;
- **RC-6** research-preview channels flag with no stability contract;
- **RC-7** Baileys zombie sockets: connection reports open, delivers nothing.

Hard requirements (Ivan): keep the **interactive Claude session** model (warm context,
full Claude Code: skills, agents, subscription billing — not `claude -p` per message);
**WhatsApp group participation** (rules out official Cloud API / Twilio / Chatwoot
transports — no group support); **production reliability** (durable delivery, boot
replay, supervision).

Polygram (the Telegram sibling, v0.17.10, ~1600 tests, in production on this very VPS)
already solves every one of these for Telegram. water is the WhatsApp counterpart.

## 2. Decision record

**Chosen shape:** a standalone daemon, `water --account <name>`, one OS process per
WhatsApp account, that:

1. delegates the WhatsApp socket entirely to **WuzAPI** (asternic/wuzapi, Go REST
   bridge over whatsmeow) running as a docker service on loopback;
2. ingests WuzAPI webhook events into **its own SQLite** (write-before-ack) — water's
   DB is the durable inbox, WuzAPI's retry is only a bonus;
3. runs **one interactive Claude CLI session per chat JID** via polygram's process
   layer (ProcessManager + tmux lifecycle + channels-bridge MCP injection + hook-file
   observability), with the claude binary **pinned and vendored at 2.1.173**;
4. delivers replies through the WuzAPI REST send API under polygram's
   write-before-send discipline;
5. escalates failures to Ivan on **Telegram via polygram IPC** (both daemons share the
   VPS), with an SLA watchdog sending holding replies.

**Amendments vs the analysis doc** (what changed after verification):

| Doc said | water does | Why |
|---|---|---|
| One shared interactive session, feeder injects into it (§T3 bridge) | One session **per chat JID** | The shared session IS RC-1. Polygram's ProcessManager gives per-chat isolation while keeping sessions interactive. The doc's real constraint was "no `claude -p` per message", which per-chat sessions honor. |
| "~150-line feeder" | A polygram-sibling daemon | Turn-completion gating, wedge recovery, echo dedup, LID identity, group gating, boot replay are why polygram is big. The 150-line estimate described only the happy path. |
| WuzAPI dead-letter queue as safety net | water's SQLite is the durable inbox; **no RabbitMQ** | Verified in source: without RabbitMQ, wuzapi dead-letters are **silently dropped** (`rabbitmq.go:174-176`). The VPS has no RabbitMQ. water acks a webhook only after the row is committed; wuzapi's 5-attempt exponential retry (30/60/120/240s) covers water restart windows. |
| Pin binary (mentioned) | Pin **and vendor** 2.1.173 + keep the SDK-backend escape hatch | Channels API is research-preview and **currently broken upstream** for bare `server:` channels in 2.1.195+ (anthropics/claude-code#71792, open, no fix). 2.1.173 is production-proven on this VPS. Claude's auto-pruner deletes non-vendored versions (polygram outages 2026-06-21/22). |
| (not covered) | **No streaming-by-edit**; typing presence + optional ack reaction | Every WhatsApp edit fans a protocol message to all group members — high-frequency edits on an unofficial client are ban-signal territory. |
| (not covered) | **LID-aware identity** from day one | Group senders arrive as `...@lid` with `AddressingMode:"lid"`; phone JID only in `SenderAlt` when known. Allowlists keyed on E.164 alone break. |
| (not covered) | **Pull-model media** (`-skipmedia` + lazy download) | Inbound media is UNCAPPED in wuzapi (the 16/100 MB caps are send-side only; WhatsApp documents go to ~2 GB). Base64-in-webhook would make giant bodies both an OOM/DoS lever and an I1 violation. Pull-model keeps webhook bodies tiny and moves media fetch AFTER the gate. |

**Alternatives rejected (re-checked against source):**

- *Extend polygram with a WhatsApp transport.* Polygram has no transport seam —
  `handleMessage` is ~1000 Telegram-flavored lines; extraction would put production
  Telegram bots at risk for weeks. water copies modules instead (§13); if a third
  channel ever appears, a shared core can be extracted **from water's cleaner seams**.
- *Official Cloud API / Twilio / Chatwoot.* No group support. Disqualified for UMI.
- *Ready-made projects* (openclaw, crisandrews/claude-whatsapp, Rich627 plugin, GOWA,
  WuzAPI alone). None combine interactive channel session + groups + reliability;
  every interactive one is Baileys-based (the transport being replaced).
- *OpenClaw-style generic multi-channel abstraction (25 adapter interfaces).* water
  serves one transport; it gets exactly one internal `Transport` seam (§4.1) and a
  normalized inbound envelope — no speculative generality.
- *Embedding whatsmeow directly (Go sidecar of our own).* WuzAPI already is that
  sidecar, maintained (last commit 2026-07-01, 893★), MIT, spiked successfully
  against the real UMI account.

**Evidence provenance for the go-decision** (dated, so future readers can re-verify):

- *Phase-0 spike (2026-07-02, run by Ivan/Claude on the VPS, recorded in the analysis
  doc):* WuzAPI linked to the UMI WhatsApp as an additional device — confirmed live
  2026-07-03 by this spec's author via `GET /session/status` (`loggedIn:true`, jid
  `66821683034:3@s.whatsapp.net`) and `docker ps` (container up 25h), coexisting with
  the serving Baileys plugin. `GET /group/list` had returned the partner groups.
- *"2.1.173 production-proven" (2026-07-03, read-only SSH inspection):* five live
  `polygram-shumabit-channels-*` tmux sessions on the VPS, each running
  `~/.local/share/polygram/claude-bin/2.1.173`; VPS polygram config `pm: "cli"` at
  top level; claude's own versions dir held only 2.1.196–2.1.199 (auto-pruner).

## 3. System overview

```
WhatsApp cloud
     │ (whatsmeow linked-device socket — owned by WuzAPI, NOT by water)
     ▼
┌──────────────────────┐   webhook POST (loopback, JSON     ┌────────────────────────────┐
│ WuzAPI (docker,      │   + HMAC, small: -skipmedia) ────► │ water daemon (node,        │
│ 127.0.0.1:8099,      │                                    │ systemd Type=simple)       │
│ sqlite volume,       │ ◄──── REST: sends + lazy media     │                            │
│ -skipmedia)          │       downloads (loopback, token)  │  webhook receiver :8090    │
└──────────────────────┘                                    │  → verify HMAC             │
                                                            │  → normalize (LID-aware)   │
                                                            │  → recordInbound (SQLite,  │
                                                            │    write-before-ack,       │
                                                            │    dedupe chat+sender+id)  │
                                                            │  → ONE gate (policy/       │
                                                            │    mention/allowlist)      │
                                                            │  → media fetch (post-gate) │
                                                            │  → dispatcher (locks,      │
                                                            │    replay, auto-resume)    │
                                                            │  → ProcessManager          │
                                                            └─────────┬──────────────────┘
                                                                      │ per chat JID
                                                      ┌───────────────┴───────────────┐
                                                      ▼                               ▼
                                            tmux: claude CLI (pinned,        tmux: claude CLI …
                                            vendored 2.1.173)                (LRU-bounded pool)
                                            --dangerously-load-development-
                                            channels server:water-bridge
                                                      │ stdio MCP
                                                      ▼
                                            water-bridge (per-session unix
                                            socket back to daemon; injects
                                            <channel> msgs, receives reply/
                                            react/edit/ask tool calls)

Escalation path: water ──unix socket IPC──► polygram (shumabit bot, same VPS)
                 ──► Telegram DM to Ivan (plain-text notify; verdicts on water-owned surfaces)
```

Everything between the two loopback edges is polygram's proven architecture; the two
edges (webhook in, REST out), the WhatsApp-specific UX policy, and the **core
orchestration rewrite** (§13) are new code.

## 4. Components

### 4.1 Transport layer (new code)

The only module that knows WuzAPI exists. Interface consumed by core:

```
Transport
  // outbound — all sends route through ONE choke point (write-before-send, §4.4)
  sendText({chatJid, text, quote?: {msgId, participantJid}, mentions?: [jid]}) → {msgId, ts}
  sendMedia({chatJid, kind: image|audio|document|video, data|url, caption?, ptt?,
             fileName?, mimeType?, quote?}) → {msgId, ts}
  editText({chatJid, msgId, text}) → {msgId}       // water enforces the 20-min window (§4.4)
  react({chatJid, msgId, emoji|null, participantJid?, ownMessage?}) → void
  revoke({chatJid, msgId}) → void
  setTyping(chatJid, on|off)                        // re-sent every ~5s while on
  downloadMedia(mediaRef, kind, capBytes) → localPath   // POST /chat/download*, post-gate only
  sessionStatus() → {connected, loggedIn, jid, webhook, events}
  connectSession() → void                           // POST /session/connect (revive, §4.5)
  groupParticipants(chatJid) → [{jid, lid?}]        // jid_map seeding
  resolveLid(pnJid) → lidJid|null                   // GET /user/lid/{pn}
  // inbound — events pushed by the webhook receiver after normalization
  onMessage(InboundMessage), onEdit(...), onReaction(...), onRevoke(...),
  onConnectionEvent({kind: connected|disconnected|connect-failure|keepalive-timeout|
                     keepalive-restored|logged-out|temp-ban|client-outdated|
                     stream-error|pair-success, detail})
```

(Deliberately absent in v1: receipts — `ReadReceipt` not subscribed; poll votes;
sticker sends. Roadmap §17.)

Normalized inbound envelope (the internal currency — polygram's biggest structural
lesson is that it never defined one):

```
InboundMessage {
  chatJid, chatType: 'dm'|'group', msgId,                    // dedup: (chatJid, senderJid, msgId)
  sender: { jid,        // Info.Sender verbatim (pn- or lid-form)
            altJid?,    // Info.SenderAlt verbatim, when present
            pn?, lid?,  // derived: whichever of jid/altJid has @s.whatsapp.net / @lid suffix
            pushName /*unverified display name*/ },
  isFromMe, tsMs /*WhatsApp event time*/, receivedAtMs /*local*/, text,
  quote?: { msgId, participantJid, text?, fromMe? },
  mentions: [jid], edit?: {targetMsgId},
  attachments: [{ kind /*image|audio|video|document|sticker*/, mimeType, fileName,
                  sizeBytes /*from mediaRef.FileLength — known BEFORE download*/,
                  mediaRef {Url, DirectPath, MediaKey, Mimetype, FileEncSHA256,
                            FileSHA256, FileLength} }],
  rawJson /*webhook body — small under -skipmedia; forensics column, §5*/
}
```

**Media model — pull, not push (review-corrected twice):** wuzapi runs with
**`-skipmedia`**: no auto-download, no base64 in webhooks — webhook bodies are
text + metadata only (typically <100 KB). The media descriptors (`mediaRef`, embedded
in the event's `imageMessage`/`audioMessage`/… protos) are recorded with the
attachment row. Media bytes are fetched **after the gate, only for dispatched
turns**, via `POST /chat/download{image,audio,video,document}` — with the size
checked against `mediaRef.FileLength` **before** any download (default cap 32 MB,
`mediaMaxMb` per chat/account; over-cap → `failed('oversize')`, surfaced to Claude
as `<attachment-failed reason="oversize"/>`). Downloads are bounded-concurrency,
atomic-write (tmp+rename) into `inbox/<chatJid>/<msgId>.<ext>`, with the ported
three-layer size guard as backstop (declared length → streamed accumulator → final
check; the download response is base64 JSON, decoded streaming). Consequences:
inbound bodies can't OOM the receiver, a hostile group member can't fill the disk
pre-gate (nothing is written before the gate), WhatsApp's ~2 GB document ceiling is
handled by refusing the *attachment* while the *message* flows (I1 holds). Voice
notes (ogg/opus, usually <1 MB) download post-gate and transcribe (Whisper, provider
per config) inline. Failed/expired downloads surface as `<attachment-failed>`;
`/chat/request-unavailable-message` retry is roadmap.

**Webhook receiver:** HTTP on `<bindHost>:8090`, path `/hook/<random-token>` — loopback
(`127.0.0.1`) by default. `webhook.bindHost`/`webhook.advertiseHost` make it configurable for
deployments where WuzAPI and water do NOT share a network namespace (e.g. WuzAPI in Docker,
water on the host): bind a wider interface and advertise the docker-bridge gateway, then scope
the port with a firewall rule. water re-advertises on boot; the watchdog recognises its own
webhook by path, so a host change self-heals.
`WEBHOOK_FORMAT=json` mandated. Per delivery: read body (sanity cap 8 MB — far above
any -skipmedia payload; over-cap → 413 + `webhook-anomaly` event, safe because
legitimate deliveries cannot approach it), verify `x-hmac-signature` (HMAC-SHA256
over the raw body bytes — verified contract), parse, normalize, `recordInbound` in a
transaction, **then** respond 200.

- Response codes, exhaustively: 200 = row committed (or deduped); 401 = bad/missing
  HMAC; 400 = unparseable body; 404 = unknown path token; 413 = anomalous size;
  **500 = DB commit failure** — wuzapi's 5-attempt retry then works *for* us
  (write-before-ack means we want redelivery until committed).
- **401-storm alarm:** ≥3 `webhook-auth-fail` events within 10 min → CRITICAL
  escalation ("all inbound is being dropped — check WUZAPI_GLOBAL_ENCRYPTION_KEY /
  HMAC config"). Given wuzapi's 5 retries per delivery, one bad delivery can trip
  this — intended: unsigned delivery means total inbound death (wuzapi delivers
  **unsigned** when its stored HMAC key fails to decrypt — verified). The alarm
  latches: one CRITICAL page, then at most one re-page per 6 h while the condition
  persists, `all-clear` INFO on recovery.
- **Boot-time webhook assert/repair:** on start (and after `pair-success`), water
  compares the wuzapi user's `webhook` URL + `events` subscription against expected
  config and repairs drift via `POST /webhook`. **Split-brain guard:** repair only
  when the current URL is empty or carries water's own path-token history; a foreign
  URL is never overwritten — WARN escalation instead ("webhook owned by someone
  else — stale test consumer?"). The 60s status poll re-checks; repeated drift
  escalates.
- Dedup/ordering: `INSERT OR IGNORE` on `UNIQUE(chat_jid, sender_jid, msg_id)`
  absorbs wuzapi's 5-attempt redelivery, whatsmeow offline-sync replays after
  reconnect, and cross-event reordering (deliveries are per-goroutine; **no ordering
  guarantee**). Within a chat, dispatch order follows `tsMs`.
- **`GET /healthz`** (same listener, loopback, unauthenticated): 200 iff the event
  loop is alive and the heartbeat is fresh; JSON `{heartbeatAgeS, pending, escalated,
  lastWebhookAt, wuzapi: {connected, loggedIn}}` — the netdata httpcheck target (§11).

**`isFromMe` rule (echo-independent design):** whether wuzapi's webhook loops back
water's *own* REST sends is **UNVERIFIED** (own sends are mirrored to RabbitMQ only
in wuzapi's code; whatsmeow does not normally loop back same-client sends — Phase-0
fixture decides). water never depends on echoes: the sent-cache is populated at send
time from the ID water mints (§4.4). Any `IsFromMe:true` Message event that does
arrive — same-client echo, **a human answering from the phone**, or the Baileys
plugin during parallel-run — is recorded as `direction='out', source='human-device'`
(unless its msgId matches a water outbound row → attached as delivery evidence) and
is **never dispatched as an inbound turn**. Human-device messages also suppress the
SLA holding reply (§4.5).

**Inbound edits / reactions / revokes (v1 behavior, defined):** an **edit** upserts
the message row's text + `edited_ts` (schema supports it); if the target row is still
pre-dispatch the updated text is what dispatch uses; if already dispatched, the edit
is recorded only (edit-correction injection = roadmap §17). A **reaction** is
recorded as an `events` row (`inbound-reaction`), never dispatched. A **revoke** is
recorded as an `events` row (`inbound-revoke`) with the original text preserved
(audit posture); the agent is not notified in v1. Inbound **stickers** are normal
attachments (`kind:'sticker'`, webp).

**Identity/LID:** water persists a `jid_map` (pn ↔ lid, first-seen/last-seen,
pushName) fed from three sources: observed `Sender`/`SenderAlt` pairs, **boot-time
seeding** (`groupParticipants()` for every configured group + `resolveLid()` for
every configured pn-form `allowFrom`/`adminJids` entry — so allowlists work before
the first message, not after), and on-demand lookups. All allowlist/mention/admin
matching resolves through the map and matches on the identity **set** {pn-jid,
lid-jid}. **Unresolvable lid-only senders:** in an allowlisted group *without*
`allowFrom`, group membership is the boundary — lid-only senders pass. Where
`allowFrom` is set and the sender resolves to nothing, the message is dropped with a
distinct `gate-unresolved-identity` event + a one-per-sender INFO escalation
(a legitimate partner's first message is *visible*, never a silent repeat of the
lost-customer incident); resolution self-heals as `jid_map` learns pairs.

**Unknown-chat traffic** (not in config): the message row is recorded (text truncated
to 4 KB, for JID discovery + forensics), `ignored(unknown-chat)`; **no media is ever
fetched** for non-dispatched messages, so strangers cost bytes in SQLite only. Rows
from non-configured chats are pruned after 7 days (§5 retention).

### 4.2 Core pipeline (polygram architecture, water-shaped code)

`record → gate → media-fetch → dispatch → session → deliver`. The **primitives**
port (§13); the **orchestration** (polygram's `handleMessage` + `main()` boot
wiring, ~1,900 lines) is a deliberate rewrite with polygram as reference — leaner
because water has no topics, no streaming, no stickers-out, no Telegram callback
router (see §13).

- **recordInbound**: every message is recorded (transcript + reply-to lookups + JID
  discovery), atomically with its attachment rows.
  `handler_status` lifecycle — `received` → `dispatched` → terminal, where
  **terminal** = {`replied`, `failed`, `aborted`, `ignored`, `replay-attempted`,
  `replay-skipped`} (invariant I7 quantifies over exactly this set).
  `replay-pending` is the one non-terminal marker beyond the two live states: it is
  stamped on in-flight rows during graceful shutdown so the next boot can tell
  "interrupted mid-turn" from "never started".
  **`ignored` is new vs polygram**: the gate marks every non-dispatched row terminal
  (gate-dropped, unknown chat, unaddressed group chatter, isFromMe) with the reason
  code in `events` — so boot replay and the SLA watchdog operate only on turns that
  were actually intended.
- **ONE gate** (ported `gate-inbound` with WhatsApp predicates), ordered chain:
  configured-chat check → **abort** → **admin/verdict commands** → question-consume
  (numbered replies, §8) → **album-sibling inheritance** → `shouldHandle` (group
  policy + mention gate, §7) → dispatch, or mark `ignored(reason)`.
  - **Abort** (`/stop`, NL "stop"/"стоп"/Thai per config): handled here for all
    chats — it is NOT a config command and does not require `allowConfigCommands`.
    Authorized when: DM chat ‖ sender ∈ adminJids ‖ sender triggered the in-flight
    turn. Scoped to the chat's own session. Never re-executed on replay tiers.
  - **Admin/verdict commands** (`/model`, `/effort`, `/new`, `/status`,
    `approve|deny <id>`): verdict commands are gated by **adminJids only**
    (independent of `allowConfigCommands`, which governs the config commands —
    turning config commands off must not disable the approval surface).
  - **Album-sibling inheritance** (the UMI plugin's battle-tested P8 pattern):
    a media-bearing message from the same sender within 15 s of that sender's last
    gate-ACCEPTED message in the chat inherits the acceptance — "@umi here are the
    photos" + 3 more images delivers all four (they fold into the live turn via
    autosteer). Full album *coalescing* into one synthetic message remains roadmap;
    this bypass closes the known sibling-drop bug in v1.
- **Serialization**: per-session `stdinLock` across the full turn (claude batches
  concurrent user messages — verified polygram incident); `intentLock` for
  autosteer-vs-primary classification; follow-ups during a live turn are autosteered
  (injected into the running turn via the bridge's `user_msg`; claude folds queued
  messages). `queue-depth-warning` event past threshold (default 20). Known accepted
  edge (polygram parity): an autosteered follow-up shares the live turn's fate — if
  that turn crashes, replay recovers the *primary*, not the fold.
- **Boot replay**: clean-shutdown marker (in `daemon_state`), restart-intent
  disposition, completion gated on `turn_metrics` (`hasCompletedTurnFor` — never on
  "an outbound row exists"), replay window auto `1.2 × maxTurn`, one-shot
  `replay-attempted` pre-mark. Tier semantics:
  - `dispatched`/`replay-pending` rows (a turn had started): crash → recover;
    clean restart → skip + one visible "↺ Restarted…" notice per chat.
  - **`received` rows (committed at the webhook edge, never gated): ALWAYS re-enter
    through the normal gate as fresh-tier — on crash AND clean restarts.** They
    never started a turn, so re-gating cannot duplicate anything; skipping them on a
    clean restart (the documented onboarding procedure) would silently drop an
    already-acked customer message.
  - **Abort-aware exclusion:** candidates are dropped when a newer abort from an
    authorized sender exists in the same chat within the window — a crash landing
    between "abort executed" and "row marked aborted" must not resurrect the turn
    the user killed.
  - Replayed **question answers** whose question died with the crash: boot cancels
    open `pending_questions` whose session is gone and posts "the pending question
    was interrupted — please re-ask"; the replayed answer then re-gates normally
    (in a group it may land `ignored(unaddressed)` — acceptable, the notice covers
    it). Replayed **verdicts** against missing/expired approvals reply "approval
    expired".
- **Auto-resume**: 300s-idle wedge or `BRIDGE_DISCONNECTED` → respawn with
  `--resume <claude_session_id>` + continuation nudge, cooldown-guarded,
  `alreadyDelivered`-aware (field-proven on a WhatsApp incident, polygram
  2026-06-27).
- **Error classification**: ported `classify.js`/`net.js` — typed codes, calm
  user-facing messages per class (reworded for water's command set, bilingual per
  chat config), transient-retry only when zero output was produced, never echo raw
  errors to partners.

### 4.3 Process layer (lifted from polygram, ~90% verbatim)

ProcessManager (weighted LRU pool, cost: cli=3, budget default 9 → 3 warm cli
sessions; in-flight, open-question and background-work pins; concurrent-spawn
prevention; lazy respawn with `--resume` on bridge disconnect) + CliProcess (tmux
lifecycle, startup gate, hooks-ndjson turn observability, the turn-finalizer ladder,
input ledger, busy-aware ceilings, mid-turn dialog watchdog, interrupt — see
glossary §18 for these terms) + channels bridge (per-session 0600 unix socket,
single-shot secret auth, `notifications/claude/channel` injection with XML-escaped
body/meta, `reply`/`react`/`edit_message`/`ask` tools, mcp-ready + bridge-ready
handshake, ping/pong liveness) + claude-bin (pin **2.1.173**, vendor to
`~/.local/share/water/claude-bin/`, self-heal at boot, per-bump E2E revalidation
ritual — the single most important lesson carried over from polygram).

Renames: `water-bridge` server name, `WATER_*` env, `water-<account>-channels-*`
tmux prefix. Known adaptations (verified against cli-process source, not just
renames): message-id fields become strings end-to-end (incl. the two numeric-coercion
sites polygram has), the dispatcher call-shape at the tool boundary, and the
`--append-system-prompt` block (§4.4).

The `pm:` backend abstraction (factory: `cli` | `sdk`) is retained. `cli` is the
production default (subscription billing, full Claude Code). The SDK backend is the
**documented escape hatch** if Anthropic withdraws the research-preview channels flag
— porting it is deferred until needed, but nothing in water's core may assume
cli-only (the factory seam stays).

### 4.4 Delivery layer (new code around ported skeleton)

`channels-tool-dispatcher` for WhatsApp: `reply` → parse agent tags → sanitize →
markdown→WhatsApp-markdown downgrade (`*bold*`, `_italic_`, `~strike~`,
``` ```mono``` ``` — no HTML, no headings, tables as monospace blocks) → chunk
(budget 3500 chars, fence-aware, paren-aware — ported chunker) → per-chunk
`sendText` with quote on chunk[0] → first delivered msgId returned to the agent for
`edit_message`. Files: staging-dir allowlist + realpath checks + per-file cap
(16 MB image / 100 MB video-doc — wuzapi send caps), images → `sendMedia(image)`,
else document. `react` → `/chat/react` (`me:` prefix for own messages, `"remove"`
to clear). No automatic streaming edits: the ported streamer runs with
`canEditMessages=false`, so it never goes live and degrades to one-shot chunked
delivery (its cadence state machine is reused only for the finalize path). The
`edit_message` tool stays available for deliberate corrections, but **water enforces
the 20-minute window client-side** (wuzapi/whatsmeow do not — a late edit "succeeds"
yet no recipient sees it; the tool call is NACKed "too old to edit, send a follow-up
correction instead").

**Outbound choke point** (ported `api.js` skeleton): **mint the message ID
client-side** (`Id` is caller-supplied — verified) → insert `pending` row with the
real ID **and populate the sent-cache from it** (echo-independent, §4.1) → REST call
→ `sent` (+server ts) | `failed` (+classified error). **Never auto-retry a
possibly-landed send.** Ambiguity is arbitrated deterministically:

- water's REST client timeout is **45 s** — below the 60 s ambiguous-send sweeper —
  so the normal path always resolves the row before the sweeper looks (wuzapi passes
  `context.Background()` to whatsmeow, so a send on a sick socket can block a long
  time; the client timeout, not wuzapi, bounds it).
- the sweeper flips rows `pending` for >60 s to `failed('ambiguous-send')` + event
  and NACKs the blocked `reply` — "delivery unconfirmed: may or may not have reached
  WhatsApp; do NOT re-send verbatim — ask the user or move on."
- **late-success reconciliation:** a 200 arriving after the flip does a CAS
  `failed('ambiguous-send') → sent`, emits `late-send-confirmed`, satisfies the SLA
  watchdog, and appends a transcript note so the next turn's context knows the reply
  landed (the agent was already NACKed; this prevents the transcript permanently
  claiming failure for a message the customer can see).

Boot sweep flips stale `pending` → `failed('crashed-mid-send')`. Retry layers:
single retry on pre-connect errors only (loopback → "wuzapi restarting"); 5xx/429
classified and surfaced, not auto-retried.

**Presence:** typing indicator on accepted turns (`composing` re-sent every 5 s,
`paused` on delivery/error — ported typing.js breaker with the new call). Ack
reaction per-chat policy `never|mentions|always` (default: `mentions` in groups,
`always` in DMs).

**System-prompt contract** (`--append-system-prompt`, one combined block — CLI
quirk): "your stdout/TUI is invisible; deliver EVERYTHING via
`mcp__water-bridge__reply` with the chat_id verbatim; include `consumed_turn_ids`;
WhatsApp formatting rules (markdown subset, no headings, ≤3500-char messages, no
rapid message bursts); files via the staging dir; never send to a chat_id you
weren't messaged from; if a reply is NACKed 'delivery unconfirmed', don't re-send it
verbatim."

### 4.5 Ops layer

- **IPC server** (ported): `/tmp/water-<account>.sock`, per-boot secret, allowlisted
  methods (`sendText`, `sendMedia`, `react`, `setTyping`, `approve`, `deny`,
  `injectTurn`, `ping`). `injectTurn(chatJid, text, {source})` enqueues a **synthetic
  inbound** through the normal record→gate→dispatch pipeline (identity-gated to the
  socket secret) — this is how the migrated plugin cron jobs fire scheduled agent
  turns (a plain `sendText` would post as the bot and never run the agent; §14
  Phase 3). v1 callers: migrated cron entries, operator CLI (verdicts, test sends),
  the agent itself.
- **Escalation client**: `escalate(severity, text)` → polygram IPC
  (`tell(escalation.ipcBot, 'sendMessage', {chat_id: escalation.chatId, ...})`) to
  Ivan's Telegram. **Precondition (verified constraint):** polygram's IPC `send`
  rejects chats not in the target bot's own config — `escalation.chatId` must be a
  chat of `escalation.ipcBot` (Ivan's DM is in the shumabit bot's chats — holds
  today). water-doctor validates the full path with a real silent tagged message,
  not just a socket ping. On IPC failure: `escalation-failed` event + journald; the
  doctor cron is the water-independent backstop. INFO escalations respect quiet
  hours (01:00–07:00 BKK, house precedent); CRITICAL always pages.
- **SLA watchdog** — the "Lucy waited 4 hours" killer feature. Fires only for
  **dispatched** rows (gate-passed; `ignored` rows can never trigger it) with no
  completed turn and no delivered reply, once the turn is **both** past
  `holdAfterMs = max(slaMinutes·60000, chat.maxTurnHardMs + 120000)` **and** not
  provably still working (no `turn-extended`/busy heartbeat in the last interval).
  Keying off the *hard* ceiling + the busy signal is deliberate: the ported
  busy-aware ceilings re-arm while claude works, so a legitimate long turn exceeds
  `maxTurn` — holding-replying at `maxTurn+2min` would fire on every genuinely long
  answer (round-2 finding). Holding reply is sent **once per turn** (latch set only
  on confirmed send; a failed holding-send retries next tick), per-chat text
  (bilingual EN/TH). **Human-active suppression:** if a `human-device` outbound
  (§4.1) with `tsMs` *after* the stuck inbound's `tsMs` exists in the chat within
  the hold window, the robotic holding reply is **suppressed** — but an INFO
  escalation still fires ("turn stuck, human active in-chat"), so a wedged turn is
  never fully invisible even when staff are answering from the phone. (Clock: compare
  WhatsApp event `tsMs`, not `received_at`, so offline-replayed old phone messages
  don't false-suppress. During parallel-run the Baileys bot's sends pollute this
  signal — §14 notes it; staging soak allowlists only the test group.)
- **Transport watchdog** (two-signal + drift + bounded revive):
  (a) `GET /session/status` every 60 s — non-200 = down; `webhook`/`events` compared
  to expected config (drift → repair + WARN); (b) connection webhook events.
  `logged-out`/`temp-ban`/`client-outdated` → CRITICAL, and **no auto-revive** until
  a human acks (re-pair/wait/bump are inherently manual). `disconnected`/
  `keepalive-timeout` → events; escalate if not recovered in 5 min (whatsmeow
  auto-reconnects live drops — do NOT revive during this). **`connect-failure`
  (wuzapi exhausted its 3 retries, persisted `connected=0`) → auto-revive via
  `POST /session/connect`**, cooldown once/5 min, ≤3/h, `transport-revive` event
  each attempt, CRITICAL if revival fails or the state recurs. A bare status
  `connected:false` triggers revive only if it persists ≥3 consecutive polls AND no
  `disconnected` event was seen recently — because status cannot distinguish
  "wuzapi gave up" from "whatsmeow mid-reconnect", and reviving mid-reconnect spawns
  a second client → StreamReplaced kick (which wuzapi swallows → invisible). Never
  restart anything on message silence alone.
- **Process guard** (ported): PID file claim-and-kill before webhook bind, uncaught
  storm circuit breaker (exit 2 → systemd restart), stdio guard.
- **Telemetry**: `events` table (typed kinds incl. gate decisions with reason
  codes), `turn_metrics`, events retention with mass-delete guard — ported verbatim.
- **water-doctor**: config parse, DB schema version, wuzapi reachability + session
  status + webhook/events drift, receiver liveness (self-POST) + `/healthz`,
  vendored claude binary present, pending outbound rows, non-terminal SLA rows,
  escalation round-trip (silent tagged send), inbox disk usage. Exit codes for
  monitoring.
- **Monitoring wiring (concrete, house patterns):** water writes
  `~/water/heartbeat.json` (`{ts, pending, escalated, lastWebhookAt}`) every 60 s —
  the MONITORING_SPEC heartbeat-file pattern; a **water-doctor cron (5-min cadence)
  replaces the retired wa-watchdog** and alerts via polygram IPC with non-zero exit
  as the netdata-visible fallback; netdata: `water-umi.service` + wuzapi compose
  service in `netdata_watch_units`, `netdata_httpchecks` entries for
  `127.0.0.1:8099` and `127.0.0.1:8090/healthz`.

## 5. Data model

SQLite per account (`<account>.db`, WAL, busy_timeout 5s, FK on), numbered
migrations with `user_version` check-and-set in `BEGIN IMMEDIATE` (ported runner;
schema version derived from max migration number — fixes polygram's
"bump-the-constant" footgun).

```
messages        id PK, chat_jid TEXT, msg_id TEXT, sender_jid TEXT, sender_alt_jid TEXT,
                user TEXT /*pushName*/, text, raw_json /*small under -skipmedia*/,
                quote_msg_id TEXT, quote_participant TEXT,
                direction IN('in','out','system'), source, account, is_from_me INT,
                session_id, model, effort, turn_id,
                status IN('pending','sent','failed','received'),
                handler_status, error,
                ts INTEGER /*WhatsApp event time — ordering, SLA/suppression clock*/,
                received_at INTEGER /*local receive time — receiver/replay bookkeeping*/,
                edited_ts,
                UNIQUE(chat_jid, sender_jid, msg_id)
messages_fts    FTS5 external-content (text, user) + sync triggers
attachments     id PK, message_id FK CASCADE, kind, file_name, mime_type, size_bytes,
                local_path, download_status IN('pending','downloaded','failed'),
                media_ref_json /*Url, DirectPath, MediaKey, Mimetype, FileEncSHA256,
                                FileSHA256, FileLength — all 7 required by /chat/download*/,
                transcription_json, error
sessions        session_key PK /*chat JID*/, chat_jid, claude_session_id, agent, cwd,
                model, effort, pm_backend, created_ts, last_active_ts
turn_metrics    completion ledger: chat_jid, msg_id, turn_id, duration, result_subtype,
                error, cost fields (null on cli backend = unmeasured-subscription)
jid_map         pn_jid, lid_jid, push_name, first_seen_ts, last_seen_ts, UNIQUE(pn_jid, lid_jid)
events          ts, chat_jid, kind, detail_json  (+ retention policy, 50k/kind cap)
daemon_state    k/v: clean_shutdown_at, heartbeat_at, webhook_path_token, ...
pending_questions   ported lifecycle (numbered-reply UX, §8)
pending_approvals   ported lifecycle (verdict via admin command / IPC, §8)
chat_tool_decisions ported (persisted always-allow/deny)
secret_redactions   ported audit table
config_changes      ported audit of /model /effort /agent changes
```

Retention: events retention ported (time tiers + 50k/kind cap + mass-delete guard);
**inbox** files swept both on a 30-day age (ported) **and** against a per-account
total-size cap (`inboxMaxGb`, default 20) — oldest downloaded files evicted first
when over cap, on a periodic (hourly) sweep, not boot-only, so a busy allowlisted
group can't fill the shared disk between restarts; rows from non-configured chats
pruned at 7 days; `raw_json` is tiny (no media under `-skipmedia`).

Deliberately dropped from polygram's schema: `chat_migrations` (no Telegram group
upgrades), `polling_state` (webhook-driven; marker in `daemon_state`),
`pair_codes`/`pairings` (v1 uses static allowlists; pairing is roadmap).

## 6. WuzAPI contract

Verified against source (asternic/wuzapi@7064214, whatsmeow pin 8d3700152a69) —
full reference with quotes in [`docs/wuzapi-contract.md`](./wuzapi-contract.md).
Load-bearing facts:

1. Webhook payload = raw whatsmeow event structs (`postmap.event`), Go field names,
   `type` discriminator; JIDs as strings; embedded `MessageSource` flattens into
   `Info`. Under `-skipmedia` no media bytes ride the webhook — descriptors only.
2. `WEBHOOK_FORMAT=json` signs the exact raw body bytes (HMAC-SHA256 hex,
   `x-hmac-signature`); form mode signs a different byte string — water mandates json.
3. Retry: 5 attempts, exponential 30s base; **dead letters need RabbitMQ or are
   silently dropped**; deliveries are per-event goroutines — no ordering guarantee.
4. Sends accept caller-minted `Id` and return `{Details,Timestamp,Id}`; quotes need
   `ContextInfo.{StanzaID,Participant}`; mentions need explicit
   `ContextInfo.MentionedJID`. Inbound media is **uncapped** in wuzapi (send caps
   16/100 MB are send-side only) → pull-model (§4.1).
5. Edit = `BuildEdit` (20-min window, **unenforced anywhere** — water enforces);
   react remove = `Body:"remove"`; revoke own-messages only.
6. Typing = one-shot `composing`/`paused` chat presence — caller re-sends.
7. Offline-missed messages replay as **normal Message webhooks** on reconnect;
   HistorySync events do NOT re-emit messages (DB-only). Dedup on
   `(chat, sender, msgId)` absorbs both.
8. `Info.ID` sender-minted, globally unique, byte-stable across retries. **Whether
   water's own REST sends echo back as webhooks is UNVERIFIED** — design is
   echo-independent (§4.1).
9. Connection events are subscription-gated; `StreamReplaced` is swallowed (bug —
   don't wait for it); `Receipt` arrives as `"ReadReceipt"`. `/session/status` reads
   live socket state; treat non-200 as down. **After `ConnectFailure`
   retry-exhaustion wuzapi persists `connected=0` and stays down until
   `POST /session/connect`** — water auto-revives (§4.5).
10. Buttons/lists carry render-workaround scars — treated as unavailable. Polls
    work but vote plaintext dies with wuzapi's in-memory cache — not used in v1.
11. **All three env keys + the sqlite volume must be persisted** or the linked
    session/config is lost on container recreate (the spike container has ephemeral
    keys — Phase 0 re-pairs with persisted ones).

## 7. Groups & access control

Fail-closed policy model (OpenClaw-verified semantics, CW/UMI-plugin battle-tested):

- `dmPolicy: "allowlist"` (account-level) — only configured DM JIDs; unknown DMs
  recorded (text-only, capped, 7-day retention), `ignored(unknown-chat)`, surfaced
  via the daily unknown-chats digest (§12).
- `groupPolicy: "allowlist"` — only configured group JIDs; empty allowlist blocks
  (never "empty = open"). Unknown-group traffic handled as above.
- Per-chat config: `requireMention` (default **true**), `mentionPatterns` (regex
  strings compiled case-insensitive, e.g. `"\\bumi\\b"`), `allowFrom` (identity
  sets; optional — absent means any member of the allowlisted group), `agent`,
  `cwd`, `model`, `effort`, `ackReaction`, `maxTurn`, `holdingReply`.
- Mention gate satisfied by: native `@` mention of the bot (mentions list ∋ bot
  pn/lid), OR quote-reply to a bot message, OR `mentionPatterns` match. **Reply-to-bot
  satisfies mention-gating but never sender authorization** — an `allowFrom`-filtered
  group still drops non-listed senders' replies. (Reply-to-bot is also how partners
  naturally answer agent questions asked in prose — the gate admits those without
  re-mentioning.)
- Unresolvable lid-only senders: §4.1 (pass without `allowFrom`; visible drop + INFO
  escalation with `allowFrom`; boot-seeded participant lists minimize this).
- Every gate decision emits a typed reason code to `events`, and non-dispatched rows
  are marked `ignored(reason)` — "why didn't the bot answer?" is one query, and
  ignored rows can never trip replay or the SLA watchdog.
- All inbound text/names XML-escaped inside `<channel>`/`<untrusted-input>` envelopes
  (the current UMI plugin does NOT escape message bodies — water closes this hole).
  Push names labeled unverified; identity claims in text never trusted (sender JIDs
  are the only identity). Bot's own identity set (pn + lid) drives mention detection.

## 8. Interactive surfaces (no buttons on WhatsApp)

- **Questions (`ask` tool)**: numbered text — "1) … 2) … — reply with a number"
  (multi-select: space-separated). The gate's question-consume stage captures the
  **asking-context sender's** next message in that chat; other members flow normally.
  Timeout + eviction-pin + keep-alive machinery ported. Boot: sessions that died with
  an open question are swept and the chat told to re-ask (§4.2).
- **Approvals — v1 verdict path:** UMI chats default `bypassPermissions` (current
  production posture) — approvals have **zero v1 traffic**; the machinery exists for
  non-bypass chats an operator may configure. On `approval-required`: water sends a
  **plain-text** notification to Ivan's Telegram via polygram IPC (card text + `id`).
  The verdict returns on a **water-owned surface** — polygram cannot relay Telegram
  button clicks back to water (its IPC is `ping` + one-way `send`; its callback
  router only answers its own approval ids — verified). Verdict entered via:
  `approve <id>` / `deny <id>` in Ivan's WhatsApp DM (adminJids-gated, handled at the
  gate's admin-command stage, **independent of `allowConfigCommands`**), or
  `water-ipc approve <id>` over water's socket. Idempotent against live
  `pending_approvals` (a replayed/duplicate verdict against a resolved/expired id
  replies "approval expired"). Timeout → auto-deny. Approvals **never** accepted from
  groups. Telegram *buttons* for water approvals are roadmap §17 (needs a
  polygram-side callback-relay op).
- **Config commands** (`/model`, `/effort`, `/new`, `/status`): text replies, gated
  to `adminJids` + per-account `allowConfigCommands` (default off — partner chats
  route everything to the agent). `/stop` is **not** here — it is abort, handled at
  the gate's abort stage for all chats (§4.2).

## 9. Failure modes & invariants

Invariants:

- **I1** Every inbound is committed to SQLite **before** the webhook is acked; a
  signed parseable delivery is always acked (media degrades to `<attachment-failed>`;
  the message never drops). recordInbound failure returns 500 so wuzapi retries.
- **I2** Every outbound has a `pending` row with its real msgId **before** the REST call.
- **I3** A turn is "complete" only when `turn_metrics` says so; replay dedups on that.
- **I4** No possibly-landed send is ever auto-retried — by water *or the agent*
  (ambiguous-send NACK). Duplicate > missing; missing is recoverable by the SLA watchdog.
- **I5** Any redelivery path converges on ONE tail with a once-only guard.
- **I6** The daemon never dies from a DB write failure, a transport error, or an
  unclassified exception (storm breaker excepted — deliberate clean exit).
- **I7** Every recorded inbound reaches a **terminal** handler_status (`ignored`
  counts) — nothing is invisibly in-limbo to replay or SLA logic.

| Failure | Behavior |
|---|---|
| water crashes mid-turn | systemd restarts; crash-intent replay redispatches unanswered dispatched rows + re-gates `received` rows; completed turns gated out via turn_metrics |
| water down > 7.5 min | wuzapi retries exhausted → gap possible; mitigations: `Restart=always` (seconds), heartbeat + doctor-cron + netdata alerts; **known accepted residual risk** (no RabbitMQ) |
| giant inbound media (up to ~2 GB doc) | webhook body stays tiny (`-skipmedia`); size checked vs `FileLength` before download; over-cap → `failed('oversize')`, message + text still dispatch (I1) |
| hostile group member spams media | nothing downloaded pre-gate; `ignored` rows never fetch media; downloaded files bounded by `inboxMaxGb` eviction |
| wuzapi container down | sends fail (pre-connect, classified) → events + escalation; WhatsApp queues; on restart replays as normal webhooks → dedup + dispatch |
| wuzapi up, socket dead (live drop) | Disconnected/KeepAliveTimeout events + poll; whatsmeow auto-reconnects; escalate > 5 min; **no revive** (would double the client) |
| wuzapi ConnectFailure (retries exhausted, connected=0) | whatsmeow won't self-heal — water auto-revives `POST /session/connect` (cooldown 5 min, ≤3/h) then CRITICAL |
| unsigned webhooks (encryption-key mismatch) | 401 per delivery + **latched 401-storm CRITICAL** — the "both watchdogs green" death mode made loud |
| webhook URL/subscription drift | boot + poll assert/repair (split-brain-guarded); escalate on repeated/foreign drift |
| logged out / temp ban / client outdated | CRITICAL; transport-independent (Telegram) so it fires even with WhatsApp fully down; no auto-revive until human ack |
| claude wedges (idle 300s) | auto-resume: teardown, respawn `--resume`, continuation nudge, cooldown |
| claude TUI dialog mid-turn | mid-turn dialog watchdog answers catalogued prompts / escalates unknown ones |
| bridge socket dies | pendings drained BRIDGE_DISCONNECTED → lazy respawn on next message |
| claude auto-updates | irrelevant: vendored pinned binary |
| channels flag withdrawn upstream | stay on vendored 2.1.173 until the SDK backend is ready (factory seam warm); #71792 tracked |
| ambiguous send (timeout/5xx after possible delivery) | 45 s client timeout resolves first; else sweeper → `failed('ambiguous-send')` + agent NACK; late 200 → CAS to `sent` + note |
| late `edit_message` (>20 min) | NACKed client-side (recipients would silently ignore it) |
| duplicate / reordered webhooks | UNIQUE dedup + per-chat ts ordering; sent-cache at send time (echo-independent) |
| human answers from the phone | `IsFromMe` recorded `human-device`, never dispatched; suppresses holding reply (INFO escalation still fires) |
| gate-dropped / unaddressed chatter | terminal `ignored(reason)`; can never trigger replay, SLA, or holding replies |
| album with one mention + N media | album-sibling inheritance (15 s window) folds siblings into the accepted turn |
| burst in one chat | autosteer merges into live turn; stdinLock serializes; queue-depth warning event |
| two water daemons (deploy race) | PID-file claim kills the orphan before webhook bind |
| DB corruption / migration failure | daemon refuses to start (loud); doctor diagnoses |
| partner sends `</channel><system>…` | XML-escaped — literal text |
| dispatched turn stuck past hard ceiling + idle | holding reply (once, per-chat text) + escalation; suppressed→INFO if a human is active |
| message lands during clean restart | webhook listener stops first; in-flight drains before the clean marker; `received` rows always re-gate next boot |
| approval verdict surface unreachable (polygram down) | notify fails → `escalation-failed` + auto-deny at timeout; verdict still possible via WhatsApp admin DM / water IPC |

## 10. Security

Threat model: hostile/curious partner-group members (injection, spoofing, command
abuse), a *confused* agent session (mis-addressed writes), local processes on the
shared VPS, WhatsApp platform risk. **Honest boundary statement:**

- The per-session bridge socket (random name, 0600, single-shot secret) and the
  reply-tool chat_id NACK are **confusion-guards, not a security boundary.** The
  agent runs as the same UID as the daemon, in `bypassPermissions`, with a live Bash
  tool: a fully prompt-compromised agent could read the wuzapi user token from disk
  and call WuzAPI directly, bypassing every water guard. This is the same shared-UID
  posture polygram already accepts — **documented and accepted** for v1. Mitigations
  that DO hold: per-chat agents with minimal prompts/cwd, XML-escaped untrusted input
  (the injection must defeat the agent, not the framing), allowlist gates limiting
  who can talk at all, and the transcript/events audit trail. Per-chat UID isolation
  / token brokering → §17.
- Loopback-only surfaces by default: wuzapi API, water webhook receiver (+ HMAC + path token),
  water IPC socket (0600 + per-boot secret). UFW: 22/80/443 — plus a source-scoped rule for the
  webhook port when water binds beyond loopback for a Docker-networked WuzAPI (allow only the
  docker-bridge subnet; public stays denied).
- **wuzapi's data volume is credential material** (whatsmeow device session = full
  WhatsApp account takeover; user tokens plaintext; `GLOBAL_ENCRYPTION_KEY` protects
  neither): volume dir 0700 `shumabit:shumabit`, excluded from world-readable
  backups; env keys via Infisical (`CRED_WATER_*`) → tmpfs render; never in argv.
- Secrets hygiene: known-secret literal scrubbing in persisted errors/logs (wuzapi
  tokens are arbitrary strings — redaction by configured value, not pattern),
  secret-detect sweep (dry-run default), `[redact:…]` agent tag ported. Bridge
  mcp-config written 0600 (socket secret never in argv/cmdline).
- Prompt injection: XML-escape everything user-supplied; push names unverified;
  approvals never from groups; config/verdict commands identity-gated to adminJids
  (pn+lid set).
- File sends: staging-dir + session-cwd allowlist with realpath checks; state-dir
  exfiltration blocked (`assertSendable`).
- Ban-risk posture: no streaming edits, modest reaction cadence, no bulk sends,
  human-paced typing. Residual linked-device ban risk is inherent and accepted
  (official APIs can't do groups).

## 11. Deployment (UMI VPS)

- **wuzapi**: `/opt/umi/wuzapi` compose stack (ansible role `wuzapi`, tag-gated,
  service-enable flag **default off** — house safe-provision rule): image pinned by
  digest, `127.0.0.1:8099:8080`, sqlite on `/opt/umi/data/wuzapi` (0700),
  **`-skipmedia`**, env from Infisical: `WUZAPI_ADMIN_TOKEN`,
  `WUZAPI_GLOBAL_ENCRYPTION_KEY`, `WUZAPI_GLOBAL_HMAC_KEY`, `WEBHOOK_FORMAT=json`,
  `TZ=Asia/Bangkok`. No RabbitMQ. `restart: unless-stopped`.
- **water**: npm global install; release flow mirrors polygram **including the
  mandatory `npm rebuild better-sqlite3` after every install/node bump**; **own
  systemd unit** `water-umi.service`, `Type=simple`, `User=shumabit`,
  `Restart=always`, `RestartSec=3`, `After=network-online.target
  shumabit-secrets.service docker.service`, service-enable flag default off. NOT part
  of the `start-sessions.sh` tmux oneshot (no fleet-coupled restarts, real MainPID,
  clean SIGTERM). tmux only for the claude panes water spawns.
- Data dir `~/water/` (config.json, umi.db, inbox/, heartbeat.json; logs journald).
- **Monitoring**: §4.5 wiring — `netdata_watch_units` += water-umi.service + wuzapi;
  `netdata_httpchecks` += 127.0.0.1:8099, 127.0.0.1:8090/healthz; water-doctor cron
  every 5 min (replaces wa-watchdog).
- **Resource budget** (24 GB box, ~17 GB free today): water ~100 MB; cli claude
  ~550 MB each, budget 9 → 3 warm ≈ 1.7 GB; wuzapi ~150 MB. Peak = parallel-run
  (Baileys + water pool) ≈ +2.5 GB — comfortable; revisit if group count grows.
- Ports added: 8090 water webhook (loopback by default; bridge-scoped when WuzAPI is dockerized),
  8099 wuzapi (reuse of spike port).

## 12. Configuration

```jsonc
{
  "accounts": {
    "umi": {
      "wuzapi": { "baseUrl": "http://127.0.0.1:8099" },       // tokens via files/env, not inline
      "webhook": { "port": 8090 },
      "dmPolicy": "allowlist",                                 // v1: allowlist only
      "groupPolicy": "allowlist",
      "adminJids": ["<ivan-pn-jid>@s.whatsapp.net", "<ivan-lid>@lid"],
      "allowConfigCommands": true,
      "mediaMaxMb": 32,                                        // per-attachment download cap
      "inboxMaxGb": 20,                                        // total inbox eviction cap
      "escalation": { "ipcBot": "shumabit", "chatId": "68861949",
                      "slaMinutes": 10,
                      "quietHours": { "from": "01:00", "to": "07:00", "tz": "Asia/Bangkok" } },
      "holdingReply": { "en": "Hi! We're on it — a human will follow up shortly. – UMI",
                        "th": "สวัสดีค่ะ ทีมงานกำลังดำเนินการ เดี๋ยวมีเจ้าหน้าที่ติดต่อกลับนะคะ – UMI" },
      "voice": { "enabled": true, "provider": "openai" },
      "ackReaction": { "dm": "always", "group": "mentions" },  // same shape at chat level
      "processBudget": 9                                        // LRU budget; cli cost=3 → 3 warm sessions
    }
  },
  "chats": {
    "120363419377779909@g.us": {
      "name": "Umi sales", "account": "umi",
      "agent": "umi-partner", "cwd": "/home/shumabit/agents/umi-sales",
      "model": "sonnet", "effort": "medium",
      "requireMention": true, "mentionPatterns": ["\\bumi\\b"],
      "allowFrom": ["<partner-pn>@s.whatsapp.net"],           // optional; omit = any group member
      "maxTurn": 600000, "maxTurnHard": 5400000,               // idle ceiling / hard backstop (ms)
      "ackReaction": { "group": "mentions" },
      "holdingReply": { "th": "…" }
    },
    "120363428256892469@g.us": { "name": "UMI x Tree O'Clock", "account": "umi", "...": "..." },
    "<partner-dm-jid>@s.whatsapp.net": { "name": "Partner DM", "account": "umi", "...": "..." }
  },
  "defaults": { "model": "sonnet", "effort": "medium", "maxTurn": 600000, "maxTurnHard": 5400000 }
}
```

`maxTurn` = idle ceiling (resets on activity); `maxTurnHard` = absolute backstop —
the SLA watchdog keys off the hard one (§4.5). There is one turn-length concept, not
a separate `timeout`. Per-group personas = per-chat `agent`/`cwd` (Claude Code agent
dirs — richer than the plugin's `config.md` "Soul"; Souls **and `memory.md`** migrate
into agent dirs at cutover, §14). Config runtime-mutable only via admin commands
(audited in `config_changes`).

**Group onboarding (recurring op), v1:** unknown-chat traffic is recorded and
surfaced as a daily Telegram digest (escalation client) with copy-pasteable JIDs;
adding a group = edit config.json + `systemctl restart water-umi` — a **clean
restart**, so in-flight turns are skipped with a visible "↺ Restarted" notice while
`received`-but-ungated rows are re-gated (§4.2), and the shutdown stops the webhook
listener first to shrink the window; the runbook says check `/status`/pending first.
A `/add-chat <jid>` admin command (atomic saveConfig, no restart) is roadmap §17.

## 13. Reuse map (polygram@0.17.10 → water)

Mechanism: **copy with provenance** (`docs/PROVENANCE.md`: module → polygram path +
commit), not an npm dependency on polygram internals (no semver contract on `lib/`,
independent release cadences). MIT, same author.

| Verbatim (rename-only) | Adapt (structure kept, surface changes) | Rewrite (WhatsApp-specific / water-new) |
|---|---|---|
| process-manager, process/{process, channels-bridge.mjs, channels-bridge-server, channels-bridge-protocol, factory, hook-settings, hook-event-tail, hook-append}, tmux/* | cli-process (~90%; string msg-ids, dispatcher call-shape, system-prompt block) | **core orchestration — handleMessage/main() equivalents (~1,900 lines in polygram, reference-not-copy): boot wiring, turn lifecycle, result classification, delivery paths, shutdown/replay execution** |
| claude-bin, process-guard, async-lock, queue-utils, config-scope, secret-detect, replay-disposition, media-group-buffer (re-keyed on chat+sender+window for album-sibling) | error/classify (messages reworded, bilingual), error/net (redactor → literal-value scrub), session-key (topics dropped), db.js runner (schema differs), db/{sessions, auto-resume, replay-window, sent-cache, events-retention, secret-sweep, inbox} (string ids, new columns) | transport/ (wuzapi client, webhook receiver, normalizer, jid_map, media pull) |
| streamer (run non-streaming, canEdit=false), chunk, sanitize-reply, announces, voice engine | gate-inbound (WhatsApp predicates + `ignored` marking + album-sibling stage), record-inbound (envelope mapping), prompt.js (meta vocabulary), api.js send choke point (retry re-targeted, minted-Id sent-cache, ambiguous-send sweeper), typing.js (presence + re-send), dispatcher skeleton, redeliver/drop-redeliver (envelope reconstruct), attachments filter | format (markdown→WA), display-hint, channels-tool-dispatcher delivery half, approvals/questions render + verdict layer, doctor checks, SLA + transport watchdogs, escalation client, injectTurn, healthz/heartbeat |
| ipc/{server,client} | abort-detector (add Thai) | ansible role wuzapi + water unit |

**Not ported in v1** (each a deliberate cut): full album *coalescing* into one
synthetic message (v1 has the sibling-inheritance gate bypass instead —
media-group-buffer is ported for that), pairings/pair-codes, rewind, stickers-out,
polls, ReadReceipt tracking, compaction-warn UX (re-evaluate after soak), Telegram
history skill.

## 14. Migration & cutover

- **Phase 0 — prep (½–1 day, VPS):** wuzapi compose stack with **persisted keys +
  volume** and `-skipmedia`; **unlink the stale spike device** after the new pairing;
  re-link (phone pair-code); confirm groups visible; create the water webhook user
  with events `Message,Connected,Disconnected,ConnectFailure,KeepAliveTimeout,
  KeepAliveRestored,LoggedOut,TemporaryBan,ClientOutdated,StreamError,PairSuccess`
  + HMAC key; **capture live payload fixtures** — the full list in
  [`wuzapi-contract.md` §7](./wuzapi-contract.md), including the own-send echo probe,
  an album, a phone-originated IsFromMe, and a ConnectFailure — into
  `tests/fixtures/` via a throwaway listener + a test group (Ivan + bot only);
  **inventory the plugin's live `## Cron Jobs`** so the Phase-3 port list is known.
  The Baileys plugin keeps serving production throughout.
- **Phase 1a — foundations (~1 week):** repo scaffold; ported modules compiling with
  unit tests green; migrations; transport + normalizer green against fixtures; send
  path against a wuzapi mock.
- **Phase 1b — core orchestration (~1–2 weeks):** handleMessage/main equivalents,
  gate + group policy, delivery dispatcher, watchdogs, escalation, doctor; full suite
  green; E2E real-claude test (vendored 2.1.173) against a local dev wuzapi on the
  Mac. *(Honest estimate: the original "2–3 days" ignored ~1,900 lines of
  orchestration rewrite.)*
- **Phase 2 — staging soak (48h+, VPS):** `water-umi.service` live, allowlisting ONLY
  the test group + Ivan's DM; Baileys untouched. §15 chaos drills executed. Verify
  plugin behavior on access.json edit (hot-reload vs restart) **before** Phase 3.
- **Phase 3 — cutover (1 day):** migrate `groups/<jid>/{config.md,memory.md}` into
  water agent dirs; port the inventoried cron jobs to system cron entries calling
  `water-ipc injectTurn`; add partner groups + DMs to water config; remove them from
  the plugin's access.json (restart plugin if it doesn't hot-reload); monitor
  24–48h; retire the `channels:whatsapp` tmux window, wa-watchdog cron, plugin
  scripts. **Rollback** = re-enable plugin allowlist (Baileys device stays paired
  until Phase 4) **and copy water-era memory.md deltas back**.
- **Phase 4 — hardening:** netdata wired; runbook (`docs/OPS.md`); unlink the Baileys
  device; update INFRA_SPEC/WHATSAPP.md; post-incident SLA review.

## 15. Test & verification plan

- **Unit/integration** (node:test, no network): gate matrix (policy × mention ×
  allowFrom × LID forms × isFromMe × unknown-chat × album-sibling), normalizer vs
  fixtures, dedup (retry, reorder, offline replay), boot replay dispositions incl.
  `received`-row re-gate on clean AND crash restart, abort-then-crash exclusion,
  replayed dead-question notice, replayed stale verdict, write-before-send +
  ambiguous-send sweeper + late-success CAS + stale-pending sweep, sent-cache at mint
  time, chunker/formatter golden tests, SLA watchdog (hard-ceiling+busy math,
  gate-dropped exclusion, human-active suppression by event-ts, once-per-turn latch),
  401-storm latch, webhook assert/repair split-brain guard, connect-failure revive
  cooldown + no-revive-during-reconnect, edit-window NACK, question consume, verdict
  commands, HMAC verifier (byte-exact vectors incl. a captured real delivery),
  inbox eviction cap.
- **Contract tests**: `wuzapi-mock` replaying fixtures; send-path assertions on exact
  request bodies (PascalCase fields, ContextInfo shapes).
- **E2E (gated `E2E_REAL_CLAUDE=1`)**: ported polygram e2e-channels test against the
  vendored 2.1.173 — spawn, inject, reply round-trip, resume, interrupt.
- **Chaos drills (staging checklist)**: kill -9 water mid-turn → replay without
  duplicate send; docker restart wuzapi mid-turn → reconnect + offline replay dedup;
  block webhook port 10 min → retry absorption + gap alarm; swap
  `WUZAPI_GLOBAL_ENCRYPTION_KEY` → 401-storm page; giant (>200 MB) document → message
  dispatched, attachment `oversize`; message lands during a clean restart → answered
  after reboot; revoke claude binary → doctor + boot self-heal.
- **Every bug fixed during build gets a red-first regression test** (house TDD rule).

## 16. Open decisions (for Ivan)

1. **npm name**: `water` is squatted (dead 2012 package) — `watergram` (free) or
   `@shumkov/water`? Repo/binary stay `water` regardless.
2. **Escalation target**: shumabit bot → Ivan DM (68861949) assumed — confirm.
3. **Approval verdict surface**: WhatsApp admin-DM commands + water IPC (spec'd) — or
   is bypass-only acceptable for v1 (drop the verdict machinery until polygram grows a
   callback relay)?
4. **Reaction richness v1**: ack-only (spec default) vs polygram's full status
   reactor at a slowed cadence?
5. **Unknown-DM policy**: drop+log+digest (spec default) vs auto-holding-reply?
6. **Voice provider**: reuse the plugin's existing Whisper/Groq/OpenAI key order?
7. **Thai NL abort words** alongside en/ru — confirm the list with a Thai speaker.

## 17. Deferred / roadmap

SDK backend port (activate if the channels flag dies), Telegram-button approvals
(needs a polygram callback-relay IPC op), `/add-chat` runtime onboarding command,
pairing codes, message-edit correction injection (wire the ported redelivery
subsystem after soak), ReadReceipt-based delivery evidence, poll-render questions,
**full album coalescing** into one synthetic message (v1 ships sibling-inheritance),
history query skill, per-chat UID isolation / token brokering for claude panes,
multi-account fleet docs.

## 18. Glossary (polygram terms carried into water)

- **fresh-tier** — the gate's normal path for a newly-received message (vs the
  edit/redelivery/replay tiers), all sharing one ordered chain (§4.2).
- **ONE tail** — the single unified redelivery function every re-dispatch path
  converges on, with the once-only guard (invariant I5).
- **turn-finalizer ladder** — polygram's tiered turn-completion detection (attributed
  Stop hook → activity-quiet → legacy reply-quiet) that decides when a Claude turn is
  done; ported verbatim.
- **input ledger** — per-input lifecycle tracker (written → seen → resolved | dropped
  | superseded) that detects silently-dropped injections and drives one redelivery.
- **busy-aware ceilings** — the 3-tier turn timeout (idle 10 min → absolute
  checkpoint 30 min that probes whether claude is still working and re-arms → hard
  backstop `maxTurnHard`); the SLA watchdog keys off the hard tier (§4.5).
- **consumed_turn_ids** — the ack a reply carries to tell the daemon which pending
  turn(s) it answers, driving completion + dedup.
- **autosteer** — merging a follow-up message into the in-flight turn instead of
  queuing a new one (§4.2).
- **announces** — opt-in "subagent working…" notices (ported, low priority for v1).
# water — Implementation Spec

The build-level companion to [`SPEC.md`](./SPEC.md) (the design + rationale) and
[`wuzapi-contract.md`](./wuzapi-contract.md) (the verified transport contract). This
doc is the "exactly what to build": module tree, SQL, interfaces, provenance, and an
ordered task breakdown. It assumes SPEC.md decisions; where an open decision (SPEC
§16) changes a detail, it is flagged `[OPEN]`.

Status: DRAFT v1, tracks SPEC v3. No code yet — gated on Ivan's sign-off (SPEC §16).
Stack: Node ≥22 (24 on the VPS), `better-sqlite3`, no framework. node:test. ESM
where polygram is ESM (`.mjs` bridge), CJS elsewhere to match polygram provenance.

---

## 1. Repository layout

```
water/
  package.json                 bin: water, water-doctor, water-ipc
  polygram.js  → water.js      main daemon entry (rewrite of polygram.js main())
  bin/
    water-doctor.js            health CLI (SPEC §4.5)
    water-ipc.js               operator CLI over the IPC socket (verdicts, test sends)
  lib/
    config.js                  load + validate + atomic saveConfig          [adapt]
    config-scope.js            account narrowing (polygram bot-scope)        [verbatim]
    session-key.js             chat JID → session key (topics removed)       [adapt]
    async-lock.js  queue-utils.js  secret-detect.js                         [verbatim]
    process-guard.js  claude-bin.js                                          [verbatim*]
    db.js                      migration runner + prepared statements        [adapt]
    db/
      sessions.js  auto-resume.js  replay-window.js  sent-cache.js           [adapt]
      events-retention.js  secret-sweep.js  inbox.js                         [adapt]
      jid-map.js               NEW — pn↔lid store + resolution
      outbound.js              NEW — write-before-send row lifecycle helpers
    transport/                 NEW — the only WuzAPI-aware code
      client.js                REST: send*, edit, react, revoke, presence,
                               downloadMedia, sessionStatus, connectSession,
                               groupParticipants, resolveLid
      webhook-receiver.js      http server :8090, HMAC verify, /healthz
      normalize.js             raw whatsmeow event → InboundMessage
      hmac.js                  verify(rawBody, sig, key)
    handlers/
      record-inbound.js        envelope → messages+attachments txn           [adapt]
      gate.js                  ONE gate (WhatsApp predicates, ignored marks)  [adapt]
      dispatcher.js            per-session dispatch, locks, replay, resume    [adapt]
      redeliver.js             the ONE redelivery tail                        [adapt]
      abort-detector.js        NL stop + /stop (+ Thai)                       [adapt]
      slash-commands.js        /model /effort /new /status                    [adapt]
      approvals.js             verdict lifecycle + Telegram-notify relay      [rewrite]
      questions.js             numbered-reply ask lifecycle                   [rewrite]
      media-fetch.js           NEW — post-gate lazy download + transcribe
    process/                   [verbatim*] the interactive-session engine
      process.js  process-manager.js  factory.js
      cli-process.js           ~90% verbatim; string msg-ids, prompt block
      channels-bridge.mjs  channels-bridge-server.js  channels-bridge-protocol.js
      hook-settings.js  hook-event-tail.js  polygram-hook-append.js  [→ water-hook-append.js]
    tmux/                      tmux-runner startup-gate orphan-sweep log-tail  [verbatim]
    delivery/                  NEW/rewrite — the send half
      dispatch-tool.js         reply/react/edit_message tool → transport
      format.js                markdown → WhatsApp markdown
      chunk.js                 [verbatim] chunker
      streamer.js              [verbatim, canEdit=false]
      display-hint.js          WhatsApp rendering hint for the system prompt
    ops/
      escalate.js              polygram-IPC → Telegram notify
      sla-watchdog.js          NEW — holding-reply + escalation tick
      transport-watchdog.js    NEW — status poll + connection events + revive
      heartbeat.js             NEW — heartbeat.json + /healthz payload
    ipc/
      server.js  client.js     [verbatim] unix socket + secret
      ipc-handlers.js          allowlist: sendText/…/approve/deny/injectTurn  [rewrite]
    voice/transcribe.js        [verbatim] Whisper engine
    error/classify.js  net.js  [adapt] typed codes, literal-value redactor
    prompt.js                  <channel>/<untrusted-input> builder (WA meta)   [adapt]
    util/*                     small helpers
  migrations/                  001-init.sql … NNN-*.sql
  ops/
    water.service.example      systemd unit
    wuzapi-compose.example.yml docker compose
    ansible/                   role wuzapi + water (mirrors umi-vps-infra house)
  skills/history/              minimal transcript query CLI (roadmap-lite)
  tests/
    fixtures/webhook/*.json     Phase-0 captures (contract §7 list)
    *.test.js
  docs/                        SPEC.md  wuzapi-contract.md  IMPLEMENTATION.md
                               PROVENANCE.md  OPS.md (runbook, Phase 4)
```

`[verbatim]` = copy + rename identifiers only. `[verbatim*]` = copy, change env-var
prefixes / vendor path / bridge name. `[adapt]` = keep structure, swap the
Telegram-shaped surface. `[rewrite]` / `NEW` = water-authored.

## 2. Data model — migrations

One numbered SQL file per change; `db.js` applies pending files in `BEGIN IMMEDIATE`,
setting `user_version` = max migration number (derived, not a hand-bumped constant).
`001-init.sql` ships the whole v1 schema; later files only for post-v1 change.

```sql
-- 001-init.sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid      TEXT NOT NULL,
  msg_id        TEXT NOT NULL,               -- whatsmeow Info.ID (string)
  sender_jid    TEXT NOT NULL,               -- Info.Sender verbatim (pn- or lid-form)
  sender_alt_jid TEXT,                       -- Info.SenderAlt when present
  user          TEXT,                        -- pushName (UNVERIFIED display name)
  text          TEXT,
  raw_json      TEXT,                        -- webhook body, media descriptors only (-skipmedia)
  quote_msg_id  TEXT,
  quote_participant TEXT,
  direction     TEXT NOT NULL CHECK(direction IN ('in','out','system')),
  source        TEXT,                        -- 'whatsapp' | 'cron:<name>' | 'human-device' | 'bot-reply'
  account       TEXT NOT NULL,
  is_from_me    INTEGER NOT NULL DEFAULT 0,
  session_id    TEXT,
  model         TEXT, effort TEXT,
  turn_id       TEXT,
  status        TEXT DEFAULT 'received' CHECK(status IN ('pending','sent','failed','received')),
  handler_status TEXT,                       -- NULL(received)→dispatched→terminal (see I7 set)
  error         TEXT,
  ts            INTEGER NOT NULL,            -- WhatsApp event time (ms) — ordering + SLA clock
  received_at   INTEGER NOT NULL,            -- local receive time (ms)
  edited_ts     INTEGER,
  UNIQUE(chat_jid, sender_jid, msg_id)
);
CREATE INDEX idx_msg_recent      ON messages(chat_jid, ts DESC);
CREATE INDEX idx_msg_quote       ON messages(chat_jid, quote_msg_id);
CREATE INDEX idx_msg_turn        ON messages(turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX idx_msg_pending_out ON messages(status, received_at) WHERE status='pending' AND direction='out';
CREATE INDEX idx_msg_handler     ON messages(chat_jid, handler_status)
                                   WHERE handler_status IS NULL OR handler_status IN ('dispatched','replay-pending');

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, user, content=messages, content_rowid=id,
  tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid,text,user) VALUES(new.id,new.text,new.user); END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts,rowid,text,user) VALUES('delete',old.id,old.text,old.user);
  INSERT INTO messages_fts(rowid,text,user) VALUES(new.id,new.text,new.user); END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts,rowid,text,user) VALUES('delete',old.id,old.text,old.user); END;

CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,               -- image|audio|video|document|sticker
  file_name     TEXT, mime_type TEXT,
  size_bytes    INTEGER,                     -- mediaRef.FileLength, known pre-download
  local_path    TEXT,
  download_status TEXT DEFAULT 'pending' CHECK(download_status IN ('pending','downloaded','failed')),
  media_ref_json TEXT NOT NULL,              -- 7 fields required by /chat/download*
  transcription_json TEXT,
  error         TEXT
);
CREATE INDEX idx_att_msg ON attachments(message_id);

CREATE TABLE sessions (
  session_key   TEXT PRIMARY KEY,            -- chat JID
  chat_jid      TEXT NOT NULL,
  claude_session_id TEXT NOT NULL,
  agent TEXT, cwd TEXT, model TEXT, effort TEXT, pm_backend TEXT,
  created_ts INTEGER NOT NULL, last_active_ts INTEGER NOT NULL
);

CREATE TABLE turn_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL, msg_id TEXT, turn_id TEXT,
  duration_ms INTEGER, result_subtype TEXT, error TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,   -- NULL on cli backend
  ts INTEGER NOT NULL
);
CREATE INDEX idx_turn_complete ON turn_metrics(chat_jid, msg_id) WHERE error IS NULL;

CREATE TABLE jid_map (
  pn_jid TEXT, lid_jid TEXT, push_name TEXT,
  first_seen_ts INTEGER, last_seen_ts INTEGER,
  UNIQUE(pn_jid, lid_jid)
);
CREATE INDEX idx_jidmap_pn  ON jid_map(pn_jid);
CREATE INDEX idx_jidmap_lid ON jid_map(lid_jid);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_jid TEXT, kind TEXT NOT NULL, detail_json TEXT
);
CREATE INDEX idx_events_recent ON events(ts DESC);
CREATE INDEX idx_events_kind   ON events(kind, ts DESC);

CREATE TABLE daemon_state ( k TEXT PRIMARY KEY, v TEXT );   -- clean_shutdown_at, heartbeat_at, webhook_path_token, …

CREATE TABLE pending_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL, tool_call_id TEXT NOT NULL, session_id TEXT,
  asker_jid TEXT, questions_json TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','answered','expired')),
  created_ts INTEGER NOT NULL, resolved_ts INTEGER
);

CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY,                       -- short id shown to the operator
  chat_jid TEXT NOT NULL, tool_name TEXT, input_digest TEXT, callback_token TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','allowed','denied','expired')),
  created_ts INTEGER NOT NULL, resolved_ts INTEGER, resolver_jid TEXT
);

CREATE TABLE chat_tool_decisions (
  chat_jid TEXT NOT NULL, tool_pattern TEXT NOT NULL, match_type TEXT,
  decision TEXT CHECK(decision IN ('allow','deny')), ts INTEGER NOT NULL,
  PRIMARY KEY(chat_jid, tool_pattern)
);

CREATE TABLE secret_redactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT, rule TEXT, sha256 TEXT, ts INTEGER NOT NULL
);

CREATE TABLE config_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT, field TEXT, old_value TEXT, new_value TEXT,
  actor_jid TEXT, source TEXT, ts INTEGER NOT NULL
);
```

Handler-status vocabulary (I7 terminal set is everything except NULL/`dispatched`/
`replay-pending`): `received`(NULL) → `dispatched` → { `replied`, `failed`,
`aborted`, `ignored`, `replay-attempted`, `replay-skipped` }; `replay-pending`
stamped at graceful shutdown.

## 3. Module contracts (signatures + behavior)

### 3.1 `transport/client.js`
```
createTransport({ baseUrl, userToken, logger }) → {
  sendText({chatJid, text, quote?, mentions?, id?}) → {msgId, ts}     // POST /chat/send/text
  sendMedia({chatJid, kind, dataB64|url, caption?, ptt?, fileName?, mimeType?, quote?, id?}) → {msgId, ts}
  editText({chatJid, msgId, text}) → {msgId}
  react({chatJid, msgId, emoji|null, participantJid?, ownMessage?}) → void
  revoke({chatJid, msgId}) → void
  setPresence(chatJid, 'composing'|'paused')
  downloadMedia(mediaRef, kind) → {mime, buffer}                       // POST /chat/download<kind>
  sessionStatus() → {connected, loggedIn, jid, webhook, events}
  connectSession() → void                                             // POST /session/connect
  setWebhook({url, events}) → void                                    // POST /webhook (assert/repair)
  groupParticipants(chatJid) → [{jid, lid?}]                          // GET /group/info
  resolveLid(pnJid) → lidJid|null                                     // GET /user/lid/{pn}
}
```
- Header `token: <userToken>` on all calls (NOT Authorization — verified gotcha).
- **Client timeout 45 s** (< the 60 s ambiguous-send sweeper). Single retry only on
  pre-connect errors (ECONNREFUSED/…); 5xx/429 classified, surfaced, never
  auto-retried.
- Request bodies use PascalCase (`Phone`, `Body`, `Image`, `FileName`, `Id`,
  `ContextInfo{StanzaID,Participant,MentionedJID}`); `Phone` carries the full JID.
- `id` always supplied by the caller (minted upstream in `db/outbound.js`).

### 3.2 `transport/webhook-receiver.js`
```
createReceiver({ port, pathToken, hmacKey, onMessage, onEdit, onReaction,
                 onRevoke, onConnectionEvent, healthPayload, db, logger }) → { close() }
```
Per POST to `/hook/<pathToken>`:
1. read body with an 8 MB sanity cap → over-cap: 413 + `webhook-anomaly` (impossible
   for legit `-skipmedia` traffic);
2. `hmac.verify(rawBody, header['x-hmac-signature'], hmacKey)` → fail: 401 +
   `webhook-auth-fail` (feeds the latched storm alarm);
3. `JSON.parse` → fail: 400;
4. `normalize()` → route by `type`; for `Message`, `recordInbound` in a txn, then
   hand the persisted envelope to `onMessage`;
5. **200 only after commit**; a commit throw → **500** (wuzapi retries — the
   write-before-ack backstop).
`GET /healthz` (no auth) → 200 + `healthPayload()` iff loop alive + heartbeat fresh.

### 3.3 `transport/normalize.js`
```
normalize(rawEvent) → { type, message?: InboundMessage, edit?, reaction?, revoke?, connection? }
```
- Flatten `event.Info` (embedded `MessageSource`), read `Chat/Sender/SenderAlt/
  IsFromMe/IsGroup/AddressingMode/ID/Timestamp/PushName`.
- Derive `sender.pn`/`sender.lid` by JID suffix (`@s.whatsapp.net` / `@lid`) across
  `Sender`+`SenderAlt`; feed `jid_map.observe(pn, lid, pushName)`.
- `text` = `conversation` ‖ `extendedTextMessage.text` ‖ media `caption`; `mentions`
  = `contextInfo.mentionedJID`; `quote` from `contextInfo.{stanzaID,participant,
  quotedMessage}`; `attachments[]` from the media proto → `{kind, mimeType, fileName,
  sizeBytes: FileLength, mediaRef:{Url,DirectPath,MediaKey,Mimetype,FileEncSHA256,
  FileSHA256,FileLength}}`. **No bytes** (`-skipmedia`).
- Golden-tested against every `tests/fixtures/webhook/*.json`.

### 3.4 `handlers/gate.js`
```
gate(env, {tier}) → { action: 'dispatch'|'ignore'|'command'|'abort'|'consume', reason?, sessionKey }
```
Ordered chain (SPEC §4.2/§7): configured-chat → abort → admin/verdict commands →
question-consume → album-sibling inheritance → `shouldHandle` (group policy + mention).
Non-dispatch outcomes call `markIgnored(row, reason)` and emit `gate-<reason>`.
Pure predicates injected (`isAdmin`, `isMentioned`, `resolveIdentity`) for testing.

### 3.5 `handlers/dispatcher.js` + core (`water.js`)
Per-session `stdinLock` across the full turn; `intentLock` for autosteer-vs-primary;
follow-ups → `pm.injectUserMessage`. Result handling mirrors polygram's
`handleMessage`: `alreadyDelivered` short-circuit, wedged-session sniff → reset,
`NO_REPLY` silence, empty-response fallback that **throws on its own send failure**.
`water.js` `main()` boot order (rewrite of polygram §1 boot sequence):
config → PID claim → DB open + migrations → `markStalePending` → transport client →
webhook receiver (bound but **paused**) → pm → handlers → **boot replay** →
un-pause receiver → watchdog timers → IPC server. Shutdown: pause receiver FIRST →
drain in-flight (≤30 s) → `recordCleanShutdown` → close.

### 3.6 `ops/sla-watchdog.js`
```
tick(now) // every 30 s
```
For each `dispatched` row with no completed turn (`turn_metrics` join) and no
delivered reply: fire once when `now - ts ≥ max(slaMinutes·60000, maxTurnHard+120000)`
AND no busy heartbeat in the last interval. Suppress the holding reply (but still
INFO-escalate) if a `human-device` out-row with `ts > inbound.ts` exists in-chat
within the window. Latch per turn_id.

### 3.7 `ops/transport-watchdog.js`
`connect-failure` event → `connectSession()` (cooldown 5 min, ≤3/h). Bare
`connected:false` → revive only after ≥3 consecutive down polls AND no recent
`disconnected`. `logged-out`/`temp-ban`/`client-outdated` → CRITICAL, no revive.
Poll compares `webhook`/`events` to config → `setWebhook` repair (split-brain guard:
never overwrite a foreign URL).

### 3.8 `ipc/ipc-handlers.js`
Allowlist `sendText|sendMedia|react|setTyping|approve|deny|injectTurn|ping`.
`injectTurn(chatJid, text, {source})` synthesizes an InboundMessage
(`source:'cron:<name>'`, `is_from_me:0`, minted msg_id) and pushes it through
`record → gate → dispatch` so scheduled work runs the agent.

## 4. Key algorithms (spelled out)

- **HMAC verify:** `hmac.sha256(rawBodyBytes, key).hex === header` via
  `timingSafeEqual`. `key` = the plaintext HMAC key configured on the wuzapi user.
- **Inbound dedup:** `INSERT OR IGNORE` on `(chat_jid, sender_jid, msg_id)`; an
  ignored insert (row existed) → drop silently (retry/offline-replay/reorder).
- **Media pull (post-gate):** on dispatch, for each `pending` attachment: if
  `size_bytes > mediaMaxMb` → `failed('oversize')`; else `downloadMedia(mediaRef)` →
  atomic write `inbox/<chat>/<msg>.<ext>` → `downloaded`; voice → transcribe inline.
  Failure → `failed` → `<attachment-failed reason>` in the prompt.
- **Boot replay:** read+clear clean-shutdown marker (any error ⇒ treat as crash);
  candidates = `received` rows (always re-gate, both intents) ∪
  `dispatched`/`replay-pending` rows within `1.2×maxTurn` not in `turn_metrics`;
  drop candidates shadowed by a newer authorized abort; crash → recover via the ONE
  tail (`replay-attempted` pre-mark); clean → skip dispatched-tier + one notice.
- **Ambiguous send:** send with 45 s timeout; on resolve CAS `pending→sent|failed`;
  the 60 s sweeper only catches lost callbacks; a late 200 CAS
  `failed('ambiguous-send')→sent` + `late-send-confirmed` + transcript note.

## 5. Provenance (`docs/PROVENANCE.md` seed)

Every ported file records its source at the top:
`// provenance: polygram@0.17.10 lib/<path> (git dcceff6) — <verbatim|adapt>: <what changed>`.
Table (excerpt; full map lives in PROVENANCE.md):

| water | polygram source | mode |
|---|---|---|
| lib/process/process-manager.js | lib/process-manager.js | verbatim |
| lib/process/cli-process.js | lib/process/cli-process.js | adapt (string ids, prompt, bridge name) |
| lib/process/channels-bridge.mjs | lib/process/channels-bridge.mjs | verbatim* (WATER_ env) |
| lib/claude-bin.js | lib/claude-bin.js | verbatim* (vendor path) |
| lib/db.js | lib/db.js | adapt (schema, version-from-max) |
| lib/handlers/gate.js | lib/handlers/gate-inbound.js | adapt (WA predicates, ignored) |
| lib/handlers/redeliver.js | lib/handlers/redeliver.js | adapt (envelope reconstruct) |
| lib/delivery/chunk.js | lib/telegram/chunk.js | verbatim |
| lib/delivery/streamer.js | lib/telegram/streamer.js | verbatim (canEdit=false) |
| lib/error/classify.js | lib/error/classify.js | adapt (messages, redactor) |
| lib/ipc/server.js | lib/ipc/server.js | verbatim |

## 6. Build task breakdown (ordered, each a testable unit)

**Phase 1a — foundations (~1 week)**
1. Repo scaffold, package.json, lint/test config, `db.js` runner + `001-init.sql`;
   test: migrate up on a temp DB, assert schema version + tables.
2. `transport/hmac.js` + byte-exact vectors (incl. a captured real delivery).
3. `transport/normalize.js` green against **all** Phase-0 fixtures (contract §7).
4. `transport/webhook-receiver.js`: HMAC/parse/commit/status-code matrix +
   `/healthz`; test with a fixture-replay harness.
5. `db/jid-map.js`, `db/outbound.js` (mint id, pending→sent/failed CAS, sweeps);
   test dedup, ambiguous-send CAS, stale sweep.
6. `transport/client.js` against a `wuzapi-mock`; assert exact request bodies.

**Phase 1b — core orchestration (~1–2 weeks)**
7. Port `process/*`, `tmux/*`, `claude-bin.js`, `process-guard.js` verbatim*; get the
   ported `process-manager` + `cli-process` unit tests green (rename fallout only).
8. `handlers/record-inbound.js` + `gate.js`: the gate matrix (SPEC §15) is the
   heaviest test surface — policy × mention × allowFrom × LID × isFromMe ×
   unknown-chat × album-sibling.
9. `water.js` `main()` boot + shutdown; `dispatcher.js`; boot-replay tests
   (received re-gate on both intents, abort-then-crash exclusion, dead-question
   notice, stale verdict).
10. `delivery/*` + `handlers/media-fetch.js`: format golden tests, chunker, edit-window
    NACK, oversize degradation.
11. `handlers/approvals.js` + `questions.js`: numbered UX, verdict commands,
    idempotent replay.
12. `ops/*` (escalate, sla-watchdog, transport-watchdog, heartbeat) + `bin/water-doctor.js`
    + `bin/water-ipc.js`; watchdog math + revive-cooldown tests.
13. `ipc/*` incl. `injectTurn`; E2E real-claude test (`E2E_REAL_CLAUDE=1`) against a
    local dev wuzapi on the Mac.

**Phase 2+ = SPEC §14** (staging soak, cutover, hardening).

Gate to start coding: SPEC §16 open decisions answered (esp. npm name, approval
surface) and the deviations (per-chat sessions, 2–3 week timeline) acknowledged.

## 7. What this doc deliberately does NOT do

Write production code, invent WuzAPI behavior beyond the verified contract, or lock
choices that SPEC §16 leaves to Ivan. It is the last artifact before the code stage
of the pipeline — reviewed alongside SPEC.md, then implemented against.

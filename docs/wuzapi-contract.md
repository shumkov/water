# WuzAPI transport contract — verified reference

Everything water assumes about WuzAPI, verified against primary source:
`asternic/wuzapi @ 7064214` (2026-07-01, MIT, 893★), whatsmeow pinned
`go.mau.fi/whatsmeow v0.0.0-20260516102357-8d3700152a69`. File:line references are
into that tree. Items marked UNVERIFIED must be confirmed with live fixtures in
Phase 0 (see SPEC §14) before the normalizer is frozen.

## 1. Auth & tokens

- Admin endpoints (`/admin/*`): header `Authorization: <WUZAPI_ADMIN_TOKEN>` (raw, no
  Bearer), constant-time compare (handlers.go:127-139).
- **User endpoints: header literally named `token`** (or `?token=`)
  (handlers.go:155-158). The repo's API.md claims Authorization — the code wins.
- User tokens are chosen by the admin at creation (`POST /admin/users`), stored
  plaintext, 409 on duplicate.

## 2. Env keys (must be persisted before pairing — Phase 0)

| Key | Loss impact |
|---|---|
| `WUZAPI_ADMIN_TOKEN` | random+logged if unset; admin lockout on restart |
| `WUZAPI_GLOBAL_ENCRYPTION_KEY` (32 bytes) | decrypt of stored per-user HMAC keys fails → webhooks delivered **unsigned** (silent, logged) (helpers.go:322-341); whatsmeow session material is NOT under this key |
| `WUZAPI_GLOBAL_HMAC_KEY` | global-webhook signatures |
| `WEBHOOK_FORMAT=json` | binary default is **form** — water requires json |

whatsmeow device/session state + wuzapi users tables live in wuzapi's DB (sqlite
`dbdata/` next to the binary, or Postgres if `DB_*` set) — the volume must persist or
the linked device is lost on container recreation (wmiau.go:243-321 auto-reconnects
`connected=1` users at boot).

## 3. Session lifecycle

- Create user: `POST /admin/users {name, token, webhook, events, hmacKey(≥32ch)}`.
- Connect: `POST /session/connect {"Subscribe":[...], "Immediate":true}` (without
  Immediate it sleeps 10s; empty Subscribe preserves existing subscriptions).
- Pair by phone code: `POST /session/pairphone {"Phone":"66..."}` →
  `{LinkingCode:"XXXX-XXXX"}`; requires prior connect.
- Status: `GET /session/status` → `{connected, loggedIn, jid, events, webhook, ...}` —
  computed from **live socket state** (handlers.go:766-767; whatsmeow's
  IsConnected/IsLoggedIn are nil-receiver-safe, but the wuzapi handler dereferences
  the client-manager entry without a nil check) → poller treats any non-200 as
  "down" regardless of cause.
- **After `ConnectFailure` retry-exhaustion** (3 linear-backoff attempts,
  wmiau.go:611-668) wuzapi persists `connected=0` and does NOT keep retrying —
  only `POST /session/connect` revives the session. A consumer needing self-healing
  must call it (with a cooldown) when it sees connect-failure or a
  `connected:false` status.
- `POST /webhook {webhookurl, events[]}` updates the webhook + subscriptions live.

## 4. Webhook contract (inbound edge)

- Envelope (json mode): the whatsmeow event struct serialized with **Go field
  names** under `event`, plus `type` (event name), `userID`, `instanceName` merged
  top-level (wmiau.go:698-699; helpers.go:302-318).
- `Message` event: `event.Info` embeds MessageSource →
  `{Chat, Sender, IsFromMe, IsGroup, AddressingMode: "pn"|"lid", SenderAlt,
  RecipientAlt, ID, Timestamp (RFC3339), PushName, Type, MediaType, Edit}`;
  `event.Message` is the `waE2E.Message` proto marshaled by protobuf-go (casing =
  proto json_names — UNVERIFIED byte-for-byte → Phase-0 fixtures).
- Media (unless `-skipmedia`): top-level `base64` (raw, no data: prefix), `mimeType`,
  `fileName` (media.go:90-98); stickers add `isSticker`, `stickerAnimated`. **On
  download failure the Message webhook still arrives without media keys**
  (media.go:48-52) — keys are optional.
- Poll votes: normal `Message` webhook + top-level `pollVote {pollCreationMsgID,
  selectedOptions, selectedHashesB64}`; plaintext resolution uses an in-memory cache
  (lost on wuzapi restart → hashes only) (wmiau.go:892-927).
- Event types (constants.go:4-73): subscribe with exact names, or `"All"`.
  Gotchas: `Receipt` is delivered as `type:"ReadReceipt"` (wmiau.go:1139);
  **`StreamReplaced` is swallowed** (returns before dowebhook, wmiau.go:838-840).
- Connection events fired (subscription-gated): Connected, Disconnected,
  ConnectFailure (incl. synthetic after retry exhaustion with error/attempts/reason),
  KeepAliveTimeout, KeepAliveRestored, LoggedOut, TemporaryBan (Code/Expire),
  ClientOutdated, StreamError (Code), PairSuccess, PairError.

### Delivery semantics

- Retries: 5 total attempts, delays 30/60/120/240s (`delay × 2^(attempt-1)`), on
  network error AND non-2xx (helpers.go:263-297, 363-386). Payload marshaled once —
  byte-stable across retries.
- **Dead letters go to RabbitMQ or NOWHERE**: `PublishToRabbit` no-ops silently when
  RabbitMQ isn't configured (rabbitmq.go:174-176). water does not deploy RabbitMQ;
  its own SQLite write-before-ack is the durability layer.
- **No ordering guarantee**: every delivery runs in its own goroutine
  (`safeGo`, wmiau.go:114-116) and retries back off independently — event N's retry
  can arrive after N+1. Order by `Info.Timestamp` within a chat; dedup on
  `(Chat, Sender, ID)`.
- Offline recovery: messages received by WhatsApp while wuzapi was down/disconnected
  replay as **normal Message events** on reconnect (whatsmeow offline queue).
  `HistorySync` events never re-emit messages as Message webhooks (DB-only,
  wmiau.go:1174-1441). `OfflineSyncPreview/Completed` are informational.
- **Own-send echo is UNVERIFIED**: wuzapi mirrors its own REST sends to RabbitMQ only
  (`publishSentMessageEvent`, handlers.go:2718); whatsmeow does not normally loop
  back same-client sends. `IsFromMe:true` Message events observed in practice come
  from OTHER linked devices (the phone, or a parallel Baileys session). water's
  design is echo-independent (sent-cache populated at mint time); Phase-0 fixtures
  settle the question empirically.
- HMAC: header `x-hmac-signature`, HMAC-SHA256 hex over the **exact raw request
  body** (json mode; post-merge marshal == wire bytes, helpers.go:325-355;
  generateHmacSignature helpers.go:613). Signature computed with the per-user key
  set via `/session/hmac/config`. If key decryption fails, delivery proceeds
  **unsigned** — water rejects unsigned posts (401) and alerts.
- Webhook client skips TLS verification and may target localhost (wmiau.go:464) —
  fine for loopback; HMAC + path token carry integrity.

## 5. Send API (outbound edge)

All sends: header `token`, JSON body, `Phone` accepts full JIDs verbatim (anything
containing `@`, wmiau.go:323-340) — groups `...@g.us` work. Response envelope:
`{"code":200,"data":{...},"success":true}`.

| Endpoint | Body (PascalCase unless noted) | data |
|---|---|---|
| `/chat/send/text` | `Phone, Body, Id?, LinkPreview?, ContextInfo?{StanzaID, Participant, MentionedJID[]}, QuotedText?/QuotedMessage?` | `{Details:"Sent", Timestamp(unix s), Id}` |
| `/chat/send/image` | `Phone, Image(data-URL or http URL), Caption?, Id?, MimeType?, ContextInfo?, QuotedMessage?` — 16 MB cap | same |
| `/chat/send/audio` | `Phone, Audio(data-URL/URL), ptt?(default **true** = voice note), mimetype?(default "audio/ogg; codecs=opus"), Seconds?, Waveform?, ContextInfo?` | same |
| `/chat/send/document` | `Phone, Document, FileName(required), Caption?, Id?, MimeType?, ContextInfo?` — 100 MB cap | same |
| `/chat/send/video` | `Phone, Video, Caption?, JPEGThumbnail?, Id?, MimeType?, ContextInfo?` — 100 MB cap | same |
| `/chat/send/edit` | `Phone, Body, Id(of message being edited), ContextInfo?` — BuildEdit; 20-min window is a whatsmeow doc constant, **unenforced**; late edits are ignored by recipients | same |
| `/chat/react` | `Phone, Body(emoji, or "remove" to clear), Id("me:"-prefix for own messages), Participant?(group sender)` | same |
| `/chat/delete` | `Phone, Id` — revoke **own** messages only (EmptyJID sender) | `{Details:"Deleted",...}` |
| `/chat/presence` | `Phone, State: "composing"\|"paused", Media: ""\|"audio"` — **one-shot**; re-send every ~5s to sustain typing | — |
| `/chat/send/poll` | `group(@g.us), header, options[≥2], Id?` — vote plaintext resolution is restart-fragile | `{Details, Id}` (no Timestamp) |
| `/chat/downloadimage` etc. | requires retained media-ref: `Url, DirectPath, MediaKey, Mimetype, FileEncSHA256, FileSHA256, FileLength` | `{Mimetype, Data:"data:...;base64,..."}` |
| `/user/lid/{pn-jid}` | — | `{jid, lid}`; **PN→LID only**, 404 if unmapped |
| `/user/presence` | `{type:"available"\|"unavailable"}` | — |

Key facts:

- **`Id` is caller-mintable** — wuzapi passes it through `SendRequestExtra{ID}` and
  returns it; if omitted, `GenerateMessageID()` mints one. water always mints its own
  (write-before-send with the real ID; own-echo dedup keys off it).
- Message IDs: `"3EB0" + hex(sha256(ts ++ sender ++ random16))[:...]` — sender-minted,
  globally unique, shared by the sender's echo and all recipients' copies
  (whatsmeow send.go:46).
- **Mentions are never auto-derived from `@` text tokens** — to ping a member both
  the literal `@<number>` in Body and `ContextInfo.MentionedJID` are required
  (handlers.go:2697-2702).
- Quotes require StanzaID + Participant together (handlers.go:6028-6048).
- Buttons (`/chat/send/buttons`) and lists (`/chat/send/list`) are implemented with
  business-node render workarounds and carry "silently dropped" scars in comments
  (handlers.go:2487-2493) — water treats them as unavailable.

## 6. LID identity

- Group senders may arrive as `...@lid` (`AddressingMode:"lid"`); `SenderAlt` carries
  the phone-number JID **when the mapping is known** (whatsmeow types/message.go:25-40)
  — may be absent on first contact. water persists every observed (pn, lid) pair in
  `jid_map` and falls back to `GET /user/lid/{pn}` (PN→LID only; no reverse endpoint).
- All identity matching (allowFrom, adminJids, bot-self mention detection) operates on
  the identity set {pn, lid}.

## 7. Fixture plan (Phase 0 — freezes the normalizer)

Capture raw webhook bodies (with signatures) for: DM text · group text · group text
with @mention of the bot · reply-to-bot quote · reply-to-human quote · image ·
voice note (PTT) · video · document · inbound sticker · edit · edited-message
re-edit · revoke · reaction · own-send echo probe (send via wuzapi REST, observe
whether a webhook arrives — settles the UNVERIFIED echo question) ·
phone-originated IsFromMe (human answers from the paired phone) · poll vote ·
Connected/Disconnected pair · ConnectFailure (kill network long enough to exhaust
retries) · offline-replay burst (stop wuzapi 5 min while messages arrive, restart).
Store under `tests/fixtures/webhook/`, assert the normalizer over all of them, and
pin the whatsmeow commit hash in the fixture manifest — a wuzapi image bump that
changes shapes must fail these tests, not production.

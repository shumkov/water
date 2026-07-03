-- water v1 schema. See docs/IMPLEMENTATION.md §2 and docs/SPEC.md §5.
-- Applied by lib/db.js inside BEGIN IMMEDIATE; user_version is set to the max
-- migration number, so adding a file never needs a hand-bumped constant.

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

-- Full transcript: inbound, outbound, system. The durable inbox.
CREATE TABLE messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid       TEXT NOT NULL,
  msg_id         TEXT NOT NULL,               -- whatsmeow Info.ID (string)
  sender_jid     TEXT NOT NULL,               -- Info.Sender verbatim (pn- or lid-form)
  sender_alt_jid TEXT,                         -- Info.SenderAlt when present
  user           TEXT,                         -- pushName (unverified display name)
  text           TEXT,
  raw_json       TEXT,                         -- webhook body, descriptors only (-skipmedia)
  quote_msg_id   TEXT,
  quote_participant TEXT,
  direction      TEXT NOT NULL CHECK(direction IN ('in','out','system')),
  source         TEXT,                         -- 'whatsapp'|'cron:<name>'|'human-device'|'bot-reply'
  account        TEXT NOT NULL,
  is_from_me     INTEGER NOT NULL DEFAULT 0,
  session_id     TEXT,
  model          TEXT,
  effort         TEXT,
  turn_id        TEXT,
  status         TEXT DEFAULT 'received' CHECK(status IN ('pending','sent','failed','received')),
  handler_status TEXT,                         -- NULL(received)->dispatched->terminal
  error          TEXT,
  ts             INTEGER NOT NULL,             -- WhatsApp event time (ms); ordering + SLA clock
  received_at    INTEGER NOT NULL,             -- local receive time (ms)
  edited_ts      INTEGER,
  UNIQUE(chat_jid, sender_jid, msg_id)
);
CREATE INDEX idx_msg_recent      ON messages(chat_jid, ts DESC);
CREATE INDEX idx_msg_quote       ON messages(chat_jid, quote_msg_id);
CREATE INDEX idx_msg_turn        ON messages(turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX idx_msg_pending_out ON messages(status, received_at) WHERE status = 'pending' AND direction = 'out';
CREATE INDEX idx_msg_replay      ON messages(chat_jid, handler_status);

-- Full-text search over transcript text + author.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, user, content=messages, content_rowid=id,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, user) VALUES (new.id, new.text, new.user);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, user) VALUES ('delete', old.id, old.text, old.user);
  INSERT INTO messages_fts(rowid, text, user) VALUES (new.id, new.text, new.user);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, user) VALUES ('delete', old.id, old.text, old.user);
END;

-- One row per media attachment; bytes are pulled post-gate (lazy download).
CREATE TABLE attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,               -- image|audio|video|document|sticker
  file_name       TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,                     -- mediaRef.FileLength, known pre-download
  local_path      TEXT,
  download_status TEXT DEFAULT 'pending' CHECK(download_status IN ('pending','downloaded','failed')),
  media_ref_json  TEXT NOT NULL,               -- 7 fields required by /chat/download*
  transcription_json TEXT,
  error           TEXT
);
CREATE INDEX idx_att_msg ON attachments(message_id);

-- session_key (chat JID) -> claude_session_id + spawn identity. Source of truth for --resume.
CREATE TABLE sessions (
  session_key       TEXT PRIMARY KEY,
  chat_jid          TEXT NOT NULL,
  claude_session_id TEXT NOT NULL,
  agent             TEXT,
  cwd               TEXT,
  model             TEXT,
  effort            TEXT,
  pm_backend        TEXT,
  created_ts        INTEGER NOT NULL,
  last_active_ts    INTEGER NOT NULL
);

-- One row per completed turn; the completion ledger replay dedups against.
CREATE TABLE turn_metrics (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid       TEXT NOT NULL,
  msg_id         TEXT,
  turn_id        TEXT,
  duration_ms    INTEGER,
  result_subtype TEXT,
  error          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_usd       REAL,                         -- NULL on cli backend (unmeasured-subscription)
  ts             INTEGER NOT NULL
);
CREATE INDEX idx_turn_complete ON turn_metrics(chat_jid, msg_id) WHERE error IS NULL;

-- WhatsApp identity: phone-number JID <-> LID mapping, learned + seeded.
CREATE TABLE jid_map (
  pn_jid        TEXT,
  lid_jid       TEXT,
  push_name     TEXT,
  first_seen_ts INTEGER,
  last_seen_ts  INTEGER,
  UNIQUE(pn_jid, lid_jid)
);
CREATE INDEX idx_jidmap_pn  ON jid_map(pn_jid);
CREATE INDEX idx_jidmap_lid ON jid_map(lid_jid);

-- Append-only typed telemetry / audit log.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  chat_jid    TEXT,
  kind        TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX idx_events_recent ON events(ts DESC);
CREATE INDEX idx_events_kind   ON events(kind, ts DESC);

-- Small key/value daemon state (clean-shutdown marker, heartbeat, webhook path token).
CREATE TABLE daemon_state ( k TEXT PRIMARY KEY, v TEXT );

-- Blocking interactive questions (ask tool), rendered as numbered replies.
CREATE TABLE pending_questions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid       TEXT NOT NULL,
  tool_call_id   TEXT NOT NULL,
  session_id     TEXT,
  asker_jid      TEXT,
  questions_json TEXT NOT NULL,
  status         TEXT DEFAULT 'open' CHECK(status IN ('open','answered','expired')),
  created_ts     INTEGER NOT NULL,
  resolved_ts    INTEGER
);

-- Tool-approval requests; verdict entered on a water-owned surface.
CREATE TABLE pending_approvals (
  id             TEXT PRIMARY KEY,
  chat_jid       TEXT NOT NULL,
  tool_name      TEXT,
  input_digest   TEXT,
  callback_token TEXT,
  status         TEXT DEFAULT 'pending' CHECK(status IN ('pending','allowed','denied','expired')),
  created_ts     INTEGER NOT NULL,
  resolved_ts    INTEGER,
  resolver_jid   TEXT
);

-- Persisted always-allow / always-deny decisions per (chat, tool).
CREATE TABLE chat_tool_decisions (
  chat_jid     TEXT NOT NULL,
  tool_pattern TEXT NOT NULL,
  match_type   TEXT,
  decision     TEXT CHECK(decision IN ('allow','deny')),
  ts           INTEGER NOT NULL,
  PRIMARY KEY (chat_jid, tool_pattern)
);

-- Audit of secret redactions (fingerprint only, never the secret).
CREATE TABLE secret_redactions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT,
  rule     TEXT,
  sha256   TEXT,
  ts       INTEGER NOT NULL
);

-- Audit of model/effort/agent config changes.
CREATE TABLE config_changes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid  TEXT,
  field     TEXT,
  old_value TEXT,
  new_value TEXT,
  actor_jid TEXT,
  source    TEXT,
  ts        INTEGER NOT NULL
);

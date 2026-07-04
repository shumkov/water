// provenance: polygram@0.17.11 lib/approvals/store.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Approvals - inline keyboard gating for destructive tool calls.
 *
 * Claude Code fires a PreToolUse hook. The hook RPCs to the polygram daemon.
 * The daemon inserts a pending row, posts [Approve]/[Deny] to the admin
 * chat, and blocks on the operator's click (or a timeout).
 *
 * Persistence: `pending_approvals` row captures the whole lifecycle so we
 * keep an audit trail even if polygram restarts. Rows never get deleted;
 * 'pending' rows at boot are swept into 'timeout'.
 */

const crypto = require('crypto');
const { canonicalizeToolInput } = require('../canonical-json');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// 16 random bytes → 22 base64url chars ≈ 128 bits of entropy. Prevents
// brute-force guessing of approval callback tokens by anyone in the admin
// chat (old 6-char value was ~36 bits, within chat-storm reach).
const TOKEN_BYTES = 16;

function digestInput(input) {
  // Canonicalise object inputs so key-order doesn't change the digest.
  // Pre-fix `JSON.stringify({a:1,b:2})` and `JSON.stringify({b:2,a:1})`
  // produced different hashes — the dedup contract assumed logical
  // equivalence but the impl was order-sensitive, so an SDK that
  // re-serialised the input between turns would dedup-miss.
  const json = typeof input === 'string'
    ? input
    : JSON.stringify(canonicalizeToolInput(input));
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time compare. Different lengths → false without timing leak
 * (timingSafeEqual itself throws on length mismatch).
 */
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Translate a Claude-Code-style permission pattern into a RegExp.
 * Supported forms:
 *   "Bash"                       - any Bash tool call
 *   "Bash(rm *)"                 - Bash whose first-argument string matches glob
 *   "mcp__shopify__order_cancel" - exact MCP tool name
 *   "mcp__*__invoice_create"     - glob on segment
 *   "WebFetch"                   - any WebFetch
 * `*` matches anything non-greedily within a segment, including spaces.
 */
function patternToRegex(pattern) {
  const trimmed = String(pattern).trim();
  const parenIdx = trimmed.indexOf('(');
  const toolPart = parenIdx === -1 ? trimmed : trimmed.slice(0, parenIdx);
  const argPart = parenIdx === -1
    ? null
    : trimmed.slice(parenIdx + 1, trimmed.lastIndexOf(')'));

  const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const globToRe = (s) => escape(s).replace(/\*/g, '.*');

  const toolRe = new RegExp(`^${globToRe(toolPart)}$`);
  const argRe = argPart == null ? null : new RegExp(`^${globToRe(argPart)}$`);
  return { toolRe, argRe, raw: trimmed };
}

/**
 * Check whether a tool call matches any of the configured patterns.
 * `toolInput` is the original params object. We match on:
 *   - Bash: first positional command (`command` param, space-split first token
 *           or whole string for arg globs that include spaces)
 *   - WebFetch: `url`
 *   - others: the JSON stringification (coarse but safe default)
 */
function matchesAnyPattern(toolName, toolInput, patterns = []) {
  const input = toolInput || {};
  for (const raw of patterns) {
    const p = patternToRegex(raw);
    if (!p.toolRe.test(toolName)) continue;
    if (!p.argRe) return { matched: true, pattern: p.raw };
    let candidate = '';
    if (toolName === 'Bash') {
      candidate = input.command || '';
    } else if (toolName === 'WebFetch') {
      candidate = input.url || '';
    } else {
      candidate = typeof input === 'string' ? input : JSON.stringify(input);
    }
    if (p.argRe.test(candidate)) return { matched: true, pattern: p.raw };
  }
  return { matched: false };
}

function createStore(rawDb, now = () => Date.now()) {
  const insertStmt = rawDb.prepare(`
    INSERT INTO pending_approvals (
      bot_name, turn_id, tool_use_id, requester_chat_id, approver_chat_id,
      tool_name, tool_input_json, tool_input_digest,
      callback_token, requested_ts, timeout_ts
    ) VALUES (
      @bot_name, @turn_id, @tool_use_id, @requester_chat_id, @approver_chat_id,
      @tool_name, @tool_input_json, @tool_input_digest,
      @callback_token, @requested_ts, @timeout_ts
    )
  `);
  // 0.9.0-cleanup commit 10: stronger dedup via tool_use_id when the
  // SDK provides one. tool_use_id is the SDK's stable per-call ID;
  // unlike the legacy (turn_id, tool_input_digest) tuple, it survives
  // JSON-key reordering between retries within a turn. Migration 010
  // added the column + partial index `idx_pending_approvals_tool_use_id`
  // which had been unused since rc.6 because no insert path populated
  // the column. issue() now does.
  const findDedupByToolUseIdStmt = rawDb.prepare(`
    SELECT * FROM pending_approvals
     WHERE bot_name = ? AND tool_use_id = ? AND status = 'pending'
     LIMIT 1
  `);
  const findDedupStmt = rawDb.prepare(`
    SELECT * FROM pending_approvals
     WHERE bot_name = ? AND turn_id IS ? AND tool_input_digest = ?
       AND status = 'pending'
     LIMIT 1
  `);
  const setApproverMsgStmt = rawDb.prepare(`
    UPDATE pending_approvals SET approver_msg_id = ? WHERE id = ?
  `);
  const resolveStmt = rawDb.prepare(`
    UPDATE pending_approvals
       SET status = @status,
           decided_ts = @decided_ts,
           decided_by_user_id = @decided_by_user_id,
           decided_by_user = @decided_by_user,
           reason = @reason
     WHERE id = @id AND status = 'pending'
  `);
  const getByIdStmt = rawDb.prepare(`SELECT * FROM pending_approvals WHERE id = ?`);
  const listTimedOutStmt = rawDb.prepare(`
    SELECT * FROM pending_approvals
     WHERE status = 'pending' AND timeout_ts < ?
  `);
  const listPendingStmt = rawDb.prepare(`
    SELECT * FROM pending_approvals
     WHERE bot_name = ? AND status = 'pending'
     ORDER BY requested_ts DESC
  `);

  return {
    issue({
      bot_name, turn_id = null, tool_use_id = null,
      requester_chat_id, approver_chat_id,
      tool_name, tool_input, timeoutMs = DEFAULT_TIMEOUT_MS,
    }) {
      if (!bot_name) throw new Error('bot_name required');
      if (!requester_chat_id) throw new Error('requester_chat_id required');
      if (!approver_chat_id) throw new Error('approver_chat_id required');
      if (!tool_name) throw new Error('tool_name required');

      const tool_input_json = typeof tool_input === 'string'
        ? tool_input
        : JSON.stringify(tool_input || {});
      const tool_input_digest = digestInput(tool_input_json);
      const requested_ts = now();
      const timeout_ts = requested_ts + timeoutMs;
      const callback_token = newToken();

      // Dedup: wrap find + insert in a single BEGIN IMMEDIATE transaction so
      // two concurrent hook calls (same turn, same input) can't both miss
      // the existing row and insert two. SQLite's UPSERT would also work if
      // we added a UNIQUE partial index in a migration; keeping this in
      // application code avoids a schema bump.
      //
      // 0.9.0: prefer dedup by SDK's stable tool_use_id when available.
      // The legacy (turn_id, tool_input_digest) tuple survives only when
      // the SDK doesn't provide a tool_use_id (cron-driven sends, IPC
      // callers from older Claude versions). Both code paths route
      // through the same INSERT below; the only thing that varies is
      // which existing row counts as a "match."
      let row, reused = false;
      const tx = rawDb.transaction(() => {
        const existing = tool_use_id
          ? findDedupByToolUseIdStmt.get(bot_name, tool_use_id)
          : findDedupStmt.get(bot_name, turn_id, tool_input_digest);
        if (existing) { row = existing; reused = true; return; }
        const res = insertStmt.run({
          bot_name,
          turn_id,
          tool_use_id,
          requester_chat_id: String(requester_chat_id),
          approver_chat_id: String(approver_chat_id),
          tool_name,
          tool_input_json,
          tool_input_digest,
          callback_token,
          requested_ts,
          timeout_ts,
        });
        row = getByIdStmt.get(res.lastInsertRowid);
      });
      tx.immediate();  // BEGIN IMMEDIATE → write lock before the SELECT
      if (reused) return { ...row, reused: true };
      return row;
    },

    setApproverMsgId(id, msg_id) {
      return setApproverMsgStmt.run(msg_id, id).changes;
    },

    resolve({ id, status, decided_by_user_id = null, decided_by_user = null, reason = null }) {
      if (!['approved', 'denied', 'timeout', 'cancelled'].includes(status)) {
        throw new Error(`bad status: ${status}`);
      }
      const res = resolveStmt.run({
        id,
        status,
        decided_ts: now(),
        decided_by_user_id,
        decided_by_user,
        reason,
      });
      return res.changes;
    },

    getById(id) { return getByIdStmt.get(id); },

    listPending(bot_name) { return listPendingStmt.all(bot_name); },

    sweepTimedOut() {
      return listTimedOutStmt.all(now());
    },
  };
}

module.exports = {
  createStore,
  digestInput,
  newToken,
  tokensEqual,
  patternToRegex,
  matchesAnyPattern,
  DEFAULT_TIMEOUT_MS,
};

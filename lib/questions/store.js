// provenance: polygram@0.17.11 lib/questions/store.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * pending_questions store — persistence for the 0.12 interactive-question flow.
 *
 * Mirrors lib/approvals/store.js: per-row 128-bit callback token, status
 * lifecycle, audit-kept rows (never deleted; 'pending' at boot → 'expired').
 * One OPEN question per session at a time. The answer routes back to claude on
 * tool_call_id (a `question_answer` bridge message).
 */

'use strict';

const { newToken, tokensEqual } = require('../approvals/store');

// A question waits for the user — the turn no longer times out while an `ask` is open
// (cli-process defers its ceilings during a question wait, docs/progress-is-not-turn-end-spec.md),
// so this is only the long SAFETY BACKSTOP: a forgotten/abandoned question eventually
// expires {timedout} instead of pinning the session forever. Generous (a full day) so a
// real user answering hours later is never cut off; tune via the `questionTimeoutMs` config
// if a chat needs shorter/longer.
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function createQuestionStore(rawDb, now = () => Date.now()) {
  const insertStmt = rawDb.prepare(`
    INSERT INTO pending_questions (
      bot_name, session_key, chat_id, thread_id, turn_id, tool_call_id,
      callback_token, questions_json, state_json, created_ts, timeout_ts
    ) VALUES (
      @bot_name, @session_key, @chat_id, @thread_id, @turn_id, @tool_call_id,
      @callback_token, @questions_json, @state_json, @created_ts, @timeout_ts
    )
  `);
  const getByIdStmt        = rawDb.prepare(`SELECT * FROM pending_questions WHERE id = ?`);
  const getOpenForSessStmt = rawDb.prepare(`
    SELECT * FROM pending_questions WHERE session_key = ? AND status = 'pending'
     ORDER BY created_ts DESC LIMIT 1`);
  const getByToolCallStmt  = rawDb.prepare(`SELECT * FROM pending_questions WHERE tool_call_id = ? LIMIT 1`);
  const setMsgIdsStmt      = rawDb.prepare(`UPDATE pending_questions SET message_ids_json = ? WHERE id = ?`);
  const updateStateStmt    = rawDb.prepare(`
    UPDATE pending_questions SET state_json = @state_json, awaiting_other = @awaiting_other
     WHERE id = @id AND status = 'pending'`);
  const claimStmt          = rawDb.prepare(`
    UPDATE pending_questions SET from_id = @from_id
     WHERE id = @id AND from_id IS NULL AND status = 'pending'`);
  const resolveStmt        = rawDb.prepare(`
    UPDATE pending_questions SET status = @status, answered_ts = @answered_ts
     WHERE id = @id AND status = 'pending'`);
  const listTimedOutStmt   = rawDb.prepare(`SELECT * FROM pending_questions WHERE status = 'pending' AND timeout_ts < ?`);
  const listOpenStmt       = rawDb.prepare(`SELECT * FROM pending_questions WHERE bot_name = ? AND status = 'pending'`);

  return {
    issue({ bot_name, session_key, chat_id, thread_id = null, turn_id = null, tool_call_id, questions, state, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      if (!bot_name || !session_key || !chat_id || !tool_call_id) {
        throw new Error('issue: bot_name, session_key, chat_id, tool_call_id required');
      }
      const created_ts = now();
      const res = insertStmt.run({
        bot_name,
        session_key,
        chat_id: String(chat_id),
        thread_id: thread_id != null ? String(thread_id) : null,
        turn_id,
        tool_call_id,
        callback_token: newToken(),
        questions_json: JSON.stringify(questions ?? []),
        state_json: JSON.stringify(state ?? {}),
        created_ts,
        timeout_ts: created_ts + timeoutMs,
      });
      return getByIdStmt.get(res.lastInsertRowid);
    },

    getById(id) { return getByIdStmt.get(id); },
    getOpenForSession(session_key) { return getOpenForSessStmt.get(session_key); },
    getByToolCallId(tool_call_id) { return getByToolCallStmt.get(tool_call_id); },
    setMessageIds(id, ids) { return setMsgIdsStmt.run(JSON.stringify(ids ?? []), id).changes; },

    updateState(id, state, awaitingOther = false) {
      return updateStateStmt.run({ id, state_json: JSON.stringify(state ?? {}), awaiting_other: awaitingOther ? 1 : 0 }).changes;
    },

    /**
     * Authorize a responder. Claim-on-first-tap: if no from_id is recorded yet,
     * the first interacting user claims the question; thereafter only that user
     * may answer. Returns { ok, claimed }.
     */
    claimOrCheck(id, from_id) {
      if (from_id == null) return { ok: false, claimed: false };
      const claimed = claimStmt.run({ id, from_id }).changes > 0;
      if (claimed) return { ok: true, claimed: true };
      const row = getByIdStmt.get(id);
      return { ok: row && Number(row.from_id) === Number(from_id), claimed: false };
    },

    resolve(id, status) {
      if (!['answered', 'cancelled', 'timeout', 'expired'].includes(status)) {
        throw new Error(`bad status: ${status}`);
      }
      return resolveStmt.run({ id, status, answered_ts: now() }).changes;
    },

    sweepTimedOut() { return listTimedOutStmt.all(now()); },
    listOpen(bot_name) { return listOpenStmt.all(bot_name); },
  };
}

module.exports = { createQuestionStore, tokensEqual, DEFAULT_TIMEOUT_MS };

// Outbound message lifecycle — write-before-send (SPEC §4.4, invariants I2/I4).
//
// Flow: mint a client-side msg_id and insert a `pending` row + populate the sent-cache
// BEFORE the REST call; on the response CAS pending->sent|failed. A 60s sweeper flips
// still-`pending` rows to failed('ambiguous-send'); a late 200 reconciles
// failed('ambiguous-send')->sent. A boot sweep flips crash-window rows to
// failed('crashed-mid-send'). No possibly-landed send is ever auto-retried.

'use strict';

const crypto = require('node:crypto');

const AMBIGUOUS = 'ambiguous-send';
const CRASHED = 'crashed-mid-send';

// whatsmeow-shaped id so our sends look native: "3EB0" + 18 uppercase hex.
function mintMsgId() {
  return '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase();
}

function createOutbound(db, { botJid = 'me', now = Date.now, sentCacheTtlMs = 24 * 3600_000 } = {}) {
  const insert = db.prepare(`
    INSERT INTO messages
      (chat_jid, msg_id, sender_jid, text, direction, source, account, is_from_me,
       turn_id, status, ts, received_at)
    VALUES
      (@chatJid, @msgId, @botJid, @text, 'out', @source, @account, 1,
       @turnId, 'pending', @ts, @ts)
  `);
  const casSent = db.prepare(
    `UPDATE messages SET status='sent', ts=@ts, error=NULL WHERE id=@id AND status='pending'`,
  );
  const casFailed = db.prepare(
    `UPDATE messages SET status='failed', error=@error WHERE id=@id AND status='pending'`,
  );
  const casReconcile = db.prepare(
    `UPDATE messages SET status='sent', ts=@ts, error=NULL
       WHERE id=@id AND status='failed' AND error=@ambiguous`,
  );
  const selStale = db.prepare(
    `SELECT id, chat_jid, msg_id FROM messages
       WHERE direction='out' AND status='pending' AND received_at < @cutoff`,
  );

  // sent-cache: our own minted ids, so an echo (isFromMe) doesn't self-trigger a turn.
  // chat -> Map(msgId -> insertedAtMs).
  const sentCache = new Map();
  function cachePut(chatJid, msgId) {
    let m = sentCache.get(chatJid);
    if (!m) sentCache.set(chatJid, (m = new Map()));
    m.set(msgId, now());
  }
  function isOwnSend(chatJid, msgId) {
    const m = sentCache.get(chatJid);
    return !!(m && m.has(msgId));
  }
  function gcCache() {
    const cutoff = now() - sentCacheTtlMs;
    for (const [chat, m] of sentCache) {
      for (const [id, ts] of m) if (ts < cutoff) m.delete(id);
      if (m.size === 0) sentCache.delete(chat);
    }
  }

  // Reserve an outbound row BEFORE the network call. Returns {rowId, msgId}.
  function reserve({ chatJid, text, account, source = 'bot-reply', turnId = null, msgId = mintMsgId() }) {
    const ts = now();
    const info = insert.run({ chatJid, msgId, botJid, text: text ?? null, source, account, turnId, ts });
    cachePut(chatJid, msgId); // echo-independent: cache at mint time, not on echo
    return { rowId: Number(info.lastInsertRowid), msgId };
  }

  // Confirm delivery. Returns 'sent' if the CAS fired, or 'reconciled' if the row had
  // already been swept to ambiguous and we corrected it (caller emits late-send-confirmed).
  function markSent(rowId, sentTs = now()) {
    if (casSent.run({ id: rowId, ts: sentTs }).changes > 0) return 'sent';
    if (casReconcile.run({ id: rowId, ts: sentTs, ambiguous: AMBIGUOUS }).changes > 0) return 'reconciled';
    return 'noop'; // already terminal for another reason
  }

  function markFailed(rowId, error) {
    return casFailed.run({ id: rowId, error: String(error).slice(0, 500) }).changes > 0;
  }

  // Sweep rows still `pending` past `ageMs` to failed('ambiguous-send'). Returns the
  // swept rows so the caller can NACK the blocked reply + emit events.
  function sweepAmbiguous(ageMs = 60_000) {
    const cutoff = now() - ageMs;
    const rows = selStale.all({ cutoff });
    for (const r of rows) casFailed.run({ id: r.id, error: AMBIGUOUS });
    gcCache();
    return rows;
  }

  // Boot sweep: any pending outbound from a prior life is crash-window; mark failed.
  // Distinct error so replay/dedup logic can tell it apart from ambiguous.
  function sweepCrashed(ageMs = 60_000) {
    const cutoff = now() - ageMs;
    const rows = selStale.all({ cutoff });
    for (const r of rows) casFailed.run({ id: r.id, error: CRASHED });
    return rows;
  }

  return {
    mintMsgId, reserve, markSent, markFailed, sweepAmbiguous, sweepCrashed,
    isOwnSend, cachePut, _sentCache: sentCache,
    ERRORS: { AMBIGUOUS, CRASHED },
  };
}

module.exports = { createOutbound, mintMsgId };

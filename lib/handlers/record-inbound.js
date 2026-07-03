// provenance: polygram@0.17.10 lib/handlers/record-inbound.js (git dcceff6) — adapt:
// water InboundMessage envelope instead of grammy msg; string msg_ids; dedup key is
// (chat_jid, sender_jid, msg_id). Writes the message row + its attachment rows in ONE
// transaction (a crash mid-write can't orphan a message from its media), best-effort
// (never throws), idempotent via INSERT OR IGNORE. SPEC §4.1 / invariant I1.

'use strict';

function createRecordInbound(db, { logger = console } = {}) {
  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages
      (chat_jid, msg_id, sender_jid, sender_alt_jid, user, text, raw_json,
       quote_msg_id, quote_participant, direction, source, account, is_from_me,
       ts, received_at)
    VALUES
      (@chatJid, @msgId, @senderJid, @senderAltJid, @user, @text, @rawJson,
       @quoteMsgId, @quoteParticipant, @direction, @source, @account, @isFromMe,
       @ts, @receivedAt)
  `);
  const insertAtt = db.prepare(`
    INSERT INTO attachments
      (message_id, kind, file_name, mime_type, size_bytes, download_status, media_ref_json)
    VALUES (@messageId, @kind, @fileName, @mimeType, @sizeBytes, 'pending', @mediaRefJson)
  `);
  const findId = db.prepare(
    'SELECT id FROM messages WHERE chat_jid=? AND sender_jid=? AND msg_id=?',
  );

  // Returns { rowId, deduped }. deduped=true means the message was already recorded
  // (wuzapi retry, offline-replay, or reorder) — caller drops it silently.
  const txn = db.transaction((msg, opts) => {
    const info = insertMsg.run({
      chatJid: msg.chatJid,
      msgId: msg.msgId,
      senderJid: msg.sender?.jid ?? null,
      senderAltJid: msg.sender?.altJid ?? null,
      user: msg.sender?.pushName ?? null,
      text: msg.text ?? null,
      rawJson: msg.rawJson ?? null,
      quoteMsgId: msg.quote?.msgId ?? null,
      quoteParticipant: msg.quote?.participantJid ?? null,
      direction: opts.direction ?? 'in',
      source: opts.source ?? 'whatsapp',
      account: opts.account,
      isFromMe: msg.isFromMe ? 1 : 0,
      ts: msg.tsMs ?? Date.now(),
      receivedAt: msg.receivedAtMs ?? Date.now(),
    });
    if (info.changes === 0) {
      // Duplicate: row already exists; return its id, record nothing new.
      const existing = findId.get(msg.chatJid, msg.sender?.jid ?? null, msg.msgId);
      return { rowId: existing ? existing.id : null, deduped: true };
    }
    const rowId = Number(info.lastInsertRowid);
    for (const a of msg.attachments ?? []) {
      insertAtt.run({
        messageId: rowId,
        kind: a.kind,
        fileName: a.fileName ?? null,
        mimeType: a.mimeType ?? null,
        sizeBytes: a.sizeBytes ?? null,
        mediaRefJson: JSON.stringify(a.mediaRef ?? {}),
      });
    }
    return { rowId, deduped: false };
  });

  return function recordInbound(msg, opts = {}) {
    try {
      return txn(msg, opts);
    } catch (e) {
      // Best-effort: a record failure must not crash the receiver. The webhook
      // handler turns a thrown/failed record into a 500 so wuzapi retries (I1);
      // here we surface the error for that decision.
      logger.error?.('recordInbound failed', e?.message);
      throw e;
    }
  };
}

module.exports = { createRecordInbound };

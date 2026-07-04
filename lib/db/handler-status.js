// Inbound handler_status lifecycle + turn_metrics + boot-replay candidate selection
// (SPEC §4.2, §9 invariants I3/I7). received(NULL) -> dispatched -> terminal, where
// terminal = replied|failed|aborted|ignored|replay-attempted|replay-skipped.
// Completion is defined by a turn_metrics row (never by "a reply row exists").

'use strict';

const TERMINAL = new Set(['replied', 'failed', 'aborted', 'ignored', 'replay-attempted', 'replay-skipped']);

function createHandlerStatus(db) {
  const setStatus = db.prepare('UPDATE messages SET handler_status=@status, error=@error WHERE id=@id');
  const setTurn = db.prepare('UPDATE messages SET turn_id=@turnId WHERE id=@id');
  const insertTurnMetric = db.prepare(`
    INSERT INTO turn_metrics (chat_jid, msg_id, turn_id, duration_ms, result_subtype, error,
                              input_tokens, output_tokens, cost_usd, ts)
    VALUES (@chatJid, @msgId, @turnId, @durationMs, @resultSubtype, @error,
            @inputTokens, @outputTokens, @costUsd, @ts)
  `);
  const hasCompleted = db.prepare(
    'SELECT 1 FROM turn_metrics WHERE chat_jid=? AND msg_id=? AND error IS NULL LIMIT 1',
  );
  // Replay candidates: never-gated (received) OR interrupted mid-turn (dispatched/
  // replay-pending), within the window, ordered oldest-first.
  const candidates = db.prepare(`
    SELECT * FROM messages
     WHERE direction='in' AND is_from_me=0
       AND (handler_status IS NULL OR handler_status IN ('dispatched','replay-pending'))
       AND received_at >= @cutoff
     ORDER BY ts ASC LIMIT 200
  `);
  const markInFlightForShutdown = db.prepare(
    "UPDATE messages SET handler_status='replay-pending' WHERE handler_status='dispatched'",
  );

  return {
    markDispatched: (id, turnId) => { setStatus.run({ id, status: 'dispatched', error: null }); if (turnId) setTurn.run({ id, turnId }); },
    markReplied: (id) => setStatus.run({ id, status: 'replied', error: null }),
    markFailed: (id, error) => setStatus.run({ id, status: 'failed', error: error ? String(error).slice(0, 500) : null }),
    markAborted: (id) => setStatus.run({ id, status: 'aborted', error: null }),
    markIgnored: (id, reason) => setStatus.run({ id, status: 'ignored', error: reason || null }),
    markReplayAttempted: (id) => setStatus.run({ id, status: 'replay-attempted', error: null }),
    markReplaySkipped: (id) => setStatus.run({ id, status: 'replay-skipped', error: null }),
    recordTurnMetric: (m) => insertTurnMetric.run({
      chatJid: m.chatJid, msgId: m.msgId, turnId: m.turnId ?? null,
      durationMs: m.durationMs ?? null, resultSubtype: m.resultSubtype ?? null, error: m.error ?? null,
      inputTokens: m.inputTokens ?? null, outputTokens: m.outputTokens ?? null, costUsd: m.costUsd ?? null,
      ts: m.ts ?? Date.now(),
    }),
    hasCompletedTurn: (chatJid, msgId) => !!hasCompleted.get(chatJid, msgId),
    replayCandidates: (cutoff) => candidates.all({ cutoff }),
    markInFlightForShutdown: () => markInFlightForShutdown.run().changes,
    TERMINAL,
  };
}

module.exports = { createHandlerStatus, TERMINAL };

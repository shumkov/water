// provenance: polygram@0.17.11 lib/handlers/dispatcher.js + polygram.js handleMessage
// (git 746bca6) — adapt (rewrite): water's per-turn orchestration for the cli/channels
// backend. One turn = resolve chat config -> getOrSpawn (with --resume drift healing)
// -> build prompt -> pm.send (reply delivered mid-turn by the tool-dispatcher) ->
// record turn_metrics -> mark terminal. Per-session lock serializes turns (claude
// batches concurrent user messages — SPEC §4.2). SPEC §4.2, invariants I3/I7.

'use strict';

const { createAsyncLock } = require('@shumkov/orchestra');
const { buildPrompt, attachmentNote } = require('../prompt');

function createDispatcher({
  pm, sessions, status, resolveChat, defaults = {},
  deliverFallback,           // async (msg, text) => void — delivers a no-reply-rescue answer
  errorReply = null,         // async (msg, text) => void — delivers a calm error to the chat
  classify = null,           // (err) => {userMessage, isTransient, ...}
  attachmentsFor = () => [], // (msgRow) => attachment rows
  fetchMedia = null,         // async (attRow, {maxBytes}) => void — post-gate lazy download
  mediaMaxBytes = 32 * 1024 * 1024,
  logEvent = () => {}, logger = console,
  permissionModeDefault = 'bypassPermissions',
  feedback = { begin: () => ({ end() {} }) }, // per-turn typing + reaction feedback (no-op default)
  authDisabledGate = { onFailure: () => {}, onSuccess: () => {} }, // classify()'s 'authDisabled' kind — escalation lives in lib/ops/auth-disabled-gate.js, not here
} = {}) {
  const locks = new Map(); // sessionKey -> async lock
  const lockFor = (k) => { let l = locks.get(k); if (!l) locks.set(k, (l = createAsyncLock())); return l; };

  // The sender of the turn currently holding each chat's lock. The `ask` tool's
  // 'question-asked' event carries no sender, so the questions module reads it here to
  // correlate a later reply to the asker. Safe because the lock = exactly one in-flight
  // turn per chat (docs/ASK_SPEC.md §3.5).
  const inFlightSenders = new Map();

  function spawnContextFor(chatJid) {
    const chat = resolveChat(chatJid) || {};
    return {
      chatId: chatJid,
      cwd: chat.cwd || defaults.cwd,
      agent: chat.agent || defaults.agent,
      model: chat.model || defaults.model,
      effort: chat.effort || defaults.effort,
      permissionMode: chat.permissionMode || permissionModeDefault,
      maxTurn: chat.maxTurn || defaults.maxTurn,
      maxTurnHard: chat.maxTurnHard || defaults.maxTurnHard,
    };
  }

  // Dispatch one message as a turn. `row` is the persisted messages row (for id +
  // handler_status); `msg` is the normalized envelope. Returns the turn result.
  async function dispatch(sessionKey, msg, row, { isReplay = false } = {}) {
    const release = await lockFor(sessionKey).acquire();
    const startedAt = Date.now();
    // Lock-safety (docs/FEEDBACK_SPEC.md §3): fb/ok/delivered are hoisted so the
    // `finally` can resolve feedback AND still release the lock even if feedback
    // throws — a leaked lock would freeze this chat's turns forever.
    let fb = null; let ok = false; let delivered = false;
    try {
      const spawnCtx = spawnContextFor(msg.chatJid);
      const existingSessionId = sessions.resolveForSpawn(sessionKey, spawnCtx);

      status.markDispatched(row.id);
      inFlightSenders.set(sessionKey, msg.sender?.jid);   // asker correlation for `ask` (§3.5)
      // Fire feedback at dispatch (before the ~11s cold spawn), not before pm.send.
      fb = feedback.begin(msg, { isReplay });
      await pm.getOrSpawn(sessionKey, { ...spawnCtx, existingSessionId });

      // Post-gate, pre-prompt: lazily fetch media for THIS (dispatched) turn only —
      // the pull model (SPEC §4.1). Over-cap or failed downloads surface to the agent
      // as <attachment-failed> via attachmentNote; nothing is fetched for ignored rows.
      const attRows = attachmentsFor(row) || [];
      if (fetchMedia) {
        for (const a of attRows) {
          if (a.download_status !== 'pending') continue;
          try { await fetchMedia(a, { maxBytes: mediaMaxBytes }); } catch (e) { logger.error?.('media-fetch', e?.message); }
        }
      }
      // re-read attachment rows so notes reflect the download outcome
      const notes = (attachmentsFor(row) || []).map(attachmentNote);
      const prompt = buildPrompt(msg, { replyToText: msg.quote?.text ?? null, attachmentNotes: notes });

      // A quote carries the source author's JID as its participant (WhatsApp threading
      // needs both the stanza id AND the participant). Synthetic senders (cron/inject
      // envelopes, sender.jid='water:inject') have no routable JID — omit the participant
      // so the reply goes out unquoted rather than building a quote WuzAPI would reject.
      const participantJid = msg.sender?.jid?.includes('@') ? msg.sender.jid : undefined;
      const result = await pm.send(sessionKey, prompt, {
        context: { user: msg.sender.pushName || msg.sender.jid, sourceMsgId: msg.msgId, participantJid },
      });

      // Persist the session id claude is actually running (from the proc), for --resume.
      const proc = pm.procs?.get(sessionKey);
      if (proc?.claudeSessionId) {
        sessions.persist(sessionKey, {
          chatJid: msg.chatJid, claudeSessionId: proc.claudeSessionId,
          agent: spawnCtx.agent, cwd: spawnCtx.cwd, model: spawnCtx.model, effort: spawnCtx.effort,
        });
      }

      status.recordTurnMetric({
        chatJid: msg.chatJid, msgId: msg.msgId, turnId: result?.turnId,
        durationMs: Date.now() - startedAt, resultSubtype: result?.metrics?.resultSubtype,
        error: null,
      });

      // Channels model: the reply tool delivers mid-turn (result.alreadyDelivered).
      // Otherwise deliver the produced answer as a no-reply rescue, if any.
      if (result?.alreadyDelivered) {
        status.markReplied(row.id); ok = true; delivered = true;
      } else if (typeof result?.text === 'string' && result.text.trim() && deliverFallback) {
        await deliverFallback(msg, result.text);
        status.markReplied(row.id); ok = true; delivered = true;
      } else {
        status.markReplied(row.id); ok = true; // intentional silence (NO_REPLY / tool-only) — no text delivered
      }
      logEvent('turn-complete', { sessionKey, msgId: msg.msgId, isReplay });
      // any successful turn proves a prior AUTH_DISABLED outage ended — best-effort, must not
      // turn a genuinely successful turn into a rejected one if the gate itself has a bug.
      try { authDisabledGate.onSuccess(); } catch (e) { logger.error?.('authDisabledGate.onSuccess', e?.message); }
      return result;
    } catch (err) {
      const info = classify ? classify(err) : { userMessage: null, isTransient: false };
      status.recordTurnMetric({ chatJid: msg.chatJid, msgId: msg.msgId, durationMs: Date.now() - startedAt, error: err.message || String(err) });
      status.markFailed(row.id, err.message || String(err));
      logEvent('turn-error', { sessionKey, msgId: msg.msgId, error: err.message, kind: info?.kind });
      if (info?.kind === 'authDisabled') {
        try { authDisabledGate.onFailure({ sessionKey, msgId: msg.msgId }); }
        catch (e) { logger.error?.('authDisabledGate.onFailure', e?.message); }
      }
      // Don't apologize on replay (avoids noise) or when the classifier suppresses it.
      if (!isReplay && info?.userMessage && errorReply) {
        try { await errorReply(msg, info.userMessage); } catch { /* best effort */ }
      }
      throw err;
    } finally {
      // Resolve feedback (best-effort, must not throw), THEN always release the lock.
      inFlightSenders.delete(sessionKey);
      try { fb?.end({ ok, delivered }); } catch (e) { logger.error?.('feedback.end', e?.message); }
      release();
    }
  }

  return { dispatch, spawnContextFor, inFlightSender: (sk) => inFlightSenders.get(sk) };
}

module.exports = { createDispatcher };

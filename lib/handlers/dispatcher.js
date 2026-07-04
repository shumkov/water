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
} = {}) {
  const locks = new Map(); // sessionKey -> async lock
  const lockFor = (k) => { let l = locks.get(k); if (!l) locks.set(k, (l = createAsyncLock())); return l; };

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
    try {
      const spawnCtx = spawnContextFor(msg.chatJid);
      const existingSessionId = sessions.resolveForSpawn(sessionKey, spawnCtx);

      status.markDispatched(row.id);
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

      const result = await pm.send(sessionKey, prompt, {
        context: { user: msg.sender.pushName || msg.sender.jid, sourceMsgId: msg.msgId },
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
        status.markReplied(row.id);
      } else if (typeof result?.text === 'string' && result.text.trim() && deliverFallback) {
        await deliverFallback(msg, result.text);
        status.markReplied(row.id);
      } else {
        status.markReplied(row.id); // intentional silence (NO_REPLY / tool-only)
      }
      logEvent('turn-complete', { sessionKey, msgId: msg.msgId, isReplay });
      return result;
    } catch (err) {
      const info = classify ? classify(err) : { userMessage: null, isTransient: false };
      status.recordTurnMetric({ chatJid: msg.chatJid, msgId: msg.msgId, durationMs: Date.now() - startedAt, error: err.message || String(err) });
      status.markFailed(row.id, err.message || String(err));
      logEvent('turn-error', { sessionKey, msgId: msg.msgId, error: err.message, kind: info?.kind });
      // Don't apologize on replay (avoids noise) or when the classifier suppresses it.
      if (!isReplay && info?.userMessage && errorReply) {
        try { await errorReply(msg, info.userMessage); } catch { /* best effort */ }
      }
      throw err;
    } finally {
      release();
    }
  }

  return { dispatch, spawnContextFor };
}

module.exports = { createDispatcher };

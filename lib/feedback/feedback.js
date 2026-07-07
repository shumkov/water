'use strict';

// Per-turn responsiveness feedback for water: a "typing…" indicator (WuzAPI
// composing presence), an acknowledgement reaction, and the full progress
// cascade (thinking / tool / subagent faces) driven by orchestra's
// ProcessManager callbacks. See docs/FEEDBACK_SPEC.md.
//
// BEST-EFFORT (G3): nothing here ever throws into the dispatcher. A WuzAPI /
// presence / react failure is swallowed — feedback must never delay, block, or
// fail a turn. begin()/end() are called by the dispatcher (lock-serialized, one
// live turn per chat); onEvent() is called by the PM callbacks during the turn.

const { createReactionManager, classifyToolName } = require('./reactions');

// WuzAPI/whatsmeow presence auto-expires in ~seconds (docs/wuzapi-contract.md),
// so "typing…" must be refreshed for the whole turn — a protocol constant, not config.
const REFRESH_MS = 5000;
// Cap the typing loop well below maxTurnHard (90 min): a "typing…" that persists
// for tens of minutes reads as wedged, worse than none.
const MAX_TYPING_MS = 180_000;

function isSynthetic(msg) {
  const id = msg?.msgId;
  if (typeof id === 'string' && id.startsWith('inj-')) return true;   // cron injectTurn
  if (msg?.sender?.jid === 'water:inject') return true;
  return false;
}

// deps: { transport, settings, logger }
//   settings = { typing: { enabled }, ackReaction: { dm, group } }  (resolved account feedback)
function createFeedback({ transport, settings = {}, logger = console } = {}) {
  const typingCfg = settings.typing || {};
  const ackCfg = settings.ackReaction || {};
  const turns = new Map(); // sessionKey -> turnState

  // 'mentions' ≈ 'always' here: the gate only dispatches messages the bot handles,
  // which in requireMention chats are the addressed ones (spec §4.2). 'never' → no ack.
  const ackFires = (chatType) => {
    const mode = ackCfg[chatType] || 'never';
    return mode === 'always' || mode === 'mentions';
  };

  const safePresence = (chatJid, state) => {
    try { Promise.resolve(transport.setPresence(chatJid, state)).catch(() => {}); }
    catch (e) { logger.debug?.(`[feedback] setPresence(${state}) threw: ${e?.message}`); }
  };

  function stopTyping(st) {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (st.capTimer) { clearTimeout(st.capTimer); st.capTimer = null; }
    if (st.paused) return;
    st.paused = true;
    safePresence(st.chatJid, 'paused');
  }

  function begin(msg, { isReplay = false } = {}) {
    // Skip replay + synthetic/injected turns: a stale (2h-old boot replay) or
    // no-human-waiting (cron) 👀 / "typing…" is wrong (spec §4.1).
    if (isReplay || isSynthetic(msg) || !msg?.msgId || !msg?.chatJid) return { end() {} };

    const sessionKey = msg.chatJid;
    const chatType = msg.chatType === 'dm' ? 'dm' : 'group';
    const wantReactions = ackFires(chatType); // 'never' → NO reactor: no ack, no cascade, no ✅/🤯
    const wantTyping = !!typingCfg.enabled;
    if (!wantReactions && !wantTyping) return { end() {} }; // nothing to do for this chat

    // Defensive (the dispatcher lock should prevent it): retire any stale turn.
    const prior = turns.get(sessionKey);
    if (prior) { try { stopTyping(prior); prior.reactor?.stop(); } catch { /* */ } turns.delete(sessionKey); }

    // The reactor exists ONLY when reactions are wanted. For 'never', onEvent()/end() see a
    // null reactor and no-op the reaction side — only typing (if enabled) runs.
    let reactor = null;
    if (wantReactions) {
      reactor = createReactionManager({
        availableEmojis: null, // WhatsApp accepts arbitrary emoji → use the first of each chain
        apply: (emoji) => transport.react({
          chatJid: msg.chatJid, msgId: msg.msgId, emoji: emoji ?? null, participantJid: msg.sender?.jid,
        }),
        logError: (m) => logger.debug?.(`[feedback] ${m}`),
      });
    }

    const st = { reactor, chatJid: msg.chatJid, chatType, timer: null, capTimer: null, paused: false, agentReacted: false, subagents: 0, ended: false };
    turns.set(sessionKey, st);

    if (reactor) reactor.setState('QUEUED'); // 👀 — the initial "I saw you" signal

    if (wantTyping) {
      safePresence(msg.chatJid, 'composing');
      st.timer = setInterval(() => safePresence(msg.chatJid, 'composing'), REFRESH_MS);
      st.timer.unref?.();
      st.capTimer = setTimeout(() => stopTyping(st), MAX_TYPING_MS);
      st.capTimer.unref?.();
    }

    return { end: (res) => end(sessionKey, res) };
  }

  // Progress cascade — orchestra PM callbacks route here. No-op if no live turn.
  function onEvent(sessionKey, kind, payload) {
    const st = turns.get(sessionKey);
    if (!st || st.ended || !st.reactor) return; // no reactor (ackReaction:never) → no cascade
    try {
      switch (kind) {
        case 'turn-start':
        case 'thinking':
          st.reactor.setState('THINKING');
          break;
        case 'tool-use': {
          const name = typeof payload === 'string' ? payload : (payload?.name || payload?.tool);
          st.reactor.setState(classifyToolName(name));
          break;
        }
        case 'subagent-start':
          // Count concurrent subagents: a static owner would let the FIRST subagent-done release
          // the 👾 work-hold while a second subagent is still running (re-arming 🥱/😨 mid-run).
          st.subagents += 1;
          if (st.subagents === 1) st.reactor.setWorkInFlight?.(true, 'subagent');
          st.reactor.setState('SUBAGENT');
          break;
        case 'subagent-done':
          if (st.subagents > 0) st.subagents -= 1;
          if (st.subagents === 0) { st.reactor.setWorkInFlight?.(false, 'subagent'); st.reactor.setState('THINKING'); }
          break;
        default:
          break; // 'idle' etc: end() owns the terminal resolution
      }
    } catch (e) { logger.debug?.(`[feedback] onEvent ${kind}: ${e?.message}`); }
  }

  // Called by the channels tool-dispatcher when the agent's `react` tool sets a
  // reaction on this turn's source message — so end() won't clear it (spec §4.3).
  function markAgentReacted(sessionKey) {
    const st = turns.get(sessionKey);
    if (st) st.agentReacted = true;
  }

  // MUST NEVER THROW (G3 + the dispatcher's lock-safety depends on it). Resolves per
  // decision §8.2: error → 🤯 · done-no-reply → ✅ · done-with-reply → clear (unless the
  // agent set its own reaction). Idempotent.
  function end(sessionKey, { ok = false, delivered = false } = {}) {
    const st = turns.get(sessionKey);
    if (!st || st.ended) return;
    st.ended = true;
    turns.delete(sessionKey);
    try {
      stopTyping(st);
      // No reactor (ackReaction:never) → typing only, nothing to resolve.
      if (st.reactor) {
        if (st.agentReacted) {
          // The agent set its own reaction on the source msg — leave it; resolve NOTHING
          // (neither clear, ✅, nor 🤯 may stomp the agent's deliberate reaction).
        } else if (!ok) {
          st.reactor.setState('ERROR');         // 🤯 (terminal — flushes past throttle)
        } else if (delivered) {
          st.reactor.clear();                   // success + reply delivered → a clean text answer
        } else {
          st.reactor.setState('COMPLETE');      // ✅ — handled, no text reply (durable)
        }
        st.reactor.stop();
      }
    } catch (e) { logger.debug?.(`[feedback] end: ${e?.message}`); }
  }

  return { begin, onEvent, markAgentReacted };
}

module.exports = { createFeedback, REFRESH_MS, MAX_TYPING_MS };

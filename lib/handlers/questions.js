// ask-tool lifecycle (docs/ASK_SPEC.md). DM-only.
//
// The agent's `ask` MCP call BLOCKS inside the orchestra bridge until the host resolves it
// via pm.answerQuestion; the daemon deliberately DEFERS its own turn-timeout while a
// question is open, so — for a DM — this module's sweep is the ONLY thing that frees a
// stuck turn (and its held per-chat dispatch lock). In a GROUP a question is wrong (it's
// broadcast to everyone, and only multi-participant chats can wedge), so a group ask is
// resolved IMMEDIATELY with {cancelled} — the turn ends, the lock frees, the group can
// never wedge, and the agent re-asks in a normal reply.
//
// BEST-EFFORT: nothing here throws into intake or the PM callback.

'use strict';

const DEFAULT_TIMEOUT_MS = 5 * 60_000; // a DM clarifying answer; short so an abandoned Q frees the DM fast
const GROUP_DEGRADE_REASON =
  "Questions aren't available in group chats — ask it in a normal reply and the member will answer.";

const isGroup = (chatJid) => typeof chatJid === 'string' && chatJid.endsWith('@g.us');

// Render a single question as numbered text (WhatsApp has no inline keyboards).
function renderQuestion(q) {
  const opts = (q?.options || []).map((o, i) => `${i + 1}. ${o.label}`).join('\n');
  const hints = [];
  if (q?.multiSelect) hints.push('you can pick more than one, e.g. 1,3');
  if (q?.allowOther !== false) hints.push('or type your own answer');
  const tail = hints.length ? ` (${hints.join('; ')})` : '';
  return `${q?.question || 'Please choose:'}\n\n${opts}\n\nReply with the number${tail}.`;
}
function reprompt(q) {
  const n = (q?.options || []).length;
  return `Sorry, I didn't catch that — please reply with a number 1–${n}${q?.allowOther !== false ? ', or type your own answer' : ''}.`;
}

// Parse a free-text reply against a question's options → {ok, answer:{header, selected, other?}}.
function parseAnswer(text, q) {
  const options = (q?.options || []).map((o) => o.label);
  const header = q?.header;
  const multi = !!q?.multiSelect;
  const allowOther = q?.allowOther !== false;
  const t = String(text || '').trim();
  if (!t) return { ok: false };

  // 1. exact option label (case-insensitive) — wins over number extraction so a label that
  //    itself contains a digit isn't mis-read.
  const lc = t.toLowerCase();
  const exact = options.filter((o) => o.toLowerCase() === lc);
  if (exact.length) return { ok: true, answer: { header, selected: exact } };

  // 2. numbers in range: "2", "2.", "2)", "take 2", and (multiSelect) "1,3" / "1 and 3".
  const nums = [...new Set((t.match(/\d+/g) || []).map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= options.length))];
  if (nums.length) {
    const picked = (multi ? nums : nums.slice(0, 1)).map((n) => options[n - 1]);
    return { ok: true, answer: { header, selected: picked } };
  }

  // 3. partial label (prefix / contains).
  const partial = options.filter((o) => lc.includes(o.toLowerCase()) || o.toLowerCase().startsWith(lc));
  if (partial.length) return { ok: true, answer: { header, selected: multi ? partial : partial.slice(0, 1) } };

  // 4. free-text answer.
  if (allowOther) return { ok: true, answer: { header, selected: [], other: t } };
  return { ok: false };
}

// deps: { db, pm, deliver, inFlightSender, jidMap, logEvent, logger, timeoutMs, now }
//   deliver(chatJid, text) — the reply path (send a message to the chat)
//   inFlightSender(sessionKey) — the sender of the turn currently holding the chat's lock
function createQuestions({
  db, pm, deliver = async () => {}, inFlightSender = () => null, jidMap = null,
  logEvent = () => {}, logger = console, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now,
} = {}) {
  const insert = db.prepare(`INSERT INTO pending_questions (chat_jid, tool_call_id, session_id, asker_jid, questions_json, status, created_ts)
                             VALUES (@chatJid, @toolCallId, @sessionId, @askerJid, @questionsJson, 'open', @ts)`);
  const getOpenForChat = db.prepare("SELECT * FROM pending_questions WHERE chat_jid=? AND status='open' ORDER BY id DESC LIMIT 1");
  const claimAnswered = db.prepare("UPDATE pending_questions SET status='answered', resolved_ts=@ts WHERE id=@id AND status='open'");
  const markExpired = db.prepare("UPDATE pending_questions SET status='expired', resolved_ts=@ts WHERE id=@id AND status='open'");
  const expireChatStmt = db.prepare("UPDATE pending_questions SET status='expired', resolved_ts=@ts WHERE chat_jid=@chatJid AND status='open'");
  const expireAllStmt = db.prepare("UPDATE pending_questions SET status='expired', resolved_ts=@ts WHERE status='open'");
  const openIdsForChat = db.prepare("SELECT id FROM pending_questions WHERE chat_jid=? AND status='open'");
  const openOlderThan = db.prepare('SELECT * FROM pending_questions WHERE status=? AND created_ts < ?');

  // re-prompt attempt count per open row id (in-memory — lost on restart, but the row
  // expires on restart anyway, so no leak).
  const attempts = new Map();

  const safeDeliver = (chatJid, text) => { Promise.resolve(deliver(chatJid, text)).catch((e) => logger.error?.('[questions] deliver', e?.message)); };
  const safeAnswer = (sessionKey, toolCallId, result) => {
    try {
      const ok = pm.answerQuestion(sessionKey, toolCallId, result);
      if (ok === false) logger.debug?.(`[questions] answerQuestion(${toolCallId}) -> false (proc gone / already resolved)`);
      return ok;
    } catch (e) { logger.error?.('[questions] answerQuestion', e?.message); return false; }
  };

  // orchestra 'question-asked' → (sessionKey, {chatId, toolCallId, questions, ...}).
  // Runs SYNCHRONOUSLY inside the PM callback (no await) — the one-open guard + group
  // degrade must resolve before any yield.
  function onAsked(sessionKey, payload) {
    try {
      const chatJid = payload?.chatId || sessionKey;
      const toolCallId = payload?.toolCallId;
      const questions = Array.isArray(payload?.questions) ? payload.questions : [];
      if (!toolCallId) return;

      // GROUP → never block. Resolve the ask at once; the agent re-asks in a normal reply.
      if (isGroup(chatJid)) {
        safeAnswer(sessionKey, toolCallId, { cancelled: true, reason: GROUP_DEGRADE_REASON });
        logEvent('question-group-degraded', { chatJid, toolCallId });
        return;
      }

      // DM: one open question per chat — cancel a concurrent (parallel tool_use) ask.
      if (getOpenForChat.get(chatJid)) {
        safeAnswer(sessionKey, toolCallId, { cancelled: true, reason: 'One question at a time — please answer the previous one first.' });
        logEvent('question-concurrent-cancelled', { chatJid, toolCallId });
        return;
      }

      const q = questions[0];
      if (!q) { safeAnswer(sessionKey, toolCallId, { cancelled: true, reason: 'no question provided' }); return; }
      if (questions.length > 1) logEvent('question-multi-truncated', { chatJid, toolCallId, count: questions.length });

      // session_id MUST equal the pm sessionKey so answerQuestion's procs.get(sessionKey) hits.
      const askerJid = inFlightSender(sessionKey) || null;
      insert.run({ chatJid, toolCallId, sessionId: sessionKey, askerJid, questionsJson: JSON.stringify(questions), ts: now() });
      logEvent('question-asked', { chatJid, toolCallId, asker: askerJid });
      safeDeliver(chatJid, renderQuestion(q));
    } catch (e) { logger.error?.('[questions] onAsked', e?.message); }
  }

  // gate dep: is there an open question in this chat owned by this sender?
  function isOpenFor(chatJid, senderJid) {
    try {
      const row = getOpenForChat.get(chatJid);
      if (!row) return false;
      if (!row.asker_jid) return true; // no recorded asker → any reply in this (DM) chat
      if (jidMap?.matchesAny) return jidMap.matchesAny(senderJid, [row.asker_jid]);
      return String(senderJid) === String(row.asker_jid);
    } catch { return false; }
  }

  // processInbound 'consume' → parse the reply + resolve the ask. MUST run OUTSIDE the
  // dispatch lock (the wedged ask-turn holds it). pm.answerQuestion is synchronous and
  // never touches the lock — do not route this through dispatcher.dispatch.
  function consume(msg) {
    try {
      const chatJid = msg?.chatJid;
      const row = getOpenForChat.get(chatJid);
      if (!row) return { ok: false };

      let questions; try { questions = JSON.parse(row.questions_json); } catch { questions = []; }
      const q = Array.isArray(questions) ? questions[0] : questions;
      const parsed = parseAnswer(msg?.text ?? '', q);

      if (parsed.ok) {
        // guarded claim (TOCTOU): the winner answers; a concurrent loser falls through.
        if (claimAnswered.run({ id: row.id, ts: now() }).changes === 0) return { ok: false };
        attempts.delete(row.id);
        safeAnswer(row.session_id, row.tool_call_id, { answers: [parsed.answer] });
        logEvent('question-answered', { chatJid, toolCallId: row.tool_call_id });
        return { ok: true };
      }

      // unparseable: re-prompt once (row stays open), give up on the second failure.
      const n = (attempts.get(row.id) || 0) + 1;
      if (n >= 2) {
        if (markExpired.run({ id: row.id, ts: now() }).changes === 0) return { ok: false }; // answered concurrently
        attempts.delete(row.id);
        safeAnswer(row.session_id, row.tool_call_id, { cancelled: true, reason: "Didn't catch an answer — cancelling for now." });
        logEvent('question-reprompt-cancelled', { chatJid, toolCallId: row.tool_call_id });
        return { ok: true };
      }
      attempts.set(row.id, n);
      safeDeliver(chatJid, reprompt(q));
      return { ok: false };
    } catch (e) { logger.error?.('[questions] consume', e?.message); return { ok: false }; }
  }

  // abort (/stop): expire the chat's open question so the user's next message isn't
  // mis-routed to consume as a stale answer.
  function expireChat(chatJid) {
    try {
      for (const r of openIdsForChat.all(chatJid)) attempts.delete(r.id);
      expireChatStmt.run({ chatJid, ts: now() });
    } catch (e) { logger.error?.('[questions] expireChat', e?.message); }
  }

  // periodic sweep — the SOLE anti-wedge for the DM path.
  function sweep() {
    try {
      for (const row of openOlderThan.all('open', now() - timeoutMs)) {
        if (markExpired.run({ id: row.id, ts: now() }).changes === 0) continue; // answered concurrently
        attempts.delete(row.id);
        safeAnswer(row.session_id, row.tool_call_id, { timedout: true });
        logEvent('question-timedout', { chatJid: row.chat_jid, toolCallId: row.tool_call_id });
      }
    } catch (e) { logger.error?.('[questions] sweep', e?.message); }
  }

  // boot: the old process (and its bridge promises) died — expire every open row WITHOUT
  // answering (nothing to resolve); this only stops a stale row from swallowing a message.
  function expireOrphansAtBoot() {
    try { const r = expireAllStmt.run({ ts: now() }); if (r.changes) logEvent('question-orphans-expired', { count: r.changes }); }
    catch (e) { logger.error?.('[questions] expireOrphansAtBoot', e?.message); }
  }

  return { onAsked, isOpenFor, consume, expireChat, sweep, expireOrphansAtBoot };
}

module.exports = { createQuestions, parseAnswer, renderQuestion, isGroup };

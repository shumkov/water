// provenance: polygram@0.17.11 lib/process/channels-tool-dispatcher.js (git 746bca6)
// — adapt: attachment-path validation + ownership-gate machinery kept verbatim; the
// DELIVERY half is rewritten to send over water's WuzAPI transport + write-before-send
// outbound lifecycle instead of the Telegram pipeline. This is the seam CliProcess
// injects as `toolDispatcher`. Contract: async (call) => {ok, error?, message_id?}
// where call = {sessionKey, chatId, toolName, text, files, sourceMsgId, messageId,
// participantJid, maxOutboundFileBytes}.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_FILES_PER_REPLY = 10;
const OWNED_MSG_CAP = 256;
// Per-session staging dir for agent file sends. Kept out of the shared base so one
// session can't reference another's staged files.
const { DEFAULT_ATTACHMENT_BASE } = require('@shumkov/orchestra').attachmentBase;

// --- attachment path validation (verbatim from polygram, transport-agnostic) ---

function isPathUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validateAttachmentPath(filePath, allowedRoots) {
  if (typeof filePath !== 'string' || filePath.length === 0) return { ok: false, error: 'empty path' };
  let real;
  try { real = fs.realpathSync(filePath); } catch (e) { return { ok: false, error: `not found: ${e.code || e.message}` }; }
  const allowed = allowedRoots.some((root) => {
    try { return isPathUnder(real, fs.realpathSync(root)); } catch { return false; }
  });
  if (!allowed) return { ok: false, error: 'path outside the allowed staging/cwd roots' };
  return { ok: true, real };
}

function buildAllowedRoots({ sessionKey, sessionCwd = null, extraRoots = [], base = DEFAULT_ATTACHMENT_BASE }) {
  const roots = [path.join(base, String(sessionKey).replace(/[^\w.-]/g, '_'))];
  if (sessionCwd) roots.push(sessionCwd);
  for (const r of extraRoots) if (r) roots.push(r);
  return roots;
}

// deps injected by water.js:
//   transport   — the WuzAPI client (sendText, sendMedia, editText, react)
//   outbound    — write-before-send lifecycle (reserve, markSent, markFailed)
//   account     — account name for the outbound row
//   chunkText   — chunkMarkdownText(text, budget) -> string[]
//   formatText  — markdown -> WhatsApp downgrade
//   maxChunkLen — chunk budget (default 3500)
//   editWindowMs — WhatsApp edit window (default 20 min); water enforces it client-side
function createChannelsToolDispatcher({
  transport,
  outbound,
  account,
  chunkText,
  formatText = (t) => t,
  sanitizeText = (t) => t,
  maxChunkLen = 3500,
  editWindowMs = 20 * 60 * 1000,
  attachmentBase = DEFAULT_ATTACHMENT_BASE,
  logEvent = null,
  logger = console,
  now = Date.now,
} = {}) {
  if (!transport) throw new TypeError('channels-tool-dispatcher: transport required');
  if (!outbound) throw new TypeError('channels-tool-dispatcher: outbound required');
  if (typeof chunkText !== 'function') throw new TypeError('channels-tool-dispatcher: chunkText required');

  // Per-session set of message_ids THIS session created (reply/edit). edit_message may
  // only target an owned bubble — a prompt-injected edit can't tamper with a message it
  // didn't send, or another session's. Bounded (insertion-order eviction).
  const ownedMessageIds = new Map(); // sessionKey -> Map(msgId -> sentAtMs)
  const OWNED_SESSION_CAP = 128;
  function rememberOwned(sk, id, ts) {
    if (id == null || sk == null) return;
    let m = ownedMessageIds.get(sk);
    if (m) ownedMessageIds.delete(sk); else m = new Map();
    ownedMessageIds.set(sk, m); // re-insert → freshest
    while (ownedMessageIds.size > OWNED_SESSION_CAP) ownedMessageIds.delete(ownedMessageIds.keys().next().value);
    m.set(String(id), ts ?? now());
    while (m.size > OWNED_MSG_CAP) m.delete(m.keys().next().value);
  }
  const ownedAt = (sk, id) => ownedMessageIds.get(sk)?.get(String(id));

  // Send one message through the write-before-send choke point. Returns the real msgId
  // on success; throws on failure (caller records the delivery outcome).
  async function sendOne({ chatJid, text, quote, turnId }) {
    const { rowId, msgId } = outbound.reserve({ chatJid, text, account, source: 'bot-reply', turnId });
    try {
      const res = await transport.sendText({ chatJid, text, id: msgId, quote });
      // wuzapi echoes back our minted id; markSent handles the ambiguous-reconcile too.
      outbound.markSent(rowId, res?.ts);
      return res?.msgId || msgId;
    } catch (e) {
      // A timeout or connection reset is POSSIBLY-LANDED (invariant I4): mark it
      // ambiguous, not a plain failure — it may have reached WhatsApp, so the reply
      // must never be blindly re-sent. Provably-never-landed pre-connect errors and
      // explicit 4xx keep the raw message.
      const ambiguous = e?.code === 'TIMEOUT' || e?.code === 'ECONNRESET' || (e?.status >= 500);
      outbound.markFailed(rowId, ambiguous && outbound.ERRORS ? outbound.ERRORS.AMBIGUOUS : (e?.message || String(e)));
      throw e;
    }
  }

  return async function channelsToolDispatcher(call) {
    const { sessionKey, chatId, toolName, text, files, sourceMsgId, participantJid, messageId, turnId } = call;
    const chatJid = chatId;

    if (toolName === 'react') {
      if (!chatJid || !messageId) return { ok: false, error: 'react needs chat_id + message_id' };
      try {
        await transport.react({ chatJid, msgId: messageId, emoji: text || null, participantJid });
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    if (toolName === 'edit_message') {
      if (!chatJid) return { ok: false, error: 'edit_message.chat_id missing' };
      if (messageId == null) return { ok: false, error: 'edit_message.message_id missing' };
      if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'edit_message.text missing or empty' };
      const clean = sanitizeText(formatText(text));
      if (clean.length === 0) return { ok: false, error: 'edit_message.text empty after sanitize' };
      if (clean.length > maxChunkLen) return { ok: false, error: `edit text too long (${clean.length} > ${maxChunkLen}); use reply for long content` };
      // Ownership gate: only edit a bubble THIS session created.
      const sentAt = ownedAt(sessionKey, messageId);
      if (sentAt == null) return { ok: false, error: `message_id ${messageId} was not created by this session — edit_message can only target a bubble you sent` };
      // WhatsApp 20-min edit window, enforced client-side (wuzapi/whatsmeow do not — a
      // late edit "succeeds" but no recipient sees it).
      if (now() - sentAt > editWindowMs) {
        return { ok: false, error: 'too old to edit (past WhatsApp\'s ~20-min window) — send a follow-up correction instead' };
      }
      try {
        await transport.editText({ chatJid, msgId: messageId, text: clean });
        rememberOwned(sessionKey, messageId, sentAt); // keep ownership + original ts
        return { ok: true, message_id: messageId };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    if (toolName !== 'reply') return { ok: false, error: `unsupported tool: ${toolName}` };
    if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'reply.text missing or empty' };
    if (!chatJid) return { ok: false, error: 'reply.chat_id missing' };

    // Format (markdown -> WhatsApp) + sanitize (strip canned strings), then chunk.
    const body = sanitizeText(formatText(text));
    if (body.length === 0) return { ok: true, message_id: null }; // solo tag / empty after strip
    const chunks = chunkText(body, maxChunkLen);

    let firstMsgId = null;
    const sent = [];
    const failed = [];
    for (let i = 0; i < chunks.length; i++) {
      // Quote the user's message only on the first chunk (WhatsApp threading = quote).
      const quote = i === 0 && sourceMsgId ? { msgId: sourceMsgId, participantJid } : undefined;
      try {
        const id = await sendOne({ chatJid, text: chunks[i], quote, turnId });
        sent.push(id);
        rememberOwned(sessionKey, id);
        if (firstMsgId == null) firstMsgId = id;
      } catch (e) {
        failed.push(e.message);
        logger.error?.(`[tool-dispatcher] ${sessionKey} chunk ${i} send failed: ${e.message}`);
        break; // stop on first failure — partial delivery over a burst of failures
      }
    }

    // Files (after text), path-validated against the session's staging/cwd roots.
    if (Array.isArray(files) && files.length && failed.length === 0) {
      const roots = buildAllowedRoots({ sessionKey, sessionCwd: call.sessionCwd, base: attachmentBase });
      for (const f of files.slice(0, MAX_FILES_PER_REPLY)) {
        const v = validateAttachmentPath(f, roots);
        if (!v.ok) { failed.push(`file ${f}: ${v.error}`); continue; }
        try {
          const kind = /\.(jpe?g|png|gif|webp)$/i.test(v.real) ? 'image' : 'document';
          const data = `data:application/octet-stream;base64,${fs.readFileSync(v.real).toString('base64')}`;
          const { rowId, msgId } = outbound.reserve({ chatJid, text: `[file:${path.basename(v.real)}]`, account, source: 'bot-reply', turnId });
          const res = await transport.sendMedia({ chatJid, kind, data, fileName: path.basename(v.real), id: msgId });
          outbound.markSent(rowId, res?.ts);
          sent.push(res?.msgId || msgId);
        } catch (e) { failed.push(`file ${f}: ${e.message}`); }
      }
    }

    logEvent?.('channels-reply', { sessionKey, chunks: chunks.length, sent: sent.length, failed: failed.length });
    if (failed.length > 0) {
      return { ok: false, error: `delivered ${sent.length} of ${chunks.length}; failed: ${failed.join(', ')}`, message_id: firstMsgId };
    }
    return { ok: true, message_id: firstMsgId };
  };
}

module.exports = {
  createChannelsToolDispatcher,
  DEFAULT_ATTACHMENT_BASE,
  buildAllowedRoots,
  validateAttachmentPath,
  isPathUnder,
};

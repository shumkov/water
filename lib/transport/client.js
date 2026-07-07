// WuzAPI REST client — the only outbound-facing WuzAPI code (SPEC §4.1, §4.4).
//
// Contract: docs/wuzapi-contract.md §5. User endpoints authenticate with the header
// literally named `token` (NOT Authorization — verified gotcha). Bodies are
// PascalCase; `Phone` carries the full JID (…@g.us for groups). Response envelope is
// {code, data, success}. The client timeout is 45s — below the 60s ambiguous-send
// sweeper (SPEC §4.4) — so the normal path always resolves a send row before the
// sweeper looks. Only pre-connect errors are retried (once); 5xx/429 are surfaced.

'use strict';

// Errors that PROVE the request never reached the server — the only ones safe to
// auto-retry (the send provably did not land). ECONNRESET is deliberately EXCLUDED:
// a TCP reset can arrive after wuzapi already forwarded the send to WhatsApp, so
// retrying it would risk a double-send (invariant I4). A bare ECONNRESET is surfaced
// as an ambiguous send instead.
const { toMs } = require('./normalize');

const PRE_CONNECT = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
]);

class WuzapiError extends Error {
  constructor(message, { status, code, preConnect } = {}) {
    super(message);
    this.name = 'WuzapiError';
    this.status = status;
    this.code = code;
    this.preConnect = !!preConnect;
  }
}

function createTransport({ baseUrl, userToken, timeoutMs = 45_000, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const root = baseUrl.replace(/\/+$/, '');

  async function call(method, pathname, { body, headers } = {}) {
    const url = root + pathname;
    const opts = {
      method,
      headers: { token: userToken, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    let res;
    try {
      res = await fetchImpl(url, opts);
    } catch (e) {
      const code = e?.cause?.code || e?.code;
      const preConnect = PRE_CONNECT.has(code);
      // one retry, only when the request never reached the server (loopback wuzapi
      // restarting) — safe because nothing landed.
      if (preConnect) {
        try {
          res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
        } catch (e2) {
          throw new WuzapiError(`pre-connect to wuzapi failed: ${e2.message}`, { code, preConnect: true });
        }
      } else if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new WuzapiError(`wuzapi request timed out after ${timeoutMs}ms`, { code: 'TIMEOUT' });
      } else {
        // ECONNRESET and everything else: possibly-landed, never auto-retried.
        throw new WuzapiError(`wuzapi request failed: ${e.message}`, { code });
      }
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok || json.success === false) {
      throw new WuzapiError(json.error || json.message || `wuzapi ${res.status}`, { status: res.status, code: json.code });
    }
    return json.data ?? json;
  }

  // Build the ContextInfo block for a quote and/or mentions.
  function contextInfo({ quote, mentions } = {}) {
    const ci = {};
    if (quote?.msgId && quote?.participantJid) {
      ci.StanzaID = quote.msgId;
      ci.Participant = quote.participantJid;
    }
    if (mentions?.length) ci.MentionedJID = mentions;
    return Object.keys(ci).length ? ci : undefined;
  }

  return {
    async sendText({ chatJid, text, id, quote, mentions, linkPreview = false }) {
      const d = await call('POST', '/chat/send/text', {
        body: { Phone: chatJid, Body: text, Id: id, LinkPreview: linkPreview, ContextInfo: contextInfo({ quote, mentions }) },
      });
      return { msgId: d.Id, ts: toMs(d.Timestamp) };
    },

    async sendMedia({ chatJid, kind, data, url, caption, ptt, fileName, mimeType, id, quote }) {
      const paths = { image: '/chat/send/image', audio: '/chat/send/audio', video: '/chat/send/video', document: '/chat/send/document' };
      const fields = { image: 'Image', audio: 'Audio', video: 'Video', document: 'Document' };
      const path = paths[kind];
      if (!path) throw new WuzapiError(`unsupported media kind ${kind}`);
      const body = { Phone: chatJid, Caption: caption, Id: id, MimeType: mimeType, ContextInfo: contextInfo({ quote }) };
      body[fields[kind]] = data ?? url;
      if (kind === 'audio' && ptt !== undefined) body.ptt = ptt;
      if (kind === 'document') body.FileName = fileName;
      const d = await call('POST', path, { body });
      return { msgId: d.Id, ts: toMs(d.Timestamp) };
    },

    async editText({ chatJid, msgId, text }) {
      const d = await call('POST', '/chat/send/edit', { body: { Phone: chatJid, Id: msgId, Body: text } });
      return { msgId: d.Id };
    },

    async react({ chatJid, msgId, emoji, participantJid, ownMessage = false }) {
      await call('POST', '/chat/react', {
        body: { Phone: chatJid, Id: ownMessage ? `me:${msgId}` : msgId, Body: emoji == null ? 'remove' : emoji, Participant: participantJid },
      });
    },

    async revoke({ chatJid, msgId }) {
      await call('POST', '/chat/delete', { body: { Phone: chatJid, Id: msgId } });
    },

    async setPresence(chatJid, state /* 'composing' | 'paused' */) {
      await call('POST', '/chat/presence', { body: { Phone: chatJid, State: state } });
    },

    // Global (account) presence. WhatsApp only delivers chat presence ("typing…") to
    // recipients while the account is marked online/available, and that state lapses —
    // so a turn re-announces `available` alongside each `composing` refresh to stop the
    // typing indicator from flickering. Contract: /user/presence takes a lowercase
    // `{ type }` (docs/wuzapi-contract.md §5), unlike the PascalCase chat endpoints.
    async setUserPresence(state /* 'available' | 'unavailable' */) {
      await call('POST', '/user/presence', { body: { type: state } });
    },

    async downloadMedia(mediaRef, kind) {
      const paths = { image: '/chat/downloadimage', video: '/chat/downloadvideo', audio: '/chat/downloadaudio', document: '/chat/downloaddocument', sticker: '/chat/downloadsticker' };
      const path = paths[kind];
      if (!path) throw new WuzapiError(`no download endpoint for ${kind}`);
      const d = await call('POST', path, { body: mediaRef });
      // data:<mime>;base64,<b64>
      const data = d.Data || '';
      const comma = data.indexOf(',');
      const b64 = comma >= 0 ? data.slice(comma + 1) : data;
      return { mime: d.Mimetype, buffer: Buffer.from(b64, 'base64') };
    },

    async sessionStatus() {
      return call('GET', '/session/status');
    },

    async connectSession(subscribe = []) {
      return call('POST', '/session/connect', { body: { Subscribe: subscribe, Immediate: true } });
    },

    async setWebhook({ url, events }) {
      return call('POST', '/webhook', { body: { webhookurl: url, events } });
    },

    async groupParticipants(groupJid) {
      const d = await call('GET', `/group/info?groupJID=${encodeURIComponent(groupJid)}`);
      const parts = d.Participants || d.participants || [];
      return parts.map((p) => ({ jid: p.JID || p.jid, lid: p.LID || p.lid || null }));
    },

    async resolveLid(pnJid) {
      try {
        const d = await call('GET', `/user/lid/${encodeURIComponent(pnJid)}`);
        return d.lid || null;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },

    _call: call,
  };
}

module.exports = { createTransport, WuzapiError };

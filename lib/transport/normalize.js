// Raw WuzAPI webhook event -> water's normalized InboundMessage (SPEC §4.1).
//
// The webhook body (WEBHOOK_FORMAT=json) is the raw whatsmeow event struct under
// `event`, Go field names, discriminated by `type`. Under -skipmedia no bytes ride
// along — media messages carry only descriptors (mediaRef). The exact protobuf-go
// JSON casing of the `Message` sub-object is UNVERIFIED until Phase-0 fixtures freeze
// it, so field reads here are casing-defensive (`pick`); the Info fields
// (Chat/Sender/ID/Timestamp/...) are confirmed from source.

'use strict';

// First present key among case/name variants.
function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n];
    // case-insensitive fallback
    const hit = Object.keys(obj).find((k) => k.toLowerCase() === n.toLowerCase());
    if (hit && obj[hit] !== undefined && obj[hit] !== null) return obj[hit];
  }
  return undefined;
}

function suffixKind(jid) {
  if (typeof jid !== 'string') return null;
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) return 'pn';
  if (jid.endsWith('@lid')) return 'lid';
  return null;
}

function toMs(ts) {
  if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000; // s or ms
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

// Build a mediaRef (the 7 fields /chat/download* needs) from a proto media message.
function mediaRefOf(m) {
  return {
    Url: pick(m, 'url', 'URL') ?? null,
    DirectPath: pick(m, 'directPath', 'DirectPath') ?? null,
    MediaKey: pick(m, 'mediaKey', 'MediaKey') ?? null,
    Mimetype: pick(m, 'mimetype', 'mimeType', 'Mimetype') ?? null,
    FileEncSHA256: pick(m, 'fileEncSha256', 'fileEncSHA256', 'FileEncSHA256') ?? null,
    FileSHA256: pick(m, 'fileSha256', 'fileSHA256', 'FileSHA256') ?? null,
    FileLength: Number(pick(m, 'fileLength', 'FileLength') ?? 0) || 0,
  };
}

// The media sub-messages we recognize, in priority order.
const MEDIA = [
  ['image', 'imageMessage'],
  ['video', 'videoMessage'],
  ['audio', 'audioMessage'],
  ['document', 'documentMessage'],
  ['sticker', 'stickerMessage'],
];

function extractAttachments(message) {
  const out = [];
  for (const [kind, key] of MEDIA) {
    const m = pick(message, key);
    if (!m) continue;
    const ref = mediaRefOf(m);
    out.push({
      kind,
      mimeType: ref.Mimetype,
      fileName: pick(m, 'fileName', 'title') ?? null,
      sizeBytes: ref.FileLength,
      mediaRef: ref,
    });
  }
  return out;
}

// contextInfo (quote + mentions) lives on the extendedText or media sub-message.
function extractContext(message) {
  const holder =
    pick(message, 'extendedTextMessage') ||
    MEDIA.map(([, k]) => pick(message, k)).find(Boolean) ||
    message;
  const ctx = pick(holder, 'contextInfo');
  const mentions = (pick(ctx, 'mentionedJID', 'mentionedJid') || []).slice();
  let quote;
  const stanza = pick(ctx, 'stanzaID', 'stanzaId');
  if (stanza) {
    quote = {
      msgId: stanza,
      participantJid: pick(ctx, 'participant') ?? null,
      fromMe: false, // resolved later against our own sends if needed
    };
  }
  return { mentions, quote };
}

function extractText(message) {
  const conv = pick(message, 'conversation');
  if (typeof conv === 'string') return conv;
  const ext = pick(message, 'extendedTextMessage');
  if (ext) return pick(ext, 'text') ?? '';
  for (const [, key] of MEDIA) {
    const m = pick(message, key);
    if (m) return pick(m, 'caption') ?? '';
  }
  return '';
}

// Detect edit / revoke carried as a protocolMessage.
function protocolKind(message) {
  const pm = pick(message, 'protocolMessage');
  if (!pm) return null;
  const type = pick(pm, 'type');
  const targetMsgId = pick(pick(pm, 'key') || {}, 'ID', 'id');
  if (type === 'MESSAGE_EDIT' || pick(pm, 'editedMessage')) return { kind: 'edit', targetMsgId, edited: pick(pm, 'editedMessage') };
  if (type === 'REVOKE') return { kind: 'revoke', targetMsgId };
  return null;
}

const CONNECTION_KINDS = {
  Connected: 'connected', Disconnected: 'disconnected', ConnectFailure: 'connect-failure',
  KeepAliveTimeout: 'keepalive-timeout', KeepAliveRestored: 'keepalive-restored',
  LoggedOut: 'logged-out', TemporaryBan: 'temp-ban', ClientOutdated: 'client-outdated',
  StreamError: 'stream-error', PairSuccess: 'pair-success',
};

// Normalize any webhook event. Returns a tagged object; unknown types → {type,ignored:true}.
function normalize(raw) {
  const type = raw?.type;
  if (CONNECTION_KINDS[type]) {
    return { type: 'connection', kind: CONNECTION_KINDS[type], detail: raw.event ?? {} };
  }
  if (type !== 'Message') {
    return { type: type ?? 'unknown', ignored: true };
  }

  const ev = raw.event || {};
  const info = ev.Info || {};
  const message = ev.Message || {};

  const chatJid = pick(info, 'Chat');
  const senderJid = pick(info, 'Sender');
  const senderAlt = pick(info, 'SenderAlt') || null;
  const isGroup = !!pick(info, 'IsGroup') || String(chatJid).endsWith('@g.us');

  // reaction event
  const reaction = pick(message, 'reactionMessage');
  if (reaction) {
    const key = pick(reaction, 'key') || {};
    return {
      type: 'reaction', chatJid, senderJid,
      targetMsgId: pick(key, 'ID', 'id'),
      emoji: pick(reaction, 'text') || '',
      tsMs: toMs(pick(info, 'Timestamp')),
    };
  }

  const proto = protocolKind(message);
  if (proto?.kind === 'revoke') {
    return { type: 'revoke', chatJid, senderJid, targetMsgId: proto.targetMsgId };
  }

  const { mentions, quote } = extractContext(message);
  const msg = {
    chatJid,
    chatType: isGroup ? 'group' : 'dm',
    msgId: pick(info, 'ID'),
    sender: {
      jid: senderJid,
      altJid: senderAlt,
      pn: [senderJid, senderAlt].find((j) => suffixKind(j) === 'pn') ?? null,
      lid: [senderJid, senderAlt].find((j) => suffixKind(j) === 'lid') ?? null,
      pushName: pick(info, 'PushName') ?? null,
    },
    isFromMe: !!pick(info, 'IsFromMe'),
    tsMs: toMs(pick(info, 'Timestamp')),
    receivedAtMs: Date.now(),
    text: extractText(message),
    quote,
    mentions,
    attachments: extractAttachments(message),
    rawJson: JSON.stringify(raw),
  };
  if (proto?.kind === 'edit') {
    msg.edit = { targetMsgId: proto.targetMsgId };
    // edited text, if the edited payload is inlined
    if (proto.edited) msg.text = extractText(proto.edited) || msg.text;
  }
  return { type: 'message', message: msg };
}

module.exports = { normalize, pick, mediaRefOf, suffixKind, toMs };

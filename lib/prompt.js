// Build the plain-text prompt injected into the Claude session for one inbound
// WhatsApp message. The channels bridge wraps this content in a
// <channel source="water-bridge" chat_id=.. user=.. msg_id=..> tag and XML-escapes
// it (the prompt-injection boundary), so this module produces PLAIN TEXT only —
// adding our own tags here would just be escaped into literal text. Sender identity
// and ids travel as bridge meta (via the dispatcher's send context), not in the body.

'use strict';

// Truncate a quoted message so a long original doesn't dominate the prompt.
function truncateQuote(text, max = 400) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// msg: normalized InboundMessage; opts.replyToText: resolved quoted text (optional);
// opts.attachmentNotes: array of strings describing attachments/transcriptions.
function buildPrompt(msg, { replyToText = null, attachmentNotes = [] } = {}) {
  const parts = [];

  if (msg.quote?.msgId) {
    const who = msg.quote.fromMe ? 'you (the bot)' : (msg.quote.participantJid || 'someone');
    const quoted = replyToText != null ? `: "${truncateQuote(replyToText)}"` : '';
    parts.push(`[in reply to a message from ${who}${quoted}]`);
  }

  for (const note of attachmentNotes) parts.push(note);

  const body = (msg.text ?? '').trim();
  if (body) parts.push(body);
  else if (attachmentNotes.length === 0) parts.push('(empty message)');

  return parts.join('\n');
}

// Describe an attachment row for the prompt (content is delivered separately / lazily).
function attachmentNote(att) {
  if (att.transcription_json) {
    try {
      const t = JSON.parse(att.transcription_json);
      if (t?.text) return `[voice message] ${t.text}`;
    } catch { /* fall through */ }
  }
  if (att.download_status === 'failed') {
    return `[attachment ${att.kind} unavailable: ${att.error || 'download failed'}]`;
  }
  const name = att.file_name ? ` ${att.file_name}` : '';
  return att.local_path
    ? `[${att.kind}${name} at ${att.local_path}]`
    : `[${att.kind}${name}]`;
}

module.exports = { buildPrompt, attachmentNote, truncateQuote };

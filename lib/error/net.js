// provenance: polygram@0.17.11 lib/error/net.js (git 746bca6) — adapt: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Network error classification + safe-retry helpers.
 *
 * Polygram's outbound policy has been "write DB row first, then send; never
 * auto-retry" — correctly paranoid about double-sends. That leaves a gap
 * though: transient pre-connect failures (DNS flap, local network blip,
 * TCP refused) never actually hit Telegram. Retrying them once is safe
 * because the request never reached the server — no risk of delivering
 * the same message twice.
 *
 * Set names and error codes ported from OpenClaw's extensions/telegram/
 * src/network-errors.ts, which came from production experience.
 */

// Pre-connect errors: the TCP/TLS handshake never completed, so the HTTP
// request never went out. Retry is idempotent by definition.
const PRE_CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',  // nothing listening on target port
  'ENOTFOUND',     // DNS failed
  'EAI_AGAIN',     // DNS timeout / temporary failure
  'ENETUNREACH',   // no route to host (WAN drop)
  'EHOSTUNREACH',  // host unreachable (local firewall / sleep)
  'ECONNRESET',    // peer sent RST before reply — *usually* safe to retry;
                   // technically the server might have started processing
                   // before resetting. Include conservatively because the
                   // alternative is a lost message. Telegram doesn't commit
                   // a sendMessage server-side until it returns 200.
]);

// Transient errors that are recoverable but may have made it partway. DO
// NOT auto-retry these — the risk of double-delivery outweighs the gain.
// Surface them to the caller and let humans decide.
//
// 0.7.0 added the UND_ERR_* family + ECONNABORTED / ERR_NETWORK to match
// OpenClaw's set (extensions/telegram/src/network-errors.ts). Node 22+
// uses undici as its default fetch impl, so these surface in real
// production traffic — pre-0.7.0 we'd silently misclassify them as
// non-network errors.
const RECOVERABLE_ERROR_CODES = new Set([
  'ETIMEDOUT',          // TCP timeout after connect (message may have landed)
  'EPIPE',              // write after close — outcome indeterminate
  'EAGAIN',             // socket would block — reader should retry
  'ESOCKETTIMEDOUT',    // socket-level timeout (axios/legacy node)
  'ECONNABORTED',       // connection aborted by client (timeout-induced)
  'ERR_NETWORK',        // generic network error code
  'UND_ERR_CONNECT_TIMEOUT', // undici: connection timeout
  'UND_ERR_HEADERS_TIMEOUT', // undici: response headers timeout
  'UND_ERR_BODY_TIMEOUT',    // undici: response body timeout
  'UND_ERR_SOCKET',          // undici: socket error
  'UND_ERR_ABORTED',         // undici: request aborted
]);

// Error.name values emitted by undici/node for transient conditions.
// 0.7.0 added the undici-specific timeout error names; the new fetch
// impl in Node 22+ surfaces these as `err.name` rather than `err.code`
// in some shapes.
const RECOVERABLE_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'FetchError',
  'SocketError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
]);

// Message-substring matchers for transient errors. undici sometimes
// wraps a network failure in a generic "fetch failed" without setting
// .code or .name — only the message tells us it's a network error.
//
// These are matched ONLY when the error doesn't already have a code or
// name we recognise, to avoid double-counting and to keep the broad
// matcher from catching unrelated errors that happen to include the
// substring.
const RECOVERABLE_MESSAGE_SNIPPETS = [
  'fetch failed',
  'undici',
  'network error',
  'network request',
];

function extractCode(err) {
  if (!err) return null;
  return err.code
    || err.cause?.code
    || err.errno
    || null;
}

function extractName(err) {
  if (!err) return null;
  return err.name || err.cause?.name || null;
}

/**
 * Can we safely retry this error ONCE without risking double-delivery?
 * Only true for errors that definitionally occurred before the HTTP request
 * reached the server.
 */
function isSafeToRetry(err) {
  const code = extractCode(err);
  return code != null && PRE_CONNECT_ERROR_CODES.has(code);
}

function extractMessage(err) {
  if (!err) return '';
  return String(err.message || err.cause?.message || err.description || '').toLowerCase();
}

/**
 * Is this a transient network error — recoverable in the sense that the
 * connection may work next time, but NOT safe to auto-retry because the
 * message might have landed?
 */
function isTransientNetworkError(err) {
  if (!err) return false;
  const code = extractCode(err);
  if (code && (PRE_CONNECT_ERROR_CODES.has(code) || RECOVERABLE_ERROR_CODES.has(code))) {
    return true;
  }
  const name = extractName(err);
  if (name && RECOVERABLE_ERROR_NAMES.has(name)) return true;
  // 0.7.0: only fall through to message-snippet matching when the
  // error has no recognised code/name — avoids false-positive matches
  // on unrelated errors that happen to mention "network".
  const message = extractMessage(err);
  if (message && RECOVERABLE_MESSAGE_SNIPPETS.some((s) => message.includes(s))) {
    return true;
  }
  return false;
}

/**
 * Strip Telegram bot tokens from a message string before logging or
 * persisting. The fetch-CDN URL embeds `bot${TOKEN}` literally, but
 * various error stringifiers / proxy layers may leak the same token in
 * other shapes — URL-encoded in query strings, percent-encoded
 * (`bot1234%3AAAH…`), or as a bare `Authorization: Bearer …` header.
 *
 * Telegram tokens have the canonical shape `\d{8,10}:[A-Za-z0-9_-]{35}`
 * — match on that shape directly so the leading `bot` literal isn't
 * load-bearing. Three patterns:
 *   1. `bot1234567:AAH…` (canonical, used by the file CDN URL)
 *   2. `bot1234567%3AAAH…` (URL-encoded `:`)
 *   3. bare token shape anywhere in the string
 *
 * Pattern 3 is intentionally broad — false positives (some random
 * `1234567:abcdef…35chars` that isn't a token) are vanishingly rare.
 */
function redactBotToken(s) {
  if (!s) return s;
  return String(s)
    .replace(/bot\d+(?::|%3A)[A-Za-z0-9_%-]+/gi, 'bot<redacted>')
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '<redacted-token>')
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/(bot_token=)[^&\s]+/gi, '$1<redacted>');
}

module.exports = {
  PRE_CONNECT_ERROR_CODES,
  RECOVERABLE_ERROR_CODES,
  RECOVERABLE_ERROR_NAMES,
  RECOVERABLE_MESSAGE_SNIPPETS,
  isSafeToRetry,
  isTransientNetworkError,
  extractCode,
  extractName,
  extractMessage,
  redactBotToken,
};

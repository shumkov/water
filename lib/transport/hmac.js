// Verify WuzAPI webhook signatures.
//
// Contract (verified against asternic/wuzapi@7064214 helpers.go:613 + our
// docs/wuzapi-contract.md §4): in WEBHOOK_FORMAT=json mode the signature is
// HMAC-SHA256 of the EXACT raw request body bytes, hex-encoded (lowercase),
// delivered in the `x-hmac-signature` header, keyed with the plaintext HMAC secret
// configured on the wuzapi user. The post-merge JSON wuzapi marshals equals the wire
// body, so verifying over the raw body is correct — never re-serialize the parsed
// object (key ordering / whitespace would diverge).

'use strict';

const crypto = require('node:crypto');

// Compute the expected signature for a raw body buffer.
function sign(rawBody, key) {
  return crypto.createHmac('sha256', key).update(rawBody).digest('hex');
}

// Constant-time compare of the received header against the expected signature.
// Returns false (never throws) on any shape mismatch so a malformed header is a
// clean 401, not a crash.
function verify(rawBody, headerSignature, key) {
  if (!key || typeof headerSignature !== 'string' || headerSignature.length === 0) {
    return false;
  }
  const expected = sign(rawBody, key);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(headerSignature, 'utf8');
  if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths
  return crypto.timingSafeEqual(a, b);
}

module.exports = { sign, verify };

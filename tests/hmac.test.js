'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { sign, verify } = require('../lib/transport/hmac');

// Fixed vector — HMAC-SHA256 of these exact body bytes with this exact key.
// Recomputed independently below so the expectation is not a self-reference;
// the literal is pinned so a change to sign() that alters the algorithm fails here.
const KEY = 'global-hmac-key-0123456789abcdef-012345';
const BODY = '{"type":"Message","event":{"Info":{"ID":"3EB0ABC"}}}';
const EXPECTED = 'da7822d2cb592f66ffe473e94726847135667ade172c3e6f2754b89c77256e5b';

test('sign matches a pinned HMAC-SHA256 hex vector (byte-exact)', () => {
  assert.equal(sign(Buffer.from(BODY, 'utf8'), KEY), EXPECTED);
});

test('sign matches an independent crypto computation over the raw bytes', () => {
  const independent = crypto.createHmac('sha256', KEY).update(Buffer.from(BODY, 'utf8')).digest('hex');
  assert.equal(sign(Buffer.from(BODY, 'utf8'), KEY), independent);
});

test('verify accepts a correct signature', () => {
  assert.equal(verify(Buffer.from(BODY, 'utf8'), EXPECTED, KEY), true);
});

test('verify rejects a tampered body (raw-bytes, not re-serialized)', () => {
  const tampered = Buffer.from(BODY.replace('3EB0ABC', '3EB0XXX'), 'utf8');
  assert.equal(verify(tampered, EXPECTED, KEY), false);
});

test('verify rejects a wrong key', () => {
  assert.equal(verify(Buffer.from(BODY, 'utf8'), EXPECTED, 'wrong-key'), false);
});

test('verify rejects a wrong-length signature without throwing', () => {
  assert.equal(verify(Buffer.from(BODY, 'utf8'), 'deadbeef', KEY), false);
});

test('verify returns false on missing key / header (clean 401, no throw)', () => {
  assert.equal(verify(Buffer.from(BODY, 'utf8'), EXPECTED, ''), false);
  assert.equal(verify(Buffer.from(BODY, 'utf8'), undefined, KEY), false);
  assert.equal(verify(Buffer.from(BODY, 'utf8'), '', KEY), false);
});

test('whitespace-significant: re-serialized JSON with different spacing fails', () => {
  // Proves we must verify the raw body, never JSON.parse->stringify.
  const reSerialized = JSON.stringify(JSON.parse(BODY), null, 2);
  assert.notEqual(reSerialized, BODY);
  assert.equal(verify(Buffer.from(reSerialized, 'utf8'), EXPECTED, KEY), false);
});

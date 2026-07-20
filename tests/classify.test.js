'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, CODES } = require('../lib/error/classify');

test('AUTH_DISABLED: Claude Code access disabled gets a dedicated kind, not the generic fallback', () => {
  const err = Object.assign(
    new Error('You have disabled Claude subscription access. To enable (Claude Code) access, use an Anthropic API key instead.'),
    { code: 'AUTH_DISABLED' },
  );
  const r = classify(err);
  assert.notEqual(r.kind, 'unknown', 'must not fall through to the generic unknown kind');
  assert.equal(r.kind, 'authDisabled');
});

test('AUTH_DISABLED: silence to the WhatsApp partner (userMessage null), non-transient, no autoRecover', () => {
  const err = Object.assign(new Error('disabled Claude subscription access'), { code: 'AUTH_DISABLED' });
  const r = classify(err);
  assert.equal(r.userMessage, null);
  assert.equal(r.isTransient, false);
  assert.equal(r.autoRecover, null);
});

test('every CODES entry has the required shape', () => {
  for (const [code, shape] of Object.entries(CODES)) {
    assert.ok(typeof shape.kind === 'string', `CODES.${code}.kind`);
    assert.ok('userMessage' in shape, `CODES.${code}.userMessage`); // null is valid
    assert.equal(typeof shape.isTransient, 'boolean', `CODES.${code}.isTransient`);
    assert.ok('autoRecover' in shape, `CODES.${code}.autoRecover`);
  }
});

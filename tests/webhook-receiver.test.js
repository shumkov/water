'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createReceiver } = require('../lib/transport/webhook-receiver');
const { sign } = require('../lib/transport/hmac');

const KEY = 'test-hmac-key-0123456789abcdef-012345';
const TOKEN = 'pathtok';
const FX = path.join(__dirname, 'fixtures', 'webhook');
const fixtureRaw = (name) => fs.readFileSync(path.join(FX, name));

// Post a raw body (optionally signed) to a base URL; returns {status, json}.
async function post(base, pathname, rawBody, { signIt = true, sig } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (signIt) headers['x-hmac-signature'] = sig ?? sign(rawBody, KEY);
  const res = await fetch(base + pathname, { method: 'POST', headers, body: rawBody });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

let base, recv, seen;

before(async () => {
  seen = { messages: [], reactions: [], connections: [], failCommit: false };
  recv = createReceiver({
    port: 0, pathToken: TOKEN, hmacKey: KEY,
    healthPayload: () => ({ heartbeatAgeS: 1 }),
    handlers: {
      onMessage: async (m) => { if (seen.failCommit) throw new Error('disk full'); seen.messages.push(m); },
      onReaction: async (e) => seen.reactions.push(e),
      onConnectionEvent: async (e) => seen.connections.push(e),
    },
  });
  const addr = await recv.listen();
  base = `http://127.0.0.1:${addr.port}`;
});
after(async () => { await recv.close(); });

test('healthz is unauthenticated and returns payload', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.heartbeatAgeS, 1);
});

test('a valid signed Message commits and returns 200', async () => {
  const raw = fixtureRaw('group-text-mention.synthetic.json');
  const r = await post(base, `/hook/${TOKEN}`, raw);
  assert.equal(r.status, 200);
  assert.equal(seen.messages.at(-1).msgId, '3EB0AAA111');
});

test('bad HMAC → 401, no handler call', async () => {
  const raw = fixtureRaw('group-text-mention.synthetic.json');
  const before = seen.messages.length;
  const r = await post(base, `/hook/${TOKEN}`, raw, { sig: 'deadbeef' });
  assert.equal(r.status, 401);
  assert.equal(seen.messages.length, before);
});

test('missing signature → 401', async () => {
  const raw = fixtureRaw('own-echo.synthetic.json');
  const r = await post(base, `/hook/${TOKEN}`, raw, { signIt: false });
  assert.equal(r.status, 401);
});

test('unknown path token → 404', async () => {
  const raw = fixtureRaw('own-echo.synthetic.json');
  const r = await post(base, '/hook/WRONG', raw);
  assert.equal(r.status, 404);
});

test('unparseable body (valid HMAC) → 400', async () => {
  const raw = Buffer.from('{ not json');
  const r = await post(base, `/hook/${TOKEN}`, raw);
  assert.equal(r.status, 400);
});

test('commit failure → 500 (write-before-ack backstop, wuzapi will retry)', async () => {
  seen.failCommit = true;
  const raw = fixtureRaw('own-echo.synthetic.json');
  const r = await post(base, `/hook/${TOKEN}`, raw);
  assert.equal(r.status, 500);
  seen.failCommit = false;
});

test('reaction event routes to onReaction and 200s', async () => {
  const raw = fixtureRaw('reaction.synthetic.json');
  const r = await post(base, `/hook/${TOKEN}`, raw);
  assert.equal(r.status, 200);
  assert.equal(seen.reactions.at(-1).emoji, '👍');
});

test('connection event routes to onConnectionEvent', async () => {
  const raw = fixtureRaw('connection-disconnected.synthetic.json');
  const r = await post(base, `/hook/${TOKEN}`, raw);
  assert.equal(r.status, 200);
  assert.equal(seen.connections.at(-1).kind, 'disconnected');
});

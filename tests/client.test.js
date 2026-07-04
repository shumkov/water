'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTransport, WuzapiError } = require('../lib/transport/client');

// A mock fetch that records the last request and returns a scripted response.
function mockFetch(script) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = typeof script === 'function' ? script(url, opts, calls.length) : script;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.json ?? { code: 200, success: true, data: r.data ?? {} }),
    };
  };
  fn.calls = calls;
  return fn;
}

test('sendText posts PascalCase body with token header, returns {msgId, ts}', async () => {
  const fetchImpl = mockFetch({ data: { Details: 'Sent', Timestamp: 1720000000, Id: '3EB0X' } });
  const t = createTransport({ baseUrl: 'http://127.0.0.1:8099/', userToken: 'utok', fetchImpl });
  const r = await t.sendText({ chatJid: '120@g.us', text: 'hi' });
  // wuzapi Timestamp is unix SECONDS; the client normalizes to ms (matches inbound ts).
  assert.deepEqual(r, { msgId: '3EB0X', ts: 1720000000000 });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'http://127.0.0.1:8099/chat/send/text');
  assert.equal(c.headers.token, 'utok');
  assert.equal(c.body.Phone, '120@g.us');
  assert.equal(c.body.Body, 'hi');
});

test('sendText includes ContextInfo for a quote + mentions', async () => {
  const fetchImpl = mockFetch({ data: { Id: 'x' } });
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  await t.sendText({
    chatJid: 'g@g.us', text: 'yo',
    quote: { msgId: 'Q1', participantJid: 'p@s.whatsapp.net' },
    mentions: ['m@s.whatsapp.net'],
  });
  const ci = fetchImpl.calls[0].body.ContextInfo;
  assert.equal(ci.StanzaID, 'Q1');
  assert.equal(ci.Participant, 'p@s.whatsapp.net');
  assert.deepEqual(ci.MentionedJID, ['m@s.whatsapp.net']);
});

test('sendMedia document sets FileName and Document field', async () => {
  const fetchImpl = mockFetch({ data: { Id: 'd1' } });
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  await t.sendMedia({ chatJid: 'g@g.us', kind: 'document', url: 'https://x/a.pdf', fileName: 'a.pdf', mimeType: 'application/pdf' });
  const b = fetchImpl.calls[0].body;
  assert.equal(fetchImpl.calls[0].url.endsWith('/chat/send/document'), true);
  assert.equal(b.Document, 'https://x/a.pdf');
  assert.equal(b.FileName, 'a.pdf');
});

test('react remove sends Body:"remove"; own message prefixes id with me:', async () => {
  const fetchImpl = mockFetch({ data: {} });
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  await t.react({ chatJid: 'g@g.us', msgId: 'M1', emoji: null });
  assert.equal(fetchImpl.calls[0].body.Body, 'remove');
  await t.react({ chatJid: 'g@g.us', msgId: 'M2', emoji: '👍', ownMessage: true });
  assert.equal(fetchImpl.calls[1].body.Id, 'me:M2');
  assert.equal(fetchImpl.calls[1].body.Body, '👍');
});

test('downloadMedia decodes the data: URL to a Buffer', async () => {
  const b64 = Buffer.from('hello').toString('base64');
  const fetchImpl = mockFetch({ data: { Mimetype: 'image/png', Data: `data:image/png;base64,${b64}` } });
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  const { mime, buffer } = await t.downloadMedia({ Url: 'u' }, 'image');
  assert.equal(mime, 'image/png');
  assert.equal(buffer.toString(), 'hello');
});

test('resolveLid returns null on 404', async () => {
  const fetchImpl = mockFetch({ ok: false, status: 404, json: { success: false, code: 404 } });
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  assert.equal(await t.resolveLid('66@s.whatsapp.net'), null);
});

test('non-2xx throws WuzapiError with status', async () => {
  const fetchImpl = mockFetch({ ok: false, status: 500, json: { success: false, error: 'boom' } });
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  await assert.rejects(() => t.sendText({ chatJid: 'g@g.us', text: 'x' }), (e) => e instanceof WuzapiError && e.status === 500);
});

test('pre-connect error is retried once, then succeeds', async () => {
  let n = 0;
  const fetchImpl = async (url, opts) => {
    n++;
    if (n === 1) { const e = new Error('refused'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { Id: 'ok' } }) };
  };
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  const r = await t.sendText({ chatJid: 'g@g.us', text: 'x' });
  assert.equal(r.msgId, 'ok');
  assert.equal(n, 2, 'exactly one retry');
});

test('pre-connect failing twice throws preConnect WuzapiError (no infinite retry)', async () => {
  const fetchImpl = async () => { const e = new Error('refused'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  await assert.rejects(() => t.sendText({ chatJid: 'g@g.us', text: 'x' }), (e) => e instanceof WuzapiError && e.preConnect === true);
});

test('ECONNRESET is NOT retried (possibly-landed send → no double-send, I4)', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; const e = new Error('reset'); e.cause = { code: 'ECONNRESET' }; throw e; };
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  await assert.rejects(
    () => t.sendText({ chatJid: 'g@g.us', text: 'x' }),
    (e) => e instanceof WuzapiError && e.preConnect === false && e.code === 'ECONNRESET',
  );
  assert.equal(n, 1, 'ECONNRESET must be attempted exactly once, never retried');
});

test('groupParticipants maps JID/LID pairs', async () => {
  const fetchImpl = mockFetch({ data: { Participants: [{ JID: 'a@s.whatsapp.net', LID: 'a@lid' }, { JID: 'b@s.whatsapp.net' }] } });
  const t = createTransport({ baseUrl: 'http://h', userToken: 'u', fetchImpl });
  const parts = await t.groupParticipants('g@g.us');
  assert.deepEqual(parts, [{ jid: 'a@s.whatsapp.net', lid: 'a@lid' }, { jid: 'b@s.whatsapp.net', lid: null }]);
});

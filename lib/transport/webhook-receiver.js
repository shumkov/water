// WuzAPI webhook receiver — the inbound HTTP edge (SPEC §4.1, invariant I1).
//
// Loopback HTTP on `/hook/<pathToken>`. Per delivery: read body (8 MB sanity cap —
// far above any -skipmedia payload), HMAC-verify over the RAW bytes, parse, normalize,
// hand off to the router; a Message is committed (recordInbound) BEFORE the 200. A
// commit failure returns 500 so wuzapi's 5 retries redeliver — the write-before-ack
// backstop. `GET /healthz` is unauthenticated and returns liveness for netdata.
//
// Response codes (exhaustive): 200 committed/deduped/handled · 401 bad HMAC ·
// 400 unparseable · 404 unknown path · 413 over sanity cap · 500 record failure.

'use strict';

const http = require('node:http');
const { verify } = require('./hmac');
const { normalize } = require('./normalize');

const BODY_CAP = 8 * 1024 * 1024;

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        req.destroy();
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// deps: { pathToken, hmacKey, account, handlers, healthPayload, logger }
// handlers: { onMessage(msg)->{committed}, onEdit, onReaction, onRevoke, onConnectionEvent }
// onMessage MUST throw if it cannot durably commit (drives the 500).
function createReceiver({ port, host = '127.0.0.1', pathToken, hmacKey, handlers, healthPayload = () => ({}), logger = console, emit = () => {} }) {
  const hookPath = `/hook/${pathToken}`;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        return json(res, 200, { ok: true, ...healthPayload() });
      }
      if (req.method !== 'POST' || req.url !== hookPath) {
        return json(res, 404, { error: 'not found' });
      }

      let raw;
      try {
        raw = await readBody(req, BODY_CAP);
      } catch (e) {
        if (e.code === 'TOO_LARGE') { emit('webhook-anomaly', { reason: 'oversize-body' }); return json(res, 413, { error: 'too large' }); }
        return json(res, 400, { error: 'read error' });
      }

      if (!verify(raw, req.headers['x-hmac-signature'], hmacKey)) {
        emit('webhook-auth-fail', {});
        return json(res, 401, { error: 'bad signature' });
      }

      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'bad json' }); }

      const ev = normalize(parsed);
      try {
        await route(ev, handlers);
      } catch (e) {
        // Durable-commit failure → 500 → wuzapi retries (write-before-ack backstop).
        logger.error?.('webhook handling failed', e?.message);
        emit('webhook-handle-error', { message: e?.message });
        return json(res, 500, { error: 'not committed' });
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      logger.error?.('receiver crash guard', e?.message);
      return json(res, 500, { error: 'internal' });
    }
  });

  async function route(ev, h) {
    switch (ev.type) {
      case 'message': return void (await h.onMessage?.(ev.message));
      case 'reaction': return void (await h.onReaction?.(ev));
      case 'revoke': return void (await h.onRevoke?.(ev));
      case 'connection': return void (await h.onConnectionEvent?.(ev));
      default: return; // unknown/ignored types: acked, no work
    }
  }

  return {
    listen() {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
    hookPath,
    _server: server,
  };
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

module.exports = { createReceiver, BODY_CAP };

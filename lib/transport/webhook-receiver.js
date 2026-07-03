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
const HEALTHZ_MAX_AGE_S = 120; // 60s heartbeat cadence + slack

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        // Pause (don't destroy) so the caller can still write a 413 response; the
        // response's res.end() closes the socket. Destroying here would drop the
        // connection as a TCP reset and the documented 413 would never arrive.
        req.pause();
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
function createReceiver({ port, host = '127.0.0.1', pathToken, hmacKey, handlers, healthPayload = () => ({}), logger = console, emit = () => {}, bodyCap = BODY_CAP }) {
  const hookPath = `/hook/${pathToken}`;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        // 200 iff the event loop is alive AND the heartbeat is fresh (SPEC §4.1) —
        // a wedged loop with a stale heartbeat returns 503 so netdata sees it.
        const p = healthPayload();
        const stale = p.heartbeatAgeS == null || p.heartbeatAgeS > HEALTHZ_MAX_AGE_S;
        return json(res, stale ? 503 : 200, { ok: !stale, ...p });
      }
      if (req.method !== 'POST' || req.url !== hookPath) {
        return json(res, 404, { error: 'not found' });
      }

      let raw;
      try {
        raw = await readBody(req, bodyCap);
      } catch (e) {
        if (e.code === 'TOO_LARGE') {
          emit('webhook-anomaly', { reason: 'oversize-body' });
          // Deliver a real 413, then close the connection: the request body was not
          // fully read, so the socket must not be reused for a later request.
          return json(res, 413, { error: 'too large' }, { close: true });
        }
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

function json(res, status, body, { close = false } = {}) {
  const s = JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) };
  if (close) headers.connection = 'close'; // don't reuse a socket with an unread body
  res.writeHead(status, headers);
  res.end(s);
}

module.exports = { createReceiver, BODY_CAP };

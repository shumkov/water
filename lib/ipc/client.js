// provenance: polygram@0.17.11 lib/ipc/client.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Client for polygram's unix socket IPC.
 *
 * One-shot request-reply: open connection, write one JSON line, read one
 * JSON line, close. Used by the approval hook script (and, eventually,
 * cron callers).
 */

const net = require('net');
const fs = require('fs');

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 5 * 60 * 1000;

function socketPathFor(botName) {
  return `/tmp/polygram-${botName}.sock`;
}

function secretPathFor(botName) {
  return `/tmp/polygram-${botName}.secret`;
}

/**
 * Read the IPC secret for a bot. Prefers WATER_IPC_SECRET env var (set by
 * polygram when spawning Claude subprocesses) over the file (used by
 * cron and external callers that aren't polygram children). Missing secret
 * is not an error — caller decides whether to send it.
 */
function readSecret(botName) {
  if (process.env.WATER_IPC_SECRET) return process.env.WATER_IPC_SECRET;
  try { return fs.readFileSync(secretPathFor(botName), 'utf8').trim(); }
  catch { return null; }
}

function call({
  path, op, payload = {}, id = null, secret = null,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path });
    let resolved = false;
    const finish = (err, res) => {
      if (resolved) return;
      resolved = true;
      try { sock.destroy(); } catch {}
      clearTimeout(connectTimer);
      clearTimeout(callTimer);
      if (err) reject(err); else resolve(res);
    };

    const connectTimer = setTimeout(
      () => finish(new Error(`connect timeout after ${connectTimeoutMs}ms: ${path}`)),
      connectTimeoutMs,
    );
    const callTimer = setTimeout(
      () => finish(new Error(`call timeout after ${callTimeoutMs}ms`)),
      callTimeoutMs,
    );

    let buf = '';
    sock.on('connect', () => {
      clearTimeout(connectTimer);
      const envelope = { op, id, ...payload };
      if (secret) envelope.secret = secret;
      sock.write(JSON.stringify(envelope) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try {
        finish(null, JSON.parse(line));
      } catch (err) {
        finish(new Error(`bad json reply: ${err.message}`));
      }
    });
    sock.on('error', (err) => finish(err));
    sock.on('close', () => {
      if (!resolved) finish(new Error('socket closed without reply'));
    });
  });
}

/**
 * Convenience: send a Telegram message (or other allowed method) via the
 * owning bot's IPC socket. Cron's preferred replacement for talking to
 * `lib/telegram.js` directly.
 *
 * On failure returns { ok: false, error }. Callers should surface the error
 * to their own monitoring — silently eating it is how cron outages go unnoticed.
 */
async function tell(bot, method, params = {}, opts = {}) {
  const path = opts.path || socketPathFor(bot);
  const secret = opts.secret !== undefined ? opts.secret : readSecret(bot);
  const res = await call({
    path,
    op: 'send',
    id: opts.id || null,
    secret,
    payload: { method, params, source: opts.source || `cron:${process.argv[1]?.split('/').pop() || 'unknown'}` },
    connectTimeoutMs: opts.connectTimeoutMs,
    callTimeoutMs: opts.callTimeoutMs,
  });
  if (!res.ok) {
    const err = new Error(`polygram IPC: ${res.error || 'unknown error'}`);
    err.cause = res;
    throw err;
  }
  return res.result;
}

module.exports = { call, tell, socketPathFor, secretPathFor, readSecret };

// provenance: polygram@0.17.11 lib/ipc/server.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Unix socket IPC server for the polygram daemon.
 *
 * One socket per bot process at `/tmp/water-<bot>.sock`. Clients
 * (Claude Code approval hooks, future cron) send newline-delimited
 * JSON requests; the server invokes a registered handler and writes back a
 * newline-delimited JSON response.
 *
 * Each TCP-equivalent connection is one request / one response — no pooling,
 * no long-lived sessions. Simpler and matches the hook's one-shot lifecycle.
 */

const net = require('net');
const fs = require('fs');
const crypto = require('crypto');

function socketPathFor(botName) {
  return `/tmp/water-${botName}.sock`;
}

function secretPathFor(botName) {
  return `/tmp/water-${botName}.secret`;
}

/**
 * Generate and persist a fresh IPC secret. Written 0600 so only same-UID
 * processes can read it; same-UID is already the trust boundary (they can
 * also connect to the socket), but requiring knowledge of this secret gives
 * us a cheap way to reject stray processes that stumbled onto the socket
 * without intent — and makes the auth model explicit rather than implicit.
 */
function writeSecret(botName) {
  const secret = crypto.randomBytes(32).toString('base64url');
  const p = secretPathFor(botName);
  fs.writeFileSync(p, secret, { mode: 0o600 });
  // Re-chmod in case umask overrode our mode on create.
  try { fs.chmodSync(p, 0o600); } catch {}
  return secret;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Start a unix-socket server. Returns a close() function.
 *
 * @param {Object} opts
 * @param {string} opts.path       - socket path
 * @param {Object} opts.handlers   - { op_name: async (req) => res }
 * @param {Object} [opts.logger]   - console-like logger
 * @param {number} [opts.mode]     - chmod on the socket (default 0o600)
 */
function start({ path, handlers, logger = console, mode = 0o600, secret = null }) {
  // Stale socket cleanup — a crashed predecessor leaves the file.
  try { fs.unlinkSync(path); } catch {}

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // Drain as many complete lines as the chunk contains. The earlier
      // version handled only the first newline and silently dropped the
      // rest — that was a correctness bug under cron storms.
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(sock, line, handlers, logger, secret);
      }
    });
    sock.on('error', (err) => {
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
        logger.error(`[ipc] socket error: ${err.message}`);
      }
    });
  });

  server.on('error', (err) => {
    logger.error(`[ipc] server error: ${err.message}`);
  });

  return new Promise((resolve, reject) => {
    server.listen(path, () => {
      try { fs.chmodSync(path, mode); } catch (err) {
        logger.error(`[ipc] chmod ${path}: ${err.message}`);
      }
      logger.log(`[ipc] listening on ${path}`);
      resolve({
        close() {
          return new Promise((res) => {
            server.close(() => {
              try { fs.unlinkSync(path); } catch {}
              res();
            });
          });
        },
      });
    });
    server.once('error', reject);
  });
}

async function handleLine(sock, line, handlers, logger, secret) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    writeReply(sock, { ok: false, error: `bad json: ${err.message}` });
    return;
  }
  const op = req.op;
  const id = req.id || null;
  // Validate the shared secret (unless the server was started without one,
  // in which case we're in a test or back-compat mode). The 'ping' op is
  // exempt so liveness probes work without needing the secret.
  if (secret && op !== 'ping') {
    if (!timingSafeEqual(req.secret || '', secret)) {
      logger.error(`[ipc] missing/bad secret on op=${op}`);
      writeReply(sock, { id, ok: false, error: 'auth' });
      return;
    }
  }
  const handler = handlers[op];
  if (!handler) {
    writeReply(sock, { id, ok: false, error: `unknown op: ${op}` });
    return;
  }
  try {
    const res = await handler(req);
    writeReply(sock, { id, ok: true, ...res });
  } catch (err) {
    logger.error(`[ipc] handler ${op} failed: ${err.message}`);
    writeReply(sock, { id, ok: false, error: err.message });
  }
}

function writeReply(sock, obj) {
  try {
    sock.write(JSON.stringify(obj) + '\n');
    sock.end();
  } catch {}
}

module.exports = { start, socketPathFor, secretPathFor, writeSecret };

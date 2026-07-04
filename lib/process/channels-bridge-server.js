// provenance: polygram@0.17.11 lib/process/channels-bridge-server.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * ChannelsBridgeServer — per-session unix-socket server for the bridge
 * subprocess to connect back to.
 *
 * Extracted from CliProcess (M1 refactor) so the socket lifecycle —
 * listen with restrictive umask, accept ONE bridge, hello-handshake auth,
 * line-delimited JSON I/O, schema validation, single-bridge-per-session
 * enforcement, clean teardown — lives in one focused class instead of
 * sprawling across CliProcess.
 *
 * Owns:
 *   - net.Server lifecycle (listen / close)
 *   - socket file mode (0o600 via umask wrap + defensive chmod)
 *   - bridge connection state (single connection accepted)
 *   - hello-handshake secret verification
 *   - line-buffer + JSON parse + zod schema validation (channels-bridge-protocol)
 *
 * Does NOT own:
 *   - protocol semantics (tool routing, perm relay, turn lifecycle) — those
 *     stay in CliProcess, which subscribes to the events this class emits
 *   - claude/bridge process lifecycle
 *
 * Event surface (EventEmitter):
 *   'bridge-ready'        — daemon-side handshake (hello + session_init) complete
 *   'mcp-ready'           — claude-side MCP-server registration complete (first
 *                            ListToolsRequest received from claude). 0.12 P1.6
 *                            cold-spawn race fix — see channels-bridge.mjs.
 *   'bridge-message', msg — every validated bridge→daemon message (post-auth)
 *   'bridge-disconnected' — single-bridge connection closed
 *   'error', err          — socket-level errors (rare; non-fatal)
 */

'use strict';

const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const net = require('node:net');

const { parseBridgeToDaemonMessage } = require('./channels-bridge-protocol');

class ChannelsBridgeServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.sockPath
   * @param {string} opts.sessionKey   — bridge must echo this in hello
   * @param {string} opts.sockSecret   — bridge must present this in hello
   * @param {object} [opts.logger=console]
   * @param {string} [opts.label='channels-bridge-server']
   */
  constructor({ sockPath, sessionKey, sockSecret, logger = console, label = 'channels-bridge-server' } = {}) {
    super();
    if (!sockPath) throw new TypeError('ChannelsBridgeServer: sockPath required');
    if (!sessionKey) throw new TypeError('ChannelsBridgeServer: sessionKey required');
    if (!sockSecret) throw new TypeError('ChannelsBridgeServer: sockSecret required');
    this.sockPath = sockPath;
    this.sessionKey = sessionKey;
    this.sockSecret = sockSecret;
    this.logger = logger;
    this.label = label;

    this.server = null;
    this.conn = null;            // current bridge connection (one per session)
    this.authenticated = false;
  }

  /**
   * Bind + listen on the unix socket with restrictive umask so the inode is
   * created with mode 0o600 from birth (P1 #9 TOCTOU mitigation). Defensive
   * chmod runs in the listen callback as belt-and-suspenders.
   *
   * @returns {Promise<void>}
   */
  async listen() {
    return new Promise((resolve, reject) => {
      try { fs.unlinkSync(this.sockPath); } catch {}

      this.server = net.createServer({ allowHalfOpen: false }, conn => this._onConnect(conn));
      this.server.on('error', err => {
        this.logger.error?.(`[${this.label}] socket error: ${err.message}`);
        this.emit('error', err);
      });

      const prevUmask = process.umask(0o077);
      this.server.listen(this.sockPath, err => {
        process.umask(prevUmask);
        if (err) return reject(err);
        try {
          fs.chmodSync(this.sockPath, 0o600);
        } catch (chmodErr) {
          return reject(new Error(`failed to chmod 0600 ${this.sockPath}: ${chmodErr.message}`));
        }
        resolve();
      });
    });
  }

  /**
   * Write a daemon→bridge message. Drops silently (with warn) if no live
   * connection. Returns true if write was attempted, false if dropped.
   */
  writeMessage(obj) {
    if (!this.conn || this.conn.destroyed) {
      this.logger.warn?.(`[${this.label}] writeMessage — no live connection (kind=${obj?.kind})`);
      return false;
    }
    try {
      this.conn.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (err) {
      this.logger.warn?.(`[${this.label}] socket write failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Forcibly destroy the bridge connection (used by the pong watchdog to
   * trigger the normal close→drain→respawn chain).
   */
  destroyConnection() {
    if (this.conn) try { this.conn.destroy(); } catch {}
  }

  /**
   * Tear down the server + close the connection + unlink the socket file.
   * Idempotent.
   */
  async close() {
    if (this.conn) {
      try { this.conn.end(); } catch {}
      this.conn = null;
    }
    if (this.server) {
      await new Promise(resolve => this.server.close(() => resolve()));
      this.server = null;
    }
    try { fs.unlinkSync(this.sockPath); } catch {}
  }

  // ─── private ──────────────────────────────────────────────────────

  _onConnect(conn) {
    // Single bridge per session — reject second connections.
    if (this.conn && !this.conn.destroyed) {
      this.logger.warn?.(`[${this.label}] extra bridge connection rejected`);
      try { conn.write(JSON.stringify({ kind: 'hello_reject', reason: 'already-connected' }) + '\n'); } catch {}
      conn.end();
      return;
    }
    this.conn = conn;
    let buf = '';
    let authenticated = false;

    // utf8 setEncoding reassembles multibyte sequences split across data
    // events (Node's internal StringDecoder). Without it, `buf += chunk`
    // decodes each Buffer chunk independently and a char straddling the
    // ~64KB chunk boundary becomes U+FFFD — silent corruption of large
    // replies. Same class as the log-tail.js StringDecoder fix.
    conn.setEncoding('utf8');
    conn.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let raw;
        try { raw = JSON.parse(line); }
        catch {
          this.logger.warn?.(`[${this.label}] bad json from bridge: ${line.slice(0, 100)}`);
          continue;
        }

        if (!authenticated) {
          // Review F#7: harden the hello-handshake.
          //   1. timingSafeEqual for the secret compare so a same-uid
          //      attacker can't byte-by-byte probe via response-timing.
          //   2. ROTATE the secret after first successful auth (set to
          //      null) so a stale WATER_SOCK_SECRET leaked via
          //      /proc/<pid>/environ can't replay against this
          //      CliProcess after the legit bridge disconnects.
          //      The bridge process is one-shot per spawn anyway (it
          //      exits on socket close — see channels-bridge.mjs:109),
          //      so legitimate re-auth within one CliProcess
          //      instance never happens — only a hijacker would.
          const verdict = this._verifyHelloAuth(raw);
          if (verdict.ok) {
            authenticated = true;
            this.authenticated = true;
            this.sockSecret = null;   // invalidate — single-shot per instance
            try { conn.write(JSON.stringify({ kind: 'hello_ack' }) + '\n'); } catch {}
            continue;
          }
          this.logger.warn?.(`[${this.label}] hello rejected — reason=${verdict.reason}`);
          try { conn.write(JSON.stringify({ kind: 'hello_reject', reason: 'auth' }) + '\n'); } catch {}
          conn.end();
          this.conn = null;
          this.authenticated = false;
          return;
        }

        // Post-auth: validate against schema, emit on success, drop+warn on fail.
        const parsed = parseBridgeToDaemonMessage(raw);
        if (!parsed.ok) {
          this.logger.warn?.(
            `[${this.label}] bridge msg schema invalid — ${parsed.error} — dropping`,
          );
          continue;
        }
        if (parsed.msg.kind === 'session_init') {
          // session_init also signals the bridge is fully ready. Emit
          // bridge-ready BEFORE the bridge-message so listeners that gate on
          // bridge-ready can subscribe to the message stream.
          this.emit('session-init', parsed.msg);
          this.emit('bridge-ready');
          continue;
        }
        if (parsed.msg.kind === 'mcp-ready') {
          // 0.12 Phase 1.6: bridge signals that claude has finished
          // registering it as an MCP server. Polygram gates send() on this
          // (Finding 0.3.A — cold-spawn race).
          this.emit('mcp-ready', parsed.msg);
          continue;
        }
        this.emit('bridge-message', parsed.msg);
      }
    });

    conn.on('close', () => {
      if (this.conn === conn) {
        this.conn = null;
        this.authenticated = false;
        this.emit('bridge-disconnected');
      }
    });

    conn.on('error', err => {
      this.logger.warn?.(`[${this.label}] bridge conn error: ${err.message}`);
    });
  }

  /**
   * Review F#7: hello-handshake verification, extracted as a pure method so it
   * can be exercised in isolation. Returns `{ ok: true }` on accept or
   * `{ ok: false, reason }` on reject. Uses crypto.timingSafeEqual for the
   * secret compare and refuses if this.sockSecret has already been consumed
   * (post-auth rotation).
   *
   * @param {object} raw — parsed bridge→daemon hello payload
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  _verifyHelloAuth(raw) {
    if (this.sockSecret == null) {
      return { ok: false, reason: 'secret-consumed' };
    }
    if (!raw || raw.kind !== 'hello') {
      return { ok: false, reason: 'not-hello' };
    }
    if (raw.session_key !== this.sessionKey) {
      return { ok: false, reason: 'wrong-session-key' };
    }
    if (typeof raw.secret !== 'string' || raw.secret.length === 0) {
      return { ok: false, reason: 'no-secret' };
    }
    const a = Buffer.from(raw.secret, 'utf8');
    const b = Buffer.from(this.sockSecret, 'utf8');
    if (a.length !== b.length) {
      // timingSafeEqual requires equal-length inputs; length mismatch is a
      // wrong-secret signal but constant-time compares MUST short-circuit
      // here (otherwise we'd leak the secret's length).
      return { ok: false, reason: 'wrong-secret' };
    }
    if (!crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'wrong-secret' };
    }
    return { ok: true };
  }
}

module.exports = { ChannelsBridgeServer };

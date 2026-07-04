// provenance: polygram@0.17.11 lib/tmux/log-tail.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * LogTail — generic append-only file tailer. Emits 'line' events as
 * new lines arrive.
 *
 * Used by TmuxProcess to follow claude's per-session JSONL conversation
 * file (`~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl`) so we can
 * surface structured assistant + tool + usage + stop_reason events on
 * the tmux backend. The class itself is backend-agnostic — it just
 * tails a file.
 *
 * (Originally named DebugLogTail when the design assumed we'd parse
 * `--debug-file` output. The v9 probe showed that channel carries only
 * MDM/MCP infra messages and zero conversation events; the JSONL
 * session file is the real channel. Class renamed to match what it
 * actually does.)
 *
 * Design:
 *   - Default mode `useWatch: 'auto'` uses `fs.watch` on the parent
 *     directory + filename filter — near-zero steady-state IO. Falls
 *     back to polling automatically if `fs.watch` fails (sandboxed
 *     environment, unsupported FS). A slow 1s safety-net poll runs
 *     alongside the watcher to catch any missed events.
 *   - `useWatch: false` forces polling — for environments where
 *     fs.watch is known broken.
 *   - `useWatch: true` requires fs.watch to work — throws on failure.
 *     Use for testing the watch path deterministically.
 *   - Tolerates the file not existing yet (claude may take ~100ms to
 *     create it after spawn). The directory watcher fires once it
 *     appears.
 *   - Carries a partial-line buffer across reads so a line split
 *     across two reads still emits exactly once.
 *   - Safety cap on per-line size (MAX_BUF_BYTES) so a hostile or
 *     corrupted multi-MB single-line write can't OOM the daemon or
 *     stall the event loop on a sync JSON.parse.
 *   - Idempotent .close().
 *
 * @see lib/util/claude-session-jsonl.js — JSONL line → typed event
 */

'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const DEFAULT_INTERVAL_MS = 100;
// Slow safety-net poll when fs.watch is active. Catches any events
// the watcher missed (rare on Linux/macOS, more common on networked
// or fuse filesystems). 1s is more than enough for backstop.
const WATCH_SAFETY_NET_MS = 1000;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
// Safety cap: a single line with no \n must not grow `_buf` without
// bound. claude TUI doesn't emit lines this big in normal operation;
// hitting this is a sign of corruption or a hostile tool result that
// could OOM the daemon and stall the event loop with a sync JSON.parse.
const MAX_BUF_BYTES = 16 * 1024 * 1024;

class LogTail extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.path             — log file path
   * @param {number} [opts.intervalMs=100] — poll interval when in
   *   polling mode (also used as the initial-tick delay in watch mode).
   * @param {boolean} [opts.skipExisting]  — start at current file size,
   *   only emit lines added AFTER start(). Used for `--resume` on the
   *   tmux backend so historic JSONL events aren't replayed.
   * @param {'auto'|true|false} [opts.useWatch='auto']
   *   - 'auto' (default): try fs.watch; fall back to polling on error.
   *   - true:  require fs.watch to work; throw on failure.
   *   - false: force polling.
   * @param {object} [opts.fs]             — test seam (override fs)
   * @param {object} [opts.logger=console]
   */
  constructor({
    path: filePath,
    intervalMs = DEFAULT_INTERVAL_MS,
    skipExisting = false,
    useWatch = 'auto',
    fs: fsOverride,
    logger = console,
  } = {}) {
    super();
    if (typeof filePath !== 'string' || !filePath) {
      throw new TypeError('LogTail: path required');
    }
    this.path = filePath;
    this.intervalMs = intervalMs;
    this.skipExisting = skipExisting;
    this.useWatch = useWatch;
    this.logger = logger;
    this.fs = fsOverride || fs;
    this._offset = 0;
    this._buf = '';
    // L8: decode bytes through a StringDecoder so a multibyte UTF-8 char
    // split across two read chunks (the 64KB DEFAULT_CHUNK_BYTES boundary)
    // isn't corrupted into U+FFFD. The decoder holds an incomplete trailing
    // sequence until the continuation bytes arrive on the next read. The
    // hook ndjson carries large non-ASCII tool payloads, so this is
    // load-bearing on the CliProcess observability path.
    this._decoder = new StringDecoder('utf8');
    this._closed = false;
    this._timer = null;
    this._watcher = null;
    this._mode = null;       // 'watch' | 'poll' after start()
    this._initialised = false;
    this._readInFlight = false; // debounce concurrent _readNew triggers
    this._readPending = false;
  }

  start() {
    if (this._closed) throw new Error('LogTail: closed');
    if (this._mode) return; // idempotent
    // Snapshot offset at start() time when skipExisting is requested.
    // Doing this on first read instead would race: if content is
    // appended between start() and the first read, the offset jump
    // would skip those bytes too.
    if (this.skipExisting) {
      try {
        const stat = this.fs.statSync(this.path);
        this._offset = stat.size;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // File doesn't exist yet — offset stays 0, all future content
        // is "new" by definition.
      }
      this._initialised = true;
    }
    // Decide watch vs poll. In 'auto' mode we attempt fs.watch and
    // silently fall back; in 'true' mode we throw on failure; in
    // 'false' mode we skip the attempt entirely.
    if (this.useWatch !== false) {
      if (this._tryStartWatch()) {
        this._mode = 'watch';
        // Trigger an immediate first read (existing content + warmup),
        // then add a slow safety-net poll on top of the watcher to
        // catch any missed events.
        setImmediate(() => this._triggerRead());
        this._startSafetyNetPoll();
        return;
      }
      if (this.useWatch === true) {
        throw new Error('LogTail: useWatch:true requested but fs.watch failed');
      }
      this.logger.log?.(`[log-tail] fs.watch unavailable for ${this.path}; falling back to polling`);
    }
    this._mode = 'poll';
    this._startPolling();
  }

  /**
   * Try to install fs.watch on the parent directory. We watch the dir
   * (not the file) because the file may not exist yet — claude TUI
   * creates it a moment after spawn. Returns true on success.
   */
  _tryStartWatch() {
    try {
      const dir = path.dirname(this.path);
      const base = path.basename(this.path);
      // Ensure the parent exists so fs.watch can attach. If the
      // ~/.claude/projects/<cwd> dir hasn't been created yet, claude
      // will create it on first turn; we make it now so the watcher
      // can attach immediately.
      this.fs.mkdirSync(dir, { recursive: true });
      this._watcher = this.fs.watch(dir, { persistent: false }, (eventType, filename) => {
        if (this._closed) return;
        if (filename !== base) return;
        this._triggerRead();
      });
      this._watcher.on('error', (err) => {
        // Watcher errored mid-flight (e.g. dir removed). Fall back to
        // polling instead of stopping entirely.
        this.logger.warn?.(`[log-tail] watcher error for ${this.path}: ${err.message}; falling back to polling`);
        try { this._watcher.close(); } catch {}
        this._watcher = null;
        if (!this._closed) {
          this._mode = 'poll';
          this._startPolling();
        }
      });
      return true;
    } catch (err) {
      // EPERM (sandbox), ENOSYS (unsupported), ENOENT (path gone) — all fall back.
      this.logger.log?.(`[log-tail] fs.watch attempt failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Schedule a `_readNew()` call. Multiple triggers between reads are
   * coalesced into a single read — debounces watcher event storms when
   * claude writes many lines in quick succession.
   */
  _triggerRead() {
    if (this._closed) return;
    if (this._readInFlight) {
      this._readPending = true;
      return;
    }
    this._readInFlight = true;
    this._readNew()
      .catch((err) => this.emit('error', err))
      .finally(() => {
        this._readInFlight = false;
        if (this._readPending && !this._closed) {
          this._readPending = false;
          // Re-enter once more to catch anything that arrived during
          // the previous read.
          setImmediate(() => this._triggerRead());
        }
      });
  }

  _startSafetyNetPoll() {
    if (this._closed) return;
    const tick = () => {
      if (this._closed) return;
      this._triggerRead();
      this._timer = setTimeout(tick, WATCH_SAFETY_NET_MS);
      this._timer.unref?.();
    };
    this._timer = setTimeout(tick, WATCH_SAFETY_NET_MS);
    this._timer.unref?.();
  }

  _startPolling() {
    const tick = () => {
      if (this._closed) return;
      this._triggerRead();
      if (!this._closed) {
        this._timer = setTimeout(tick, this.intervalMs);
        // Don't keep the event loop alive solely for tailing. In
        // production the polygram daemon has many other refs (Telegram
        // polling, IPC, the tmux session itself) keeping it up.
        this._timer.unref?.();
      }
    };
    // Fire the first tick immediately so existing content (if any)
    // is consumed without waiting `intervalMs`. setImmediate is NOT
    // unref'd here — we want at least one read of existing content to
    // complete before the loop is allowed to exit.
    this._timer = setImmediate(tick);
  }

  async _readNew() {
    let stat;
    try {
      stat = await this.fs.promises.stat(this.path);
    } catch (err) {
      if (err.code === 'ENOENT') return; // not created yet
      throw err;
    }
    if (stat.size < this._offset) {
      // File truncated (rare for claude debug-file but possible on log
      // rotation). Reset offset and re-read from the beginning.
      this.emit('truncated', { previous: this._offset, current: stat.size });
      this._offset = 0;
      this._buf = '';
      // Drop any partial multibyte sequence buffered inside the decoder —
      // it belongs to the pre-truncation file and would corrupt the first
      // post-truncation read.
      this._decoder = new StringDecoder('utf8');
    }
    if (stat.size <= this._offset) return; // unchanged
    const fd = await this.fs.promises.open(this.path, 'r');
    try {
      const bytesToRead = stat.size - this._offset;
      const buffer = Buffer.alloc(Math.min(bytesToRead, DEFAULT_CHUNK_BYTES));
      let totalRead = 0;
      while (totalRead < bytesToRead && !this._closed) {
        const remaining = bytesToRead - totalRead;
        const readSize = Math.min(remaining, buffer.length);
        const { bytesRead } = await fd.read(buffer, 0, readSize, this._offset + totalRead);
        if (bytesRead === 0) break;
        // L8: StringDecoder.write instead of per-chunk toString('utf8') so a
        // multibyte char straddling the read boundary survives intact.
        this._buf += this._decoder.write(buffer.subarray(0, bytesRead));
        totalRead += bytesRead;
      }
      this._offset += totalRead;
    } finally {
      await fd.close();
    }
    // Split on newlines, keeping any trailing partial line in _buf.
    const parts = this._buf.split(/\r?\n/);
    this._buf = parts.pop() ?? '';
    // Safety: drop the trailing partial line if it grew past
    // MAX_BUF_BYTES without a newline. claude TUI doesn't write lines
    // this large in normal operation; continuing would risk OOM.
    if (this._buf.length > MAX_BUF_BYTES) {
      this.emit('line-too-long', {
        bytes: this._buf.length,
        max: MAX_BUF_BYTES,
        location: 'trailing-partial',
      });
      this._buf = '';
    }
    for (const line of parts) {
      if (this._closed) return;
      // Skip empty lines (common in debug logs).
      if (line.length === 0) continue;
      // Safety: drop completed lines that exceed the cap. JSON.parse
      // on a 100MB line synchronously blocks the event loop.
      if (line.length > MAX_BUF_BYTES) {
        this.emit('line-too-long', {
          bytes: line.length,
          max: MAX_BUF_BYTES,
          location: 'completed-line',
        });
        continue;
      }
      this.emit('line', line);
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      clearImmediate(this._timer);
      this._timer = null;
    }
    if (this._watcher) {
      try { this._watcher.close(); } catch {}
      this._watcher = null;
    }
    // Flush any trailing buffered partial line as a final 'line' so
    // consumers don't lose data on shutdown.
    if (this._buf.length > 0) {
      this.emit('line', this._buf);
      this._buf = '';
    }
    this.emit('close');
  }
}

module.exports = { LogTail };

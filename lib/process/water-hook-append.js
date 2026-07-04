#!/usr/bin/env node
// provenance: polygram@0.17.11 lib/process/polygram-hook-append.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * water-hook-append — claude-CLI hook subprocess that appends one
 * compacted JSON line to a per-session ndjson file.
 *
 * Invoked by claude as: `node <abs path>/water-hook-append.js <ndjson abs path>`
 * Stdin: one JSON document (the hook payload). Stdout: nothing.
 *
 * Used by the tmux backend H1 (hook-based turn observability). See
 * docs/0.10.0-tmux-hook-observability.md.
 *
 * Behaviour:
 *  - Reads stdin to EOF, parses as JSON.
 *  - Stamps `polygram_received_at_ms` (Date.now) so we can measure
 *    Pre↔Post latency from polygram's wall clock independent of the
 *    hook's own `duration_ms`.
 *  - Writes ONE line (JSON.stringify + '\n') with a single fs.writeSync
 *    on a fd opened O_APPEND. On macOS, O_APPEND atomicity is NOT
 *    guaranteed above PIPE_BUF (~4 KB); H1 is observe-only and records
 *    parse failures so we can measure interleave during the soak.
 *  - Bad JSON → emits a wrapped record with the raw body and a marker
 *    so the tail's parser can surface it (never silent-drop).
 *  - Failures (missing argv, open/write error) exit non-zero but never
 *    throw out of `claude` (claude already runs us with stdout/stderr
 *    captured and a timeout); the worst case is a single missing line.
 *
 * Determinism: no shell, no external deps. Resolved at fixed absolute
 * path so the `command:` string in the settings JSON is free of
 * metachars and `~`-expansion.
 */

'use strict';

const fs = require('fs');

const outPath = process.argv[2];
if (!outPath) {
  process.stderr.write('water-hook-append: missing ndjson path (argv[2])\n');
  process.exit(2);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buf += chunk; });
process.stdin.on('end', () => {
  let line;
  try {
    const obj = JSON.parse(buf);
    obj.polygram_received_at_ms = Date.now();
    line = JSON.stringify(obj);
  } catch (err) {
    // Preserve the raw body so the tail can flag it; never silent-drop.
    line = JSON.stringify({
      polygram_parse_error: err.message,
      polygram_received_at_ms: Date.now(),
      raw: buf.length > 64 * 1024 ? buf.slice(0, 64 * 1024) + '…[truncated]' : buf,
    });
  }
  let fd;
  try {
    fd = fs.openSync(outPath, 'a');
    fs.writeSync(fd, line + '\n');
  } catch (err) {
    process.stderr.write(`water-hook-append: write failed: ${err.message}\n`);
    process.exitCode = 3;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* swallow */ }
    }
  }
});

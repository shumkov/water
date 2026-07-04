// provenance: polygram@0.17.11 lib/telegram/chunk.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Markdown-aware chunking for Telegram-bound replies.
 *
 * Direct port of OpenClaw's chunkMarkdownText. The naive byte-cut
 * chunker we shipped before this would land boundaries mid-word and
 * mid-HTML-tag, which Telegram's parse_mode=HTML rejected with
 * `400 can't parse entities` — bubbles froze and content got dropped.
 *
 * Guarantees:
 *
 *   1. No chunk exceeds `limit`.
 *   2. Breaks prefer newlines over whitespace over hard-cut.
 *   3. Code fences (```...```) are never broken silently — if a chunk
 *      would land inside a fence, we close it on chunk N and re-open
 *      with the same marker + language on chunk N+1, so each chunk is
 *      independently parseable.
 *   4. Parenthesised expressions `(...)` aren't broken at whitespace
 *      inside the parens (avoids splitting markdown-link syntax like
 *      `[label](http://example.com/...)`).
 *
 * Plain `chunkText` (no fence handling) is exported for callers that
 * already know the input has no markdown — primarily code paths
 * handling raw user input echoes or non-text payloads.
 */

// ─── Code-fence span detection ──────────────────────────────────────

// Scan `buffer` for ```...``` and ~~~...~~~ fences. Returns the span list
// of matched (open, close) pairs. An unclosed open fence at end-of-input
// is treated as if it closes at end (so the chunker can still split inside
// safely).
function parseFenceSpans(buffer) {
  const spans = [];
  let open;
  let offset = 0;
  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf('\n', offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    const line = buffer.slice(offset, lineEnd);
    // Fence opens/closes start with up to 3 spaces of indent then 3+ of
    // ` or ~. The "info string" after the marker (language hint) doesn't
    // affect span boundaries.
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (match) {
      const indent = match[1];
      const marker = match[2];
      const markerChar = marker[0];
      const markerLen = marker.length;
      if (!open) {
        open = { start: offset, markerChar, markerLen, openLine: line, marker, indent };
      } else if (open.markerChar === markerChar && markerLen >= open.markerLen) {
        // Closing fence must use the SAME char and at least as many of them.
        // Different-char or shorter sequences are part of the body.
        spans.push({
          start: open.start, end: lineEnd,
          openLine: open.openLine, marker: open.marker, indent: open.indent,
        });
        open = undefined;
      }
    }
    if (nextNewline === -1) break;
    offset = nextNewline + 1;
  }
  if (open) {
    // Unclosed at EOF — treat as spanning to end so a later break-point
    // inside knows it's "in fence".
    spans.push({
      start: open.start, end: buffer.length,
      openLine: open.openLine, marker: open.marker, indent: open.indent,
    });
  }
  return spans;
}

function findFenceSpanAt(spans, index) {
  // Strict inequality: a break at exactly span.start is just before the
  // opening fence (safe). At span.end, just after the close (also safe).
  return spans.find((span) => index > span.start && index < span.end);
}

function isSafeFenceBreak(spans, index) {
  return !findFenceSpanAt(spans, index);
}

// ─── Paren-aware break-point scan ───────────────────────────────────

// Find the last newline / last whitespace in `window` that's NOT inside
// `(...)` parens. Used by both plain and markdown chunkers.
//
// `isAllowed(i)` is consulted before every candidate — passed by the
// markdown chunker to skip break points inside fence spans.
function scanParenAwareBreakpoints(window, isAllowed = () => true) {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;
  for (let i = 0; i < window.length; i++) {
    if (!isAllowed(i)) continue;
    const char = window[i];
    if (char === '(') { depth += 1; continue; }
    if (char === ')' && depth > 0) { depth -= 1; continue; }
    if (depth !== 0) continue;
    if (char === '\n') lastNewline = i;
    else if (/\s/.test(char)) lastWhitespace = i;
  }
  return { lastNewline, lastWhitespace };
}

// ─── Chunkers ────────────────────────────────────────────────────────

// Common early-out: empty / fits-in-one returns directly so the loop
// bodies can assume there's real work to do. `limit ≤ 0` is treated as
// a programmer error and throws — silently returning [text] would let
// a misread config pass through a body that exceeds Telegram's actual
// 4096-char cap, which the chunker exists to prevent.
function resolveChunkEarlyReturn(text, limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new RangeError(`chunk limit must be a positive number; got ${limit}`);
  }
  if (text == null || text === '') return [];
  if (typeof text !== 'string') {
    throw new TypeError(`chunk text must be a string; got ${typeof text}`);
  }
  if (text.length <= limit) return [text];
  return undefined;
}

// A hard cut at a fixed UTF-16 offset can land between the two code units
// of a surrogate pair (astral chars: emoji, rare CJK, math symbols) — the
// pair then renders as U+FFFD on both sides of the boundary. Back the cut
// off one unit when it would split a pair. Never returns 0 (a degenerate
// limit of 1 keeps the raw cut rather than looping forever on an empty
// chunk).
function surrogateSafeCut(text, idx) {
  if (idx > 1 && idx < text.length) {
    const c = text.charCodeAt(idx - 1);
    if (c >= 0xD800 && c <= 0xDBFF) return idx - 1;
  }
  return idx;
}

// Generic break-resolver loop shared with markdown variant. The resolver
// receives a `window` (text.slice(0, limit)) and returns where to break.
// Negative / out-of-range break indices fall back to hard-cut at limit.
function chunkTextByBreakResolver(text, limit, resolveBreakIndex) {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const candidateBreak = resolveBreakIndex(remaining.slice(0, limit));
    const breakIdx = Number.isFinite(candidateBreak) && candidateBreak > 0 && candidateBreak <= limit
      ? candidateBreak
      : surrogateSafeCut(remaining, limit);
    const chunk = remaining.slice(0, breakIdx).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    // If we broke on a separator (whitespace), consume it — don't carry it
    // to the start of the next chunk where it'd just be trimmed anyway.
    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

// Plain-text chunker: respects parens but ignores fences. Cheaper than
// chunkMarkdownText when caller knows the input has no code blocks.
function chunkText(text, limit) {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early !== undefined) return early;
  return chunkTextByBreakResolver(text, limit, (window) => {
    const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window);
    return lastNewline > 0 ? lastNewline : lastWhitespace;
  });
}

// Strip leading newlines from the remainder after a chunk break — they
// would otherwise show up as blank lines at the top of the next bubble.
function stripLeadingNewlines(value) {
  let i = 0;
  while (i < value.length && value[i] === '\n') i++;
  return i > 0 ? value.slice(i) : value;
}

// Inside a code-fence, prefer the last newline (line boundary) — but only
// inside the safe break region. Falls back to whitespace, then hard-cut.
function pickSafeBreakIndex(window, spans) {
  const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(
    window,
    (index) => isSafeFenceBreak(spans, index),
  );
  if (lastNewline > 0) return lastNewline;
  if (lastWhitespace > 0) return lastWhitespace;
  return -1;
}

// Markdown-aware chunker. The whole point of 0.7.0 over the previous
// `lastIndexOf('\n', maxLen)` chunker.
//
// Flow per iteration:
//   1. Parse fence spans of the remainder.
//   2. Pick the best (newline > whitespace) break inside `[0..limit]`
//      that's NOT inside a fence. Fall back to hard-cut at limit.
//   3. If the break did land inside a fence (no safe alternative was
//      reachable), search backwards for a newline within the fence body
//      that still fits with a closing-fence appended; if found, split
//      the fence — close it on this chunk and reopen with the same
//      marker+language on the next.
//   4. Append the chunk; advance `remaining` past the break + the
//      reopened fence header (if any).
function chunkMarkdownText(text, limit) {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early !== undefined) return early;
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const spans = parseFenceSpans(remaining);
    const softBreak = pickSafeBreakIndex(remaining.slice(0, limit), spans);
    let breakIdx = softBreak > 0 ? softBreak : surrogateSafeCut(remaining, limit);
    const initialFence = isSafeFenceBreak(spans, breakIdx) ? undefined : findFenceSpanAt(spans, breakIdx);
    let fenceToSplit = initialFence;
    if (initialFence) {
      // The break landed inside a fence. We may still split the fence,
      // but only if there's room for a closing line within the limit.
      const closeLine = `${initialFence.indent}${initialFence.marker}`;
      const maxIdxIfNeedNewline = limit - (closeLine.length + 1); // need a \n separator
      if (maxIdxIfNeedNewline <= 0) {
        // Even the close line wouldn't fit — give up and hard-cut.
        // Caller will see a malformed chunk, but that's a degenerate
        // input case (limit smaller than the close marker).
        fenceToSplit = undefined;
        breakIdx = limit;
      } else {
        // Look for a newline inside the fence body that's late enough
        // to make progress (past the open line + at least one body line)
        // and early enough that close line fits.
        const minProgressIdx = Math.min(
          remaining.length,
          initialFence.start + initialFence.openLine.length + 2,
        );
        const maxIdxIfAlreadyNewline = limit - closeLine.length;
        let pickedNewline = false;
        let lastNewline = remaining.lastIndexOf('\n', Math.max(0, maxIdxIfAlreadyNewline - 1));
        while (lastNewline !== -1) {
          const candidateBreak = lastNewline + 1;
          if (candidateBreak < minProgressIdx) break;
          const candidateFence = findFenceSpanAt(spans, candidateBreak);
          if (candidateFence && candidateFence.start === initialFence.start) {
            breakIdx = Math.max(1, candidateBreak);
            pickedNewline = true;
            break;
          }
          lastNewline = remaining.lastIndexOf('\n', lastNewline - 1);
        }
        if (!pickedNewline) {
          if (minProgressIdx > maxIdxIfAlreadyNewline) {
            // No safe in-fence newline found and no room to add one —
            // give up on splitting this fence; hard-cut at limit.
            fenceToSplit = undefined;
            breakIdx = limit;
          } else {
            // Force the break; chunker will append a synthetic newline
            // before the close line.
            breakIdx = Math.max(minProgressIdx, maxIdxIfNeedNewline);
          }
        }
      }
      // Re-check the break: if our adjusted index is no longer inside
      // the same fence, don't try to split it.
      const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
      fenceToSplit = fenceAtBreak && fenceAtBreak.start === initialFence.start ? fenceAtBreak : undefined;
    }
    let rawChunk = remaining.slice(0, breakIdx);
    if (!rawChunk) break;
    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    let next = remaining.slice(nextStart);
    if (fenceToSplit) {
      // Close the fence on this chunk; reopen with the same marker line
      // (preserving language hint) on the next.
      const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
      rawChunk = rawChunk.endsWith('\n') ? `${rawChunk}${closeLine}` : `${rawChunk}\n${closeLine}`;
      next = `${fenceToSplit.openLine}\n${next}`;
    } else {
      // Strip stray leading newlines on the next chunk so it doesn't
      // open with blank lines.
      next = stripLeadingNewlines(next);
    }
    chunks.push(rawChunk);
    remaining = next;
  }
  if (remaining.length) chunks.push(remaining);
  // 0.7.x defensive post-pass: enforce limit on every chunk. The
  // fence-splitting "force the break" path (line ~250) can produce
  // a chunk whose length = breakIdx + closeLine.length + 1, which
  // may overflow when there's no safe break. Same for the
  // hard-cut path when no progress is possible. Production saw
  // chunks of 4097-4500 chars hitting Telegram's 400 "message is
  // too long". Splitting again byte-wise here is uglier than
  // markdown-aware, but it's better than the user getting a
  // failed-out row + missing reply.
  const safe = [];
  for (const c of chunks) {
    if (c.length <= limit) { safe.push(c); continue; }
    let rest = c;
    while (rest.length > limit) {
      // Prefer a newline cut within the last 200 chars of the
      // limit (cheap heuristic — much better than mid-word).
      const window = rest.slice(0, limit);
      const lastNl = window.lastIndexOf('\n', limit - 1);
      const cutAt = lastNl > limit - 200 ? lastNl + 1 : surrogateSafeCut(rest, limit);
      safe.push(rest.slice(0, cutAt));
      rest = rest.slice(cutAt);
    }
    if (rest.length) safe.push(rest);
  }
  return safe;
}

module.exports = {
  chunkText,
  chunkMarkdownText,
  // Internals exported for tests; not part of the stable API.
  parseFenceSpans,
  scanParenAwareBreakpoints,
};

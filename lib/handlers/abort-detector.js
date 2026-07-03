// provenance: polygram@0.17.10 lib/abort-detector.js (git dcceff6) — adapt: same
// first-sentence match approach; slash forms + multilingual keyword set (en/ru/th).
// Detects a user asking to stop the in-flight turn. See SPEC §4.2 (abort stage).

'use strict';

const SLASH = /^\/(stop|abort|cancel)\b/i;

// Whole-word stop intents. First-sentence only, so "Stop. I'll ask elsewhere." matches
// but "don't stop now" (mid-sentence) does not trigger a false abort.
const WORDS = [
  'stop', 'cancel', 'wait', 'halt',           // en
  'стоп', 'отмена', 'хватит', 'подожди',      // ru
  'หยุด', 'รอ', 'ยกเลิก',                        // th
];

function firstSentence(text) {
  return String(text).trim().split(/[.!?\n。！？]/)[0].trim();
}

function isAbort(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (SLASH.test(t)) return true;
  const first = firstSentence(t).toLowerCase();
  if (!first) return false;
  // Match only when the sentence IS the stop word (optionally with light punctuation),
  // not merely contains it — avoids "please don't stop" false positives.
  for (const w of WORDS) {
    if (first === w) return true;
    if (new RegExp(`^${w}[\\s,!.]*$`, 'iu').test(first)) return true;
  }
  return false;
}

module.exports = { isAbort, WORDS };

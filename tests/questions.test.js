'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { createQuestions, parseAnswer } = require('../lib/handlers/questions');

const SILENT = { debug() {}, error() {}, warn() {}, log() {} };
const DM = '2280@lid';
const GROUP = '12036@g.us';
const ASKER = '2280:3@lid';

function harness(over = {}) {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-q-')), 't.db'));
  const answers = [];     // pm.answerQuestion calls
  const delivered = [];   // deliver() calls
  const events = [];      // logEvent calls
  const clock = { t: 1_700_000_000_000 };
  const pm = { answerQuestion: (sessionKey, toolCallId, result) => { answers.push({ sessionKey, toolCallId, result }); return true; } };
  const jidMap = { matchesAny: (jid, list) => list.some((x) => String(x) === String(jid)) };
  const q = createQuestions({
    db, pm, jidMap,
    deliver: (chatJid, text) => { delivered.push({ chatJid, text }); },
    inFlightSender: () => ASKER,
    logEvent: (kind, detail) => events.push({ kind, detail }),
    logger: SILENT,
    now: () => clock.t,
    timeoutMs: 5 * 60_000,
    ...over,
  });
  const rows = () => db.prepare('SELECT * FROM pending_questions ORDER BY id').all();
  return { db, q, pm, answers, delivered, events, clock, rows };
}

const OPTS = [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }];
const askPayload = (over = {}) => ({
  chatId: DM, toolCallId: 'tc-1',
  questions: [{ header: 'size', question: 'Which size?', options: OPTS, ...over }],
});

// ── group degrade (the anti-wedge core) ──────────────────────────────────────
test('group ask degrades: resolves {cancelled} at once, writes NO row (a group can never wedge)', () => {
  const h = harness();
  h.q.onAsked(GROUP, { chatId: GROUP, toolCallId: 'g1', questions: [{ question: 'x?', options: OPTS }] });
  assert.equal(h.answers.length, 1);
  assert.equal(h.answers[0].sessionKey, GROUP);
  assert.equal(h.answers[0].toolCallId, 'g1');
  assert.equal(h.answers[0].result.cancelled, true);
  assert.ok(h.answers[0].result.reason, 'carries a reason so the agent re-asks in a reply');
  assert.equal(h.rows().length, 0, 'no pending row for a group ask');
  assert.ok(h.events.some((e) => e.kind === 'question-group-degraded'));
});

// ── DM ask + answer round-trip ───────────────────────────────────────────────
test('DM ask: inserts open row (session_id === sessionKey), delivers numbered text, isOpenFor(asker)=true', () => {
  const h = harness();
  h.q.onAsked(DM, askPayload());
  const r = h.rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'open');
  assert.equal(r[0].session_id, DM, 'session_id MUST equal the pm sessionKey (=chatJid) or answerQuestion misses');
  assert.equal(r[0].asker_jid, ASKER);
  assert.equal(h.delivered.length, 1);
  assert.match(h.delivered[0].text, /1\. Small[\s\S]*2\. Medium[\s\S]*3\. Large/);
  assert.equal(h.q.isOpenFor(DM, ASKER), true);
  assert.equal(h.q.isOpenFor(DM, '9999@lid'), false, 'a non-asker does not own the question');
});

test('DM answer unblocks: consume("2") → answerQuestion(sessionKey, toolCallId, {answers:[{header,selected:[label]}]}) + row answered', () => {
  const h = harness();
  h.q.onAsked(DM, askPayload());
  const out = h.q.consume({ chatJid: DM, text: '2' });
  assert.equal(out.ok, true);
  assert.equal(h.answers.length, 1);
  assert.equal(h.answers[0].sessionKey, DM);       // the exact resolve seam invariant
  assert.equal(h.answers[0].toolCallId, 'tc-1');
  assert.deepEqual(h.answers[0].result, { answers: [{ header: 'size', selected: ['Medium'] }] });
  assert.equal(h.rows()[0].status, 'answered');
});

test('consume is SYNCHRONOUS (never awaits a lock) — the no-deadlock invariant', () => {
  const h = harness();
  h.q.onAsked(DM, askPayload());
  const out = h.q.consume({ chatJid: DM, text: '1' });
  assert.ok(!(out instanceof Promise), 'consume must return synchronously, not a Promise');
});

// ── parser matrix ────────────────────────────────────────────────────────────
test('parser matrix: number / punctuation / embedded / label / multiSelect / free-text / out-of-range', () => {
  const q = { header: 'h', options: OPTS };
  assert.deepEqual(parseAnswer('2', q).answer.selected, ['Medium']);
  assert.deepEqual(parseAnswer('2.', q).answer.selected, ['Medium']);
  assert.deepEqual(parseAnswer('2)', q).answer.selected, ['Medium']);
  assert.deepEqual(parseAnswer("I'll take 2", q).answer.selected, ['Medium']);
  assert.deepEqual(parseAnswer('large', q).answer.selected, ['Large'], 'case-insensitive label');
  // multiSelect: several numbers
  assert.deepEqual(parseAnswer('1,3', { ...q, multiSelect: true }).answer.selected, ['Small', 'Large']);
  // NOT multiSelect: only the first number is taken
  assert.deepEqual(parseAnswer('1,3', q).answer.selected, ['Small']);
  // free-text (allowOther default true)
  const other = parseAnswer('actually XL please', q);
  assert.deepEqual(other.answer, { header: 'h', selected: [], other: 'actually XL please' });
  // out-of-range + allowOther:false → unparseable
  assert.equal(parseAnswer('9', { ...q, allowOther: false }).ok, false);
  assert.equal(parseAnswer('', q).ok, false);
});

test('parser: free-text that merely CONTAINS an option label is NOT coerced onto it (allowOther)', () => {
  const yn = { header: 'confirm', options: [{ label: 'Yes' }, { label: 'No' }] }; // allowOther default true
  // "not sure" ⊃ "no" and "know" ⊃ "no" — must fall through to free-text, not select "No".
  assert.deepEqual(parseAnswer('not sure', yn).answer, { header: 'confirm', selected: [], other: 'not sure' });
  assert.deepEqual(parseAnswer("I don't know yet", yn).answer, { header: 'confirm', selected: [], other: "I don't know yet" });
  // but a genuine prefix still matches, and an exact label still wins.
  assert.deepEqual(parseAnswer('ye', yn).answer.selected, ['Yes'], 'prefix "ye" → Yes preserved');
  assert.deepEqual(parseAnswer('no', yn).answer.selected, ['No'], 'exact "no" → No');
});

test('parser: a malformed option (null in the array) does not throw', () => {
  const q = { header: 'h', options: [{ label: 'A' }, null] };
  assert.doesNotThrow(() => parseAnswer('A', q));
  assert.deepEqual(parseAnswer('A', q).answer.selected, ['A']);
});

// ── sweep = the sole DM anti-wedge ───────────────────────────────────────────
test('sweep: an open question older than timeout → answerQuestion({timedout:true}) + row expired', () => {
  const h = harness();
  h.q.onAsked(DM, askPayload());
  h.q.sweep(); // not old yet
  assert.equal(h.answers.length, 0);
  h.clock.t += 5 * 60_000 + 1; // past the timeout
  h.q.sweep();
  assert.equal(h.answers.length, 1);
  assert.deepEqual(h.answers[0].result, { timedout: true });
  assert.equal(h.answers[0].sessionKey, DM);
  assert.equal(h.rows()[0].status, 'expired');
});

// ── abort ────────────────────────────────────────────────────────────────────
test('abort: expireChat marks the open row expired so the next message is not mis-consumed', () => {
  const h = harness();
  h.q.onAsked(DM, askPayload());
  assert.equal(h.q.isOpenFor(DM, ASKER), true);
  h.q.expireChat(DM);
  assert.equal(h.rows()[0].status, 'expired');
  assert.equal(h.q.isOpenFor(DM, ASKER), false);
});

// ── boot-expire ──────────────────────────────────────────────────────────────
test('boot-expire: open rows are expired WITHOUT answering (the bridge promise died with the old process)', () => {
  const h = harness();
  h.q.onAsked(DM, askPayload());
  h.q.expireOrphansAtBoot();
  assert.equal(h.rows()[0].status, 'expired');
  assert.equal(h.answers.length, 0, 'must NOT call answerQuestion on boot — nothing to resolve');
});

// ── concurrency ──────────────────────────────────────────────────────────────
test('one-open-per-chat: a concurrent second ask is cancelled, the first stays open', () => {
  const h = harness();
  h.q.onAsked(DM, askPayload());                                                       // tc-1 → open
  h.q.onAsked(DM, { chatId: DM, toolCallId: 'tc-2', questions: askPayload().questions }); // second → cancelled
  const cancels = h.answers.filter((a) => a.result?.cancelled);
  assert.ok(cancels.some((a) => a.toolCallId === 'tc-2'), 'second ask cancelled');
  assert.equal(h.rows().filter((r) => r.status === 'open').length, 1, 'exactly one open question');
});

test('TOCTOU: two concurrent answers → one answers, the loser falls through (not swallowed)', () => {
  const h = harness();
  h.q.onAsked(DM, askPayload());
  const a = h.q.consume({ chatJid: DM, text: '1' });
  const b = h.q.consume({ chatJid: DM, text: '3' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false, 'the second reply is not consumed — it falls through to normal gating');
  assert.equal(h.answers.length, 1);
});

// ── re-prompt ────────────────────────────────────────────────────────────────
test('re-prompt once then cancel: unparseable (no allowOther) reprompts, second failure cancels', () => {
  const h = harness();
  h.q.onAsked(DM, { chatId: DM, toolCallId: 'tc-1', questions: [{ header: 'h', question: 'pick', options: OPTS, allowOther: false }] });
  const first = h.q.consume({ chatJid: DM, text: 'nope' });
  assert.equal(first.ok, false);
  assert.equal(h.rows()[0].status, 'open', 'row reopened for the retry');
  assert.ok(h.delivered.some((d) => /didn't catch/i.test(d.text)), 're-prompted');
  assert.equal(h.answers.length, 0);
  const second = h.q.consume({ chatJid: DM, text: 'still nope' });
  assert.equal(second.ok, true);
  assert.equal(h.answers.length, 1);
  assert.equal(h.answers[0].result.cancelled, true);
  assert.equal(h.rows()[0].status, 'expired');
});

// ── multi-question truncation ────────────────────────────────────────────────
test('multi-question ask: v1 renders only the first + logs question-multi-truncated', () => {
  const h = harness();
  h.q.onAsked(DM, { chatId: DM, toolCallId: 'tc-1', questions: [
    { header: 'a', question: 'first?', options: OPTS },
    { header: 'b', question: 'second?', options: OPTS },
  ] });
  assert.equal(h.rows().length, 1);
  assert.match(h.delivered[0].text, /first\?/);
  assert.ok(!/second\?/.test(h.delivered[0].text));
  assert.ok(h.events.some((e) => e.kind === 'question-multi-truncated'));
});

// ── best-effort ──────────────────────────────────────────────────────────────
test('best-effort: a throwing pm.answerQuestion never throws out of onAsked/consume/sweep', () => {
  const h = harness({ pm: { answerQuestion: () => { throw new Error('boom'); } } });
  assert.doesNotThrow(() => h.q.onAsked(GROUP, { chatId: GROUP, toolCallId: 'g', questions: [{ question: 'x', options: OPTS }] }));
  h.q.onAsked(DM, askPayload());
  assert.doesNotThrow(() => h.q.consume({ chatJid: DM, text: '1' }));
  h.clock.t += 10 * 60_000;
  assert.doesNotThrow(() => h.q.sweep());
});

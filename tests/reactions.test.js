const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createReactionManager,
  classifyToolName,
  resolveEmoji,
  STATES,
} = require('../lib/feedback/reactions');

function makeHarness({ availableEmojis, throttleMs = 10 } = {}) {
  const applied = [];
  const m = createReactionManager({
    availableEmojis,
    throttleMs,
    apply: async (emoji) => { applied.push(emoji); },
  });
  return { m, applied };
}

describe('classifyToolName', () => {
  test('CODING for code/file tools', () => {
    for (const n of ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']) {
      assert.equal(classifyToolName(n), 'CODING');
    }
  });
  test('WEB for any Web* tool', () => {
    assert.equal(classifyToolName('WebFetch'), 'WEB');
    assert.equal(classifyToolName('WebSearch'), 'WEB');
  });
  test('WRITING for planning tools', () => {
    assert.equal(classifyToolName('TodoWrite'), 'WRITING');
    assert.equal(classifyToolName('Task'), 'WRITING');
  });
  test('TOOL as generic fallback', () => {
    assert.equal(classifyToolName('mcp__notion__create_page'), 'TOOL');
    assert.equal(classifyToolName(''), 'TOOL');
    assert.equal(classifyToolName(null), 'TOOL');
  });
  // 0.7.4 (item C): substring matching catches MCP/skill-prefixed tools
  // that the old regex-anchored classifier missed.
  test('substring match catches MCP browser/playwright tools as WEB', () => {
    assert.equal(classifyToolName('mcp__plugin_playwright__browser_click'), 'WEB');
    assert.equal(classifyToolName('mcp__plugin_playwright__browser_navigate'), 'WEB');
  });
  test('TodoWrite stays WRITING even though it contains "write"', () => {
    // Order-dependence guard: WRITING must check before CODING.
    assert.equal(classifyToolName('TodoWrite'), 'WRITING');
  });
  test('Skill tool maps to WRITING', () => {
    assert.equal(classifyToolName('Skill'), 'WRITING');
  });
});

describe('resolveEmoji', () => {
  test('no allowlist → first in chain', () => {
    assert.equal(resolveEmoji(STATES.CODING.chain), '👨‍💻');
  });
  test('walks chain when preferred not allowed', () => {
    const allowed = new Set(['🤔']);
    assert.equal(resolveEmoji(STATES.CODING.chain, allowed), '🤔');
  });
  test('returns null if nothing allowed', () => {
    assert.equal(resolveEmoji(STATES.CODING.chain, new Set(['🍌'])), null);
  });
});

describe('createReactionManager — state transitions', () => {
  test('applies immediately on first setState', async () => {
    const { m, applied } = makeHarness();
    m.setState('THINKING');
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(applied, ['🤔']);
  });

  test('skips apply when same emoji would be applied', async () => {
    const { m, applied } = makeHarness();
    m.setState('CODING');
    await new Promise(r => setTimeout(r, 5));
    m.setState('CODING');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(applied.length, 1);
  });

  test('throttles intermediate states into one flush', async () => {
    const { m, applied } = makeHarness({ throttleMs: 50 });
    m.setState('QUEUED');
    await new Promise(r => setTimeout(r, 5));
    // Flurry of updates inside the throttle window — only the last should flush.
    m.setState('THINKING');
    m.setState('CODING');
    m.setState('WEB');
    await new Promise(r => setTimeout(r, 80));
    // applied[0] is from the immediate QUEUED flush; applied[1] is the
    // throttled trailing flush which should end on WEB (the final state).
    assert.equal(applied[0], '👀');
    assert.equal(applied[applied.length - 1], '⚡');
  });

  test('terminal states bypass throttle', async () => {
    const { m, applied } = makeHarness({ throttleMs: 500 });
    m.setState('THINKING');
    await new Promise(r => setTimeout(r, 5));
    m.setState('DONE'); // should flush immediately, not wait 500ms
    await new Promise(r => setTimeout(r, 20));
    assert.ok(applied.includes('👍'));
  });

  test('COMPLETE (water-added) is terminal → ✅ flushes past throttle', async () => {
    const { m, applied } = makeHarness({ throttleMs: 500 });
    m.setState('THINKING');
    await new Promise(r => setTimeout(r, 5));
    m.setState('COMPLETE'); // handled-no-reply outcome — must flush immediately
    await new Promise(r => setTimeout(r, 20));
    assert.ok(applied.includes('✅'), 'COMPLETE flushes its ✅ without waiting on the throttle');
  });
});

describe('createReactionManager — clear + stop', () => {
  test('clear applies null to wipe reaction', async () => {
    const { m, applied } = makeHarness();
    m.setState('CODING');
    await new Promise(r => setTimeout(r, 5));
    await m.clear();
    assert.deepEqual(applied.slice(-2), ['👨‍💻', null]);
  });

  test('stop prevents further setState from firing', async () => {
    const { m, applied } = makeHarness({ throttleMs: 20 });
    m.setState('THINKING');
    m.stop();
    m.setState('DONE');
    await new Promise(r => setTimeout(r, 30));
    assert.ok(!applied.includes('👍'));
  });
});

describe('createReactionManager — availableEmojis filter', () => {
  test('picks fallback when preferred unavailable', async () => {
    const { m, applied } = makeHarness({
      availableEmojis: new Set(['🤔', '🥱']),
    });
    m.setState('CODING'); // 👨‍💻 not allowed → falls to 🤔
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(applied, ['🤔']);
  });

  test('no-ops cleanly if nothing in chain is allowed', async () => {
    const { m, applied } = makeHarness({
      availableEmojis: new Set(['🍌', '🎉']),
    });
    m.setState('CODING');
    await new Promise(r => setTimeout(r, 5));
    // No reaction could be resolved, nothing was applied. Same as "idle".
    assert.deepEqual(applied, []);
    assert.equal(m.currentEmoji, null);
  });

  // 0.7.4 (item J): generic fallback (👍/👀/🔥) when the state's chain
  // has nothing in the allowlist but a generic emoji is permitted. Better
  // to show *some* signal than none at all.
  test('falls back to generic 👍 for CODING when only 👍 allowed', async () => {
    const { m, applied } = makeHarness({
      availableEmojis: new Set(['👍']),
    });
    m.setState('CODING');
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(applied, ['👍']);
  });
});

describe('createReactionManager — stall timers (item A)', () => {
  test('promotes to STALL after stallMs of silence', async () => {
    const applied = [];
    const m = createReactionManager({
      apply: async (emoji) => { applied.push(emoji); },
      throttleMs: 5,
      stallMs: 30,
      freezeMs: 10_000, // far beyond test
    });
    m.setState('THINKING');
    await new Promise(r => setTimeout(r, 60));
    // Should have flushed 🤔, then auto-promoted to 🥱.
    assert.equal(applied[0], '🤔');
    assert.equal(applied[applied.length - 1], '🥱');
  });

  test('subsequent setState resets the stall clock', async () => {
    const applied = [];
    const m = createReactionManager({
      apply: async (emoji) => { applied.push(emoji); },
      throttleMs: 5,
      stallMs: 40,
      freezeMs: 10_000,
    });
    m.setState('THINKING');
    await new Promise(r => setTimeout(r, 25));  // < stallMs
    m.setState('CODING');                       // resets stall clock
    await new Promise(r => setTimeout(r, 25));  // < stallMs again
    // Should NOT have stalled — combined elapsed is 50ms but neither
    // window alone exceeded stallMs.
    assert.ok(!applied.includes('🥱'));
  });

  test('terminal state cancels pending stall', async () => {
    const applied = [];
    const m = createReactionManager({
      apply: async (emoji) => { applied.push(emoji); },
      throttleMs: 5,
      stallMs: 30,
      freezeMs: 10_000,
    });
    m.setState('THINKING');
    await new Promise(r => setTimeout(r, 10));
    m.setState('DONE');
    await new Promise(r => setTimeout(r, 50));
    assert.ok(!applied.includes('🥱'));
    assert.ok(applied.includes('👍'));
  });
});

// ─── B3: show progress while sub-agents run — suppress the stall/freeze cascade ──
// A working turn can sit quiet for minutes while a sub-agent does one long thing.
// The reactor was parked in a STALL_PROMOTABLE state (CODING/WEB/TOOL) and decayed
// to 🥱 (STALL) → 😨 (TIMEOUT), so a working turn looked dead. While work is in
// flight the silence is EXPECTED — hold the working face, don't decay.
// docs/progress-is-not-turn-end-spec.md (B3)
describe('B3: work-in-flight suppresses the stall/freeze cascade', () => {
  function makeR({ stallMs, freezeMs }) {
    const applied = [];
    const m = createReactionManager({
      availableEmojis: new Set(['👨‍💻', '🥱', '😨', '👾']),
      throttleMs: 5, stallMs, freezeMs,
      apply: async (e) => { applied.push(e); },
    });
    return { m, applied };
  }

  test('a working state does NOT decay to 🥱/😨 while a sub-agent runs', async () => {
    const { m, applied } = makeR({ stallMs: 20, freezeMs: 40 });
    m.setState('CODING');                 // 👨‍💻 — a STALL_PROMOTABLE state
    m.setWorkInFlight(true);              // a sub-agent is running
    await new Promise((r) => setTimeout(r, 70));   // > freezeMs
    assert.equal(m.currentEmoji, '👨‍💻',
      'a working turn must NOT show the stalled/frozen face while a sub-agent runs');
    assert.ok(!applied.includes('🥱') && !applied.includes('😨'),
      'the stall/freeze cascade is suppressed while work is in flight');
  });

  test('the normal cascade resumes once work drains', async () => {
    const { m } = makeR({ stallMs: 20, freezeMs: 10_000 });
    m.setState('CODING');
    m.setWorkInFlight(true);
    await new Promise((r) => setTimeout(r, 50));    // would have stalled if not suppressed
    assert.equal(m.currentEmoji, '👨‍💻', 'held working while in flight');
    m.setWorkInFlight(false);                       // sub-agent done — resume cascade
    await new Promise((r) => setTimeout(r, 45));    // > stallMs from release
    assert.equal(m.currentEmoji, '🥱', 'after work drains, the normal stall cascade resumes');
  });

  // Review MUST-FIX: two concurrent owners (a sub-agent AND an open question) must
  // not stomp each other — releasing one while the other still holds must NOT
  // resume the decay (a boolean latch did; owner-scoped doesn't).
  test('two owners do not stomp — the hold survives until the LAST owner releases', async () => {
    const { m } = makeR({ stallMs: 20, freezeMs: 10_000 });
    m.setState('CODING');
    m.setWorkInFlight(true, 'subagent');
    m.setWorkInFlight(true, 'question');
    m.setWorkInFlight(false, 'question');           // question answered, sub-agent still running
    await new Promise((r) => setTimeout(r, 50));    // > stallMs
    assert.equal(m.currentEmoji, '👨‍💻', 'still held — the sub-agent owner remains, no decay');
    m.setWorkInFlight(false, 'subagent');           // last owner releases
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(m.currentEmoji, '🥱', 'only after the LAST owner releases does the cascade resume');
  });
});

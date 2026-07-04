'use strict';

// Gated real-claude E2E: proves the copied session engine round-trips a WhatsApp
// message through a real claude TUI + the channels bridge + water's tool-dispatcher.
// Skipped unless E2E_REAL_CLAUDE=1 (needs the vendored pinned claude + tmux; not CI).
//
//   E2E_REAL_CLAUDE=1 node --test tests/e2e-session-engine.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const RUN = process.env.E2E_REAL_CLAUDE === '1';

test('real claude: inject WhatsApp msg → reply round-trips through the bridge', { skip: !RUN ? 'set E2E_REAL_CLAUDE=1' : false }, () => {
  const spike = path.join(__dirname, '..', 'scripts', 'spikes', 'prove-session-engine.mjs');
  const r = spawnSync('node', [spike], { encoding: 'utf8', timeout: 170_000 });
  process.stderr.write(r.stdout?.split('\n').filter((l) => l.includes('RESULT') || l.includes('TOOL reply')).join('\n') + '\n');
  assert.equal(r.status, 0, `proof spike failed (exit ${r.status})`);
  assert.match(r.stdout || '', /RESULT: PASS/);
});

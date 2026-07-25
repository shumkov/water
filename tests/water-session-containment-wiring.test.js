'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'water.js'), 'utf8');

describe('water session containment wiring', () => {
  test('passes the configured launcher path explicitly to the process factory', () => {
    assert.match(
      src,
      /const sessionLauncher = process\.env\.ORCHESTRA_SESSION_LAUNCHER;/,
    );
    assert.match(
      src,
      /const factory = createProcessFactory\(\{[\s\S]*?\n\s+sessionLauncher,/,
    );
  });

  test('requires exactly "1" and passes the flag to every tmux runner', () => {
    assert.match(
      src,
      /const requireExistingServer = process\.env\.ORCHESTRA_TMUX_REQUIRE_SERVER === '1';/,
    );
    const runnerCalls = [...src.matchAll(/createTmuxRunner\(\{([^}]*)\}\)/g)];
    assert.equal(runnerCalls.length, 1);
    assert.match(runnerCalls[0][1], /\brequireExistingServer\b/);
  });

  test('logs only whether the launcher is configured, never its path', () => {
    const log = src.match(/logger\.log\?\.\(`\[water\] session containment[^`]*`\);/)?.[0];
    assert.ok(log, 'daemon construction must report containment configuration');
    assert.match(log, /\$\{sessionLauncher \? 'yes' : 'no'\}/);
    assert.doesNotMatch(log, /\$\{sessionLauncher\}/);
    assert.doesNotMatch(log, /ORCHESTRA_SESSION_LAUNCHER/);
  });
});

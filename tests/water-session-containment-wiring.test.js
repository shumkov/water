'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'water.js'), 'utf8');

describe('water session containment wiring', () => {
  test('pins the production-compatible Orchestra release exactly', () => {
    const declared = require('../package.json').dependencies['@shumkov/orchestra'];
    const installed = require('@shumkov/orchestra/package.json').version;
    assert.equal(declared, '0.10.6');
    assert.equal(installed, '0.10.6');
  });

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

  test('passes the configured socket independently to every tmux runner', () => {
    assert.match(
      src,
      /const tmuxSocketName = process\.env\.ORCHESTRA_TMUX_SOCKET \|\| null;/,
    );
    const runnerCalls = [...src.matchAll(/createTmuxRunner\(\{([^}]*)\}\)/g)];
    assert.equal(runnerCalls.length, 1);
    assert.match(runnerCalls[0][1], /\bsocketName: tmuxSocketName\b/);
  });

  test('logs only configured states, never launcher paths or socket names', () => {
    const log = src.match(/logger\.log\?\.\(`\[water\] session containment[^`]*`\);/)?.[0];
    assert.ok(log, 'daemon construction must report containment configuration');
    assert.match(log, /\$\{sessionLauncher \? 'yes' : 'no'\}/);
    assert.match(log, /\$\{tmuxSocketName \? 'yes' : 'no'\}/);
    assert.doesNotMatch(log, /\$\{sessionLauncher\}/);
    assert.doesNotMatch(log, /\$\{tmuxSocketName\}/);
    assert.doesNotMatch(log, /ORCHESTRA_SESSION_LAUNCHER/);
    assert.doesNotMatch(log, /ORCHESTRA_TMUX_SOCKET/);
  });
});

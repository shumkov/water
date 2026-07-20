'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../bin/water-doctor');

function setupDataDir({ heartbeat } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-doctor-'));
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    accounts: { test: { wuzapi: { baseUrl: 'http://127.0.0.1:1' }, webhook: { port: 8090 } } },
  }));
  if (heartbeat !== undefined) {
    fs.writeFileSync(path.join(dataDir, 'heartbeat.json'), JSON.stringify(heartbeat));
  }
  return { dataDir, configPath };
}

function find(checks, name) { return checks.find((c) => c.name === name); }

test('water-doctor: auth-disabled check fails when heartbeat.json authDisabled > 0', async () => {
  const { dataDir, configPath } = setupDataDir({ heartbeat: { authDisabled: 2 } });
  const checks = await run({ account: 'test', configPath, dataDir });
  const c = find(checks, 'auth-disabled');
  assert.ok(c, 'a check named auth-disabled must be reported');
  assert.equal(c.ok, false);
});

test('water-doctor: auth-disabled check passes when heartbeat.json authDisabled is 0', async () => {
  const { dataDir, configPath } = setupDataDir({ heartbeat: { authDisabled: 0 } });
  const checks = await run({ account: 'test', configPath, dataDir });
  const c = find(checks, 'auth-disabled');
  assert.equal(c.ok, true);
});

test('water-doctor: auth-disabled check passes when the field is absent (back-compat with an old heartbeat.json)', async () => {
  const { dataDir, configPath } = setupDataDir({ heartbeat: { pending: 0 } });
  const checks = await run({ account: 'test', configPath, dataDir });
  const c = find(checks, 'auth-disabled');
  assert.equal(c.ok, true);
});

test('water-doctor: auth-disabled check fails closed when heartbeat.json is missing', async () => {
  const { dataDir, configPath } = setupDataDir({}); // no heartbeat.json written
  const checks = await run({ account: 'test', configPath, dataDir });
  const c = find(checks, 'auth-disabled');
  assert.equal(c.ok, false);
});

test('water-doctor: auth-disabled check fails closed when heartbeat.json is corrupt JSON', async () => {
  const { dataDir, configPath } = setupDataDir({});
  fs.writeFileSync(path.join(dataDir, 'heartbeat.json'), '{not valid json');
  const checks = await run({ account: 'test', configPath, dataDir });
  const c = find(checks, 'auth-disabled');
  assert.equal(c.ok, false);
});

test('water-doctor: auth-disabled check treats a stringified count the same as a number (no false failure)', async () => {
  const { dataDir, configPath } = setupDataDir({ heartbeat: { authDisabled: '0' } });
  const checks = await run({ account: 'test', configPath, dataDir });
  const c = find(checks, 'auth-disabled');
  assert.equal(c.ok, true, 'a stringified "0" must not be treated as a truthy non-zero count');
});

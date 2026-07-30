'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const ipcServer = require('../lib/ipc/server');

const cli = path.join(__dirname, '..', 'bin', 'water-ipc.js');

test('the declared water-ipc executable exists and gives bounded usage on missing args', () => {
  assert.equal(fs.existsSync(cli), true, 'package.json declares bin/water-ipc.js, so the file must ship');
  assert.notEqual(fs.statSync(cli).mode & 0o100, 0, 'the declared CLI must be owner-executable');
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: water-ipc <account> (?:ping|busy)/i);
  assert.doesNotMatch(result.stderr, /secret|jid|session/i);
});

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function runtimeFixture() {
  const root = process.env.WATER_TEST_NON_TEMP_ROOT || process.cwd();
  const dir = fs.mkdtempSync(path.join(root, '.wi-'));
  fs.chmodSync(dir, 0o700);
  return { dir, runtimeDir: dir };
}

test('busy prints only the safe aggregate, not the transport envelope', async () => {
  const { dir, runtimeDir } = runtimeFixture();
  const options = { cwd: dir, env: { WATER_IPC_DIR: runtimeDir } };
  const secret = ipcServer.writeSecret('umi', options);
  const server = await ipcServer.start({
    path: ipcServer.socketPathFor('umi', options),
    secret,
    logger: { log() {}, error() {} },
    handlers: { busy: async () => ({ account: 'umi', in_flight: 2 }) },
  });
  try {
    const result = await runCli(['umi', 'busy'], { WATER_IPC_DIR: runtimeDir });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim(), '{"account":"umi","in_flight":2}');
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('busy connection failures are bounded and never reveal filesystem paths', async () => {
  const { dir, runtimeDir } = runtimeFixture();
  try {
    const result = await runCli(['umi', 'busy'], { WATER_IPC_DIR: runtimeDir });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'water-ipc: busy unavailable');
    assert.doesNotMatch(result.stderr, new RegExp(runtimeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.stderr, /sock|secret|ENOENT/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

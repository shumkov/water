'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ipcServer = require('../lib/ipc/server');
const ipcClient = require('../lib/ipc/client');

const silentLogger = { log() {}, error() {} };
let server = null;

function fixture() {
  const root = process.env.WATER_TEST_NON_TEMP_ROOT || process.cwd();
  return fs.mkdtempSync(path.join(root, '.wi-'));
}

async function closeServer() {
  if (server) await server.close();
  server = null;
}

describe('Water IPC runtime paths', () => {
  test('client and server share one owner-only non-temporary namespace', () => {
    const cwd = fixture();
    try {
      const options = { cwd, env: {} };
      assert.equal(ipcServer.runtimeDirectory(options), path.join(cwd, '.ipc'));
      assert.equal(ipcClient.runtimeDirectory(options), path.join(cwd, '.ipc'));
      assert.equal(
        ipcServer.socketPathFor('umi', options),
        ipcClient.socketPathFor('umi', options),
      );
      assert.equal(
        ipcServer.secretPathFor('umi', options),
        ipcClient.secretPathFor('umi', options),
      );
      assert.equal(
        ipcClient.polygramSocketPathFor('shumabit', {
          cwd,
          env: { POLYGRAM_IPC_DIR: cwd },
        }),
        path.join(cwd, 'polygram-shumabit.sock'),
      );
      assert.notEqual(
        ipcClient.polygramSocketPathFor('umi', {
          cwd,
          env: { POLYGRAM_IPC_DIR: cwd },
        }),
        ipcClient.socketPathFor('umi', options),
        'Water daemon IPC and Polygram escalation IPC keep distinct namespaces',
      );
      assert.doesNotMatch(ipcServer.socketPathFor('umi', options), /^\/(?:private\/)?tmp\//);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('Polygram escalation requires an explicit canonical runtime directory', () => {
    const cwd = fixture();
    try {
      assert.throws(
        () => ipcClient.polygramSocketPathFor('shumabit', { cwd, env: {} }),
        (error) => {
          assert.equal(error.code, 'POLYGRAM_IPC_DIR_REQUIRED');
          assert.equal(error.message, 'POLYGRAM_IPC_DIR is required for Polygram escalation');
          assert.doesNotMatch(error.message, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return true;
        },
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('creates the runtime directory 0700 and secret 0600', () => {
    const cwd = fixture();
    try {
      const options = { cwd, env: {} };
      const runtimeDir = ipcServer.ensureRuntimeDirectory(options);
      assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o700);
      ipcServer.writeSecret('umi', options);
      assert.equal(fs.statSync(ipcServer.secretPathFor('umi', options)).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('rejects temporary roots, symlinks, unsafe modes, hostile account names, and long sockets', () => {
    assert.throws(
      () => ipcServer.runtimeDirectory({ cwd: os.tmpdir(), env: {} }),
      /temporary/i,
    );

    const cwd = fixture();
    try {
      const target = path.join(cwd, 'target');
      const link = path.join(cwd, 'link');
      const broad = path.join(cwd, 'broad');
      fs.mkdirSync(target, { mode: 0o700 });
      fs.symlinkSync(target, link);
      fs.mkdirSync(broad, { mode: 0o755 });
      assert.throws(
        () => ipcServer.runtimeDirectory({ cwd, env: { WATER_IPC_DIR: link } }),
        /symlink|canonical/i,
      );
      assert.throws(
        () => ipcServer.runtimeDirectory({ cwd, env: { WATER_IPC_DIR: broad } }),
        /0700/i,
      );
      for (const account of ['', '.', '..', '../other', 'nested/account', 'x'.repeat(65)]) {
        assert.throws(() => ipcServer.socketPathFor(account, { cwd, env: {} }), /account name/i);
      }

      const longParent = path.join(cwd, 'x'.repeat(80));
      const runtimeDir = path.join(longParent, 'ipc');
      fs.mkdirSync(longParent, { mode: 0o700 });
      fs.mkdirSync(runtimeDir, { mode: 0o700 });
      assert.throws(
        () => ipcServer.socketPathFor('umi', { cwd, env: { WATER_IPC_DIR: runtimeDir } }),
        /socket path.*limit/i,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('Water IPC authenticated round trip', () => {
  afterEach(closeServer);

  test('busy is secret-authenticated and returns only an aggregate summary', async () => {
    const cwd = fixture();
    try {
      const options = { cwd, env: {} };
      const secret = ipcServer.writeSecret('umi', options);
      const socketPath = ipcServer.socketPathFor('umi', options);
      server = await ipcServer.start({
        path: socketPath,
        secret,
        logger: silentLogger,
        handlers: {
          ping: async () => ({ pong: true }),
          busy: async () => ({ account: 'umi', in_flight: 2 }),
        },
      });

      const rejected = await ipcClient.call({ path: socketPath, op: 'busy', secret: 'wrong' });
      assert.deepEqual(rejected, { id: null, ok: false, error: 'auth' });

      const result = await ipcClient.call({ path: socketPath, op: 'busy', secret });
      assert.deepEqual(result, { id: null, ok: true, account: 'umi', in_flight: 2 });
      assert.equal(JSON.stringify(result).includes('session'), false);
      assert.equal(JSON.stringify(result).includes('@'), false);
    } finally {
      await closeServer();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('Telegram escalation still resolves the Polygram namespace', async () => {
    const cwd = fixture();
    try {
      const runtimeDir = cwd;
      const options = {
        cwd,
        env: { POLYGRAM_IPC_DIR: runtimeDir },
      };
      const secret = 'polygram-secret';
      fs.writeFileSync(
        ipcClient.polygramSecretPathFor('shumabit', options),
        secret,
        { mode: 0o600 },
      );
      server = await ipcServer.start({
        path: ipcClient.polygramSocketPathFor('shumabit', options),
        secret,
        logger: silentLogger,
        handlers: {
          send: async (req) => ({
            result: { delivered: req.method === 'sendMessage' },
          }),
        },
      });

      const result = await ipcClient.tell(
        'shumabit',
        'sendMessage',
        { chat_id: 'operator', text: 'health alert' },
        { ...options, source: 'water:test' },
      );
      assert.deepEqual(result, { delivered: true });
    } finally {
      await closeServer();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, validateConfig, scopeToAccount, resolveChat, ConfigError } =
  require('../lib/config');

function base() {
  return {
    accounts: {
      umi: {
        wuzapi: { baseUrl: 'http://127.0.0.1:8099' },
        webhook: { port: 8090 },
        dmPolicy: 'allowlist',
        groupPolicy: 'allowlist',
        adminJids: ['1@s.whatsapp.net'],
        escalation: { ipcBot: 'shumabit', chatId: '68861949' },
        ackReaction: { dm: 'always', group: 'mentions' },
        processBudget: 9,
      },
    },
    chats: {
      '120363419377779909@g.us': {
        name: 'Umi sales', account: 'umi', agent: 'umi-partner', cwd: '/x',
        requireMention: true, mentionPatterns: ['\\bumi\\b'],
        maxTurn: 600000, maxTurnHard: 5400000,
      },
    },
    defaults: { model: 'sonnet', effort: 'medium', maxTurn: 600000, maxTurnHard: 5400000 },
  };
}

test('a valid config passes', () => {
  assert.doesNotThrow(() => validateConfig(base()));
});

test('the shipped config.example.json is valid', () => {
  const p = path.join(__dirname, '..', 'config.example.json');
  // example uses placeholder JIDs; validation only checks JID *shape* on chat keys.
  assert.doesNotThrow(() => loadConfig(p));
});

test('rejects missing accounts', () => {
  assert.throws(() => validateConfig({ chats: {} }), ConfigError);
});

test('rejects a chat pointing at an undefined account', () => {
  const c = base();
  c.chats['120363419377779909@g.us'].account = 'ghost';
  assert.throws(() => validateConfig(c), /not a defined account/);
});

test('rejects a non-JID chat key', () => {
  const c = base();
  c.chats['not-a-jid'] = { account: 'umi' };
  assert.throws(() => validateConfig(c), /must be a WhatsApp JID/);
});

test('rejects a bad mentionPatterns regex', () => {
  const c = base();
  c.chats['120363419377779909@g.us'].mentionPatterns = ['('];
  assert.throws(() => validateConfig(c), /bad regex/);
});

test('rejects an unknown dmPolicy', () => {
  const c = base();
  c.accounts.umi.dmPolicy = 'open';
  assert.throws(() => validateConfig(c), /dmPolicy/);
});

test('rejects maxTurnHard < maxTurn', () => {
  const c = base();
  c.chats['120363419377779909@g.us'].maxTurnHard = 1000;
  assert.throws(() => validateConfig(c), /maxTurnHard must be >= maxTurn/);
});

test('rejects a bad ackReaction mode', () => {
  const c = base();
  c.accounts.umi.ackReaction.group = 'sometimes';
  assert.throws(() => validateConfig(c), /ackReaction/);
});

test('scopeToAccount narrows chats to the account', () => {
  const c = base();
  c.accounts.other = { wuzapi: { baseUrl: 'x' }, webhook: { port: 8091 } };
  c.chats['9@s.whatsapp.net'] = { account: 'other', name: 'x' };
  const scoped = scopeToAccount(c, 'umi');
  assert.deepEqual(Object.keys(scoped.chats), ['120363419377779909@g.us']);
});

test('resolveChat layers defaults and defaults requireMention true', () => {
  const scoped = scopeToAccount(base(), 'umi');
  const chat = resolveChat(scoped, '120363419377779909@g.us');
  assert.equal(chat.model, 'sonnet');
  assert.equal(chat.maxTurnHard, 5400000);
  assert.equal(chat.requireMention, true);
  assert.equal(resolveChat(scoped, 'nope@g.us'), null);
});

test('resolveChat defaults maxTurnHard to maxTurn when unset', () => {
  const c = base();
  delete c.chats['120363419377779909@g.us'].maxTurnHard;
  delete c.defaults.maxTurnHard;
  const scoped = scopeToAccount(c, 'umi');
  const chat = resolveChat(scoped, '120363419377779909@g.us');
  assert.equal(chat.maxTurnHard, 600000);
});

test('loadConfig throws ConfigError on missing file', () => {
  assert.throws(() => loadConfig('/no/such/config.json'), ConfigError);
});

test('loadConfig throws ConfigError on bad JSON', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'water-cfg-')), 'c.json');
  fs.writeFileSync(p, '{ not json');
  assert.throws(() => loadConfig(p), /not valid JSON/);
});

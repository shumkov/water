// provenance: polygram@0.17.10 lib/config.js + config-scope.js (git dcceff6) — adapt:
// WhatsApp shape (accounts/chats/policies), no Telegram bots/topics. Load, validate
// fail-loud, and narrow to a single --account at boot. See SPEC §12.

'use strict';

const fs = require('node:fs');

const POLICIES = new Set(['allowlist']); // v1: allowlist only (open/pairing are roadmap)
const ACK_MODES = new Set(['never', 'mentions', 'always']);

class ConfigError extends Error {}

function req(cond, msg) {
  if (!cond) throw new ConfigError(msg);
}

// Responsiveness feedback (typing + reaction cascade) — see docs/FEEDBACK_SPEC.md.
// Valid at account and chat level. Fail-loud on a typo so a misspelt policy can't
// silently disable the feature.
function validateFeedback(fb, at) {
  if (fb === undefined) return;
  req(fb && typeof fb === 'object', `${at}.feedback must be an object`);
  if (fb.typing !== undefined) {
    req(fb.typing && typeof fb.typing === 'object', `${at}.feedback.typing must be an object`);
    if (fb.typing.enabled !== undefined) req(typeof fb.typing.enabled === 'boolean', `${at}.feedback.typing.enabled must be boolean`);
  }
  if (fb.ackReaction !== undefined) {
    req(fb.ackReaction && typeof fb.ackReaction === 'object', `${at}.feedback.ackReaction must be an object`);
    for (const k of Object.keys(fb.ackReaction)) {
      req(k === 'dm' || k === 'group', `${at}.feedback.ackReaction.${k} — only dm/group are allowed`);
      req(ACK_MODES.has(fb.ackReaction[k]), `${at}.feedback.ackReaction.${k} must be never|mentions|always`);
    }
  }
}

// Validate the whole config object; throw ConfigError on the first problem so a
// typo fails boot loudly rather than silently mis-serving (polygram's apiRoot lesson).
function validateConfig(cfg) {
  req(cfg && typeof cfg === 'object', 'config must be an object');
  req(cfg.accounts && typeof cfg.accounts === 'object', 'config.accounts is required');
  req(Object.keys(cfg.accounts).length > 0, 'config.accounts must have at least one account');

  for (const [name, acc] of Object.entries(cfg.accounts)) {
    const at = `accounts.${name}`;
    req(acc && typeof acc === 'object', `${at} must be an object`);
    req(acc.wuzapi && typeof acc.wuzapi.baseUrl === 'string', `${at}.wuzapi.baseUrl is required`);
    req(Number.isInteger(acc.webhook?.port), `${at}.webhook.port must be an integer`);
    req(POLICIES.has(acc.dmPolicy ?? 'allowlist'), `${at}.dmPolicy must be "allowlist"`);
    req(POLICIES.has(acc.groupPolicy ?? 'allowlist'), `${at}.groupPolicy must be "allowlist"`);
    if (acc.adminJids !== undefined) {
      req(Array.isArray(acc.adminJids), `${at}.adminJids must be an array`);
    }
    validateFeedback(acc.feedback, at);
    const esc = acc.escalation;
    if (esc !== undefined) {
      req(typeof esc.ipcBot === 'string' && typeof esc.chatId === 'string',
        `${at}.escalation needs {ipcBot, chatId}`);
    }
    if (acc.processBudget !== undefined) {
      req(Number.isInteger(acc.processBudget) && acc.processBudget > 0,
        `${at}.processBudget must be a positive integer`);
    }
  }

  const chats = cfg.chats ?? {};
  req(typeof chats === 'object', 'config.chats must be an object');
  for (const [jid, chat] of Object.entries(chats)) {
    const at = `chats.${jid}`;
    req(chat && typeof chat === 'object', `${at} must be an object`);
    req(typeof chat.account === 'string', `${at}.account is required`);
    req(cfg.accounts[chat.account], `${at}.account "${chat.account}" is not a defined account`);
    req(/@(g\.us|s\.whatsapp\.net|lid|c\.us)$/.test(jid), `${at}: chat key must be a WhatsApp JID`);
    if (chat.requireMention !== undefined) req(typeof chat.requireMention === 'boolean', `${at}.requireMention must be boolean`);
    if (chat.mentionPatterns !== undefined) {
      req(Array.isArray(chat.mentionPatterns), `${at}.mentionPatterns must be an array`);
      for (const p of chat.mentionPatterns) {
        try { new RegExp(p, 'i'); } catch (e) { throw new ConfigError(`${at}.mentionPatterns: bad regex ${p}: ${e.message}`); }
      }
    }
    if (chat.allowFrom !== undefined) req(Array.isArray(chat.allowFrom), `${at}.allowFrom must be an array`);
    validateFeedback(chat.feedback, at);
    for (const f of ['maxTurn', 'maxTurnHard']) {
      if (chat[f] !== undefined) req(Number.isInteger(chat[f]) && chat[f] > 0, `${at}.${f} must be a positive integer (ms)`);
    }
    if (chat.maxTurn && chat.maxTurnHard) {
      req(chat.maxTurnHard >= chat.maxTurn, `${at}.maxTurnHard must be >= maxTurn`);
    }
  }
  return cfg;
}

function loadConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config at ${configPath}: ${e.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`config at ${configPath} is not valid JSON: ${e.message}`);
  }
  return validateConfig(cfg);
}

// Narrow the config to one account: its own block + the chats that belong to it.
// Mirrors polygram's per-bot scoping so one process serves exactly one account.
function scopeToAccount(cfg, account) {
  req(cfg.accounts[account], `unknown account "${account}"`);
  const chats = Object.fromEntries(
    Object.entries(cfg.chats ?? {}).filter(([, c]) => c.account === account),
  );
  return {
    account,
    accountConfig: cfg.accounts[account],
    chats,
    defaults: cfg.defaults ?? {},
  };
}

// Effective per-chat settings: chat entry over account/defaults for the shared knobs.
function resolveChat(scoped, chatJid) {
  const chat = scoped.chats[chatJid];
  if (!chat) return null;
  const d = scoped.defaults;
  return {
    ...chat,
    model: chat.model ?? d.model,
    effort: chat.effort ?? d.effort,
    maxTurn: chat.maxTurn ?? d.maxTurn,
    maxTurnHard: chat.maxTurnHard ?? d.maxTurnHard ?? chat.maxTurn ?? d.maxTurn,
    requireMention: chat.requireMention ?? true,
  };
}

module.exports = { loadConfig, validateConfig, scopeToAccount, resolveChat, ConfigError };

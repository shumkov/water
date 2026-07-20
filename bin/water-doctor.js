#!/usr/bin/env node
// water-doctor — operational diagnostics (SPEC §4.5). Runs static checks without
// touching live chats; exit 0 on pass, 1 on any failure (for the 5-min cron + netdata).
//
//   water-doctor --account umi [--config path] [--data-dir dir] [--json]

'use strict';

const path = require('node:path');
const fs = require('node:fs');

async function run({ account, configPath, dataDir }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  let config, scoped, acc;
  try {
    const { loadConfig, scopeToAccount } = require('../lib/config');
    config = loadConfig(configPath);
    scoped = scopeToAccount(config, account);
    acc = scoped.accountConfig;
    add('config', true, `${Object.keys(scoped.chats).length} chat(s)`);
  } catch (e) { add('config', false, e.message); return checks; }

  // DB schema
  try {
    const { openDb, listMigrations } = require('../lib/db');
    const db = openDb(path.join(dataDir, `${account}.db`));
    const v = db.pragma('user_version', { simple: true });
    add('db', v === listMigrations().at(-1).num, `schema v${v}`);
    const stalePending = db.prepare("SELECT COUNT(*) c FROM messages WHERE direction='out' AND status='pending'").get().c;
    add('pending-outbound', stalePending === 0, `${stalePending} stale pending`);
    const nonTerminalSla = db.prepare("SELECT COUNT(*) c FROM messages m WHERE m.direction='in' AND m.handler_status='dispatched' AND NOT EXISTS (SELECT 1 FROM turn_metrics t WHERE t.chat_jid=m.chat_jid AND t.msg_id=m.msg_id)").get().c;
    add('sla', nonTerminalSla === 0, `${nonTerminalSla} unanswered dispatched`);
    db.close();
  } catch (e) { add('db', false, e.message); }

  // vendored claude binary
  try {
    const { ensureVendoredClaudeBin, CLAUDE_CLI_PINNED_VERSION } = require('../lib/claude-bin');
    const v = ensureVendoredClaudeBin(CLAUDE_CLI_PINNED_VERSION);
    add('claude-bin', v.ok, v.ok ? `pinned ${CLAUDE_CLI_PINNED_VERSION}` : v.reason);
  } catch (e) { add('claude-bin', false, e.message); }

  // heartbeat freshness
  try {
    const hb = path.join(dataDir, 'heartbeat.json');
    const stat = fs.statSync(hb);
    const ageS = (Date.now() - stat.mtimeMs) / 1000;
    add('heartbeat', ageS < 300, `${Math.round(ageS)}s old`);
  } catch { add('heartbeat', false, 'heartbeat.json missing (daemon not running?)'); }

  // auth-disabled (SPEC: docs/AUTH_DISABLED_HANDLING_SPEC.md) — heartbeat.json's authDisabled
  // counter is not by itself netdata-visible (/healthz's 200/503 is staleness-only, not
  // field-based), so this check's non-zero exit is what actually makes the 5-min cron page.
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(dataDir, 'heartbeat.json'), 'utf8'));
    const n = Number(hb.authDisabled) || 0;
    add('auth-disabled', n === 0, n === 0 ? 'no recent auth-disabled outage' : `${n} auth-disabled turn(s) in the last hour — Claude Code access may be disabled, check the Anthropic Console`);
  } catch { add('auth-disabled', false, 'heartbeat.json missing/unreadable (daemon not running?)'); }

  // wuzapi reachability (best-effort; loopback)
  try {
    const { createTransport } = require('../lib/transport/client');
    const t = createTransport({ baseUrl: acc.wuzapi.baseUrl, userToken: acc.wuzapi.userToken, timeoutMs: 5000 });
    const st = await t.sessionStatus();
    add('wuzapi', !!st, st?.loggedIn ? 'connected + loggedIn' : `connected=${st?.connected} loggedIn=${st?.loggedIn}`);
  } catch (e) { add('wuzapi', false, e.message); }

  return checks;
}

function parseArgs(argv) {
  const a = { account: null, configPath: null, dataDir: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account') a.account = argv[++i];
    else if (argv[i] === '--config') a.configPath = argv[++i];
    else if (argv[i] === '--data-dir') a.dataDir = argv[++i];
    else if (argv[i] === '--json') a.json = true;
  }
  if (!a.configPath) a.configPath = path.join(a.dataDir, 'config.json');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.account) { console.error('water-doctor: --account required'); process.exit(2); }
  const checks = await run(args);
  const fails = checks.filter((c) => !c.ok);
  if (args.json) {
    console.log(JSON.stringify({ ok: fails.length === 0, checks }, null, 2));
  } else {
    for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name} — ${c.detail}`);
    console.log(`\n${checks.length - fails.length} ok / ${fails.length} fail  (account=${args.account})`);
  }
  process.exit(fails.length === 0 ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error('water-doctor fatal:', e.message); process.exit(1); });
module.exports = { run, parseArgs };

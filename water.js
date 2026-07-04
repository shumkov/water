#!/usr/bin/env node
// provenance: polygram@0.17.11 polygram.js main() (git 746bca6) — adapt (rewrite):
// water's daemon. One process per WhatsApp account. Wires the WuzAPI transport edge
// (webhook receiver in, REST client out) to the durable SQLite inbox, the access gate,
// and the proven Claude session engine (ProcessManager + CliProcess + channels bridge).
// See docs/SPEC.md §3-§4.

'use strict';

const path = require('node:path');
const { loadConfig, scopeToAccount, resolveChat } = require('./lib/config');
const { openDb } = require('./lib/db');
const { createTransport } = require('./lib/transport/client');
const { createReceiver } = require('./lib/transport/webhook-receiver');
const { createOutbound } = require('./lib/db/outbound');
const { createJidMap } = require('./lib/db/jid-map');
const { createSessions } = require('./lib/db/sessions');
const { createHandlerStatus } = require('./lib/db/handler-status');
const { createRecordInbound } = require('./lib/handlers/record-inbound');
const { createGate } = require('./lib/handlers/gate');
const { createDispatcher } = require('./lib/handlers/dispatcher');
const { createChannelsToolDispatcher } = require('./lib/process/channels-tool-dispatcher');
const { chunkMarkdownText } = require('./lib/delivery/chunk');
const { toWhatsApp } = require('./lib/delivery/format');
const { WATER_DISPLAY_HINT } = require('./lib/delivery/display-hint');
// The Claude session engine — extracted shared library (docs/SHARED-LIB.md).
const { createTmuxRunner, createProcessFactory, ProcessManager, claudeBin } = require('@shumkov/orchestra');
const { ensureVendoredClaudeBin, CLAUDE_CLI_PINNED_VERSION } = claudeBin;
const { classify } = require('./lib/error/classify');
const { createEscalator } = require('./lib/ops/escalate');
const { createSlaWatchdog } = require('./lib/ops/sla-watchdog');
const { createTransportWatchdog } = require('./lib/ops/transport-watchdog');
const { createHeartbeat } = require('./lib/ops/heartbeat');
const ipcServer = require('./lib/ipc/server');

// Assemble a daemon for one account. Returns { start, stop } so tests can drive it
// with injected transport/logger without opening real sockets.
function createDaemon({ config, account, dataDir, logger = console, transport: injectedTransport, botIdentity: injectedBotIdentity } = {}) {
  const scoped = scopeToAccount(config, account);
  const acc = scoped.accountConfig;
  const dbPath = path.join(dataDir, `${account}.db`);
  const db = openDb(dbPath);

  const transport = injectedTransport || createTransport({ baseUrl: acc.wuzapi.baseUrl, userToken: acc.wuzapi.userToken, logger });
  const outbound = createOutbound(db, { botJid: acc.botJid || 'me' });
  const jidMap = createJidMap(db);
  const sessions = createSessions(db);
  const status = createHandlerStatus(db);
  const recordInbound = createRecordInbound(db, { logger });
  const resolve = (jid) => resolveChat(scoped, jid);

  // Boot sweeps: any pending outbound is a prior-life crash orphan.
  outbound.sweepCrashed();
  // Mark still-in-flight rows replay-pending happens at shutdown; boot replay runs in start().

  // Delivery: the tool-dispatcher claude calls mid-turn (reply/edit/react).
  const toolDispatcher = createChannelsToolDispatcher({
    transport, outbound, account,
    chunkText: chunkMarkdownText, formatText: toWhatsApp,
    logEvent: (kind, detail) => logEvent(kind, detail), logger,
  });

  // Session engine: pinned+vendored claude, tmux, cli backend.
  const vendored = ensureVendoredClaudeBin(CLAUDE_CLI_PINNED_VERSION);
  if (!vendored.ok) throw new Error(`water: claude binary unavailable: ${vendored.reason}`);
  const tmuxRunner = createTmuxRunner({ logger });
  const factory = createProcessFactory({
    config: { chats: scoped.chats, bot: { pm: 'cli' } },
    tmuxRunner, botName: account, toolDispatcher, channelsClaudeBin: vendored.path, db, logger,
    displayHint: WATER_DISPLAY_HINT,                         // orchestra: WhatsApp rendering rules
    maxOutboundFileBytes: (acc.mediaMaxMb || 100) * 1024 * 1024,
  });
  const pm = new ProcessManager({ processFactory: factory, budget: acc.processBudget || 9, logger });

  function logEvent(kind, detail) {
    try { db.prepare('INSERT INTO events (ts, chat_jid, kind, detail_json) VALUES (?,?,?,?)').run(Date.now(), detail?.chatJid || detail?.chat_jid || null, kind, JSON.stringify(detail || {})); } catch { /* best effort */ }
  }

  // Bot identity set {pn, lid} for mention detection; learned at boot from the session.
  let botIdentity = injectedBotIdentity || new Set();

  const gate = createGate({
    resolveChat: resolve, jidMap, botIdentity, adminJids: acc.adminJids || [],
    allowConfigCommands: acc.allowConfigCommands === true,
  });

  async function deliverFallback(msg, text) {
    await toolDispatcher({ sessionKey: msg.chatJid, chatId: msg.chatJid, toolName: 'reply', text, sourceMsgId: msg.msgId, participantJid: msg.sender.jid });
  }
  async function errorReply(msg, text) {
    await toolDispatcher({ sessionKey: msg.chatJid, chatId: msg.chatJid, toolName: 'reply', text });
  }
  const attachmentsFor = (row) => db.prepare('SELECT * FROM attachments WHERE message_id=?').all(row.id);

  const dispatcher = createDispatcher({
    pm, sessions, status, resolveChat: resolve, defaults: scoped.defaults,
    deliverFallback, errorReply, classify, attachmentsFor, logEvent, logger,
  });

  // Ops: escalation (-> polygram IPC -> Telegram), SLA + transport watchdogs, heartbeat.
  const esc = acc.escalation || {};
  const escalator = createEscalator({ ipcBot: esc.ipcBot, chatId: esc.chatId, quietHours: esc.quietHours, logEvent, logger });
  const heartbeat = createHeartbeat({ db, dataDir, account });
  function holdingText(chatJid) {
    const chat = resolve(chatJid) || {};
    const hr = chat.holdingReply || acc.holdingReply || {};
    return hr.en || hr.th || Object.values(hr)[0] || 'Hi! We are on it — a human will follow up shortly.';
  }
  const sla = createSlaWatchdog({
    db, resolveChat: resolve, defaults: scoped.defaults, slaMinutes: esc.slaMinutes || 10,
    escalate: (sev, t) => escalator.escalate(sev, t),
    sendHolding: async (row) => {
      const r = await toolDispatcher({ sessionKey: row.chat_jid, chatId: row.chat_jid, toolName: 'reply', text: holdingText(row.chat_jid) });
      return r.ok;
    },
    logEvent, logger,
  });
  const expectedWebhook = { url: `${acc.wuzapi.baseUrl.includes('127.0.0.1') ? '' : ''}http://127.0.0.1:${acc.webhook.port}/hook/${acc.webhook?.pathToken || 'water'}`, events: undefined, baseUrlPrefix: 'http://127.0.0.1' };
  const transportWatchdog = createTransportWatchdog({ transport, escalate: (sev, t) => escalator.escalate(sev, t), expectedWebhook, logEvent, logger });

  // Route one recorded inbound through the gate. Fire-and-forget from onMessage so the
  // webhook acks fast; a turn runs in the background.
  async function processInbound(msg, rowId) {
    const row = { id: rowId };
    const d = gate.decide(msg);
    logEvent(`gate-${d.action}`, { chatJid: msg.chatJid, reason: d.reason, sender: msg.sender.jid });
    switch (d.action) {
      case 'dispatch':
        return dispatcher.dispatch(msg.chatJid, msg, row).catch((e) => logger.error?.('dispatch', e?.message));
      case 'abort':
        try { await pm.procs?.get(msg.chatJid)?.interrupt?.(); } catch { /* */ }
        return status.markAborted(rowId);
      case 'ignore':
        return status.markIgnored(rowId, d.reason);
      case 'command':
      case 'consume':
        // v1: config commands / question-consume are recorded; full handling is 1b-D.
        return status.markIgnored(rowId, d.action);
      default:
        return status.markIgnored(rowId, 'unhandled');
    }
  }

  async function onMessage(msg) {
    jidMap.observeSender({ jid: msg.sender.jid, altJid: msg.sender.altJid, pushName: msg.sender.pushName, ts: msg.tsMs });
    const rec = recordInbound(msg, { account }); // throws on DB failure -> 500 -> wuzapi retries
    if (rec.deduped || !rec.rowId) return;       // already handled (retry/replay/reorder)
    processInbound(msg, rec.rowId).catch((e) => logger.error?.('processInbound', e?.message));
  }

  async function onConnectionEvent(ev) {
    await transportWatchdog.onConnectionEvent(ev);
  }

  // IPC-injected synthetic turn (cron jobs) — runs through the normal pipeline.
  async function injectTurn({ chat_id, text, source = 'cron' }) {
    const synthetic = {
      chatJid: chat_id, chatType: chat_id.endsWith('@g.us') ? 'group' : 'dm', msgId: `inj-${Date.now()}`,
      sender: { jid: 'water:inject', altJid: null, pushName: source, pn: null, lid: null },
      isFromMe: false, tsMs: Date.now(), receivedAtMs: Date.now(), text, mentions: [], attachments: [],
    };
    const rec = recordInbound(synthetic, { account, source: `cron:${source}` });
    if (rec.rowId && !rec.deduped) await dispatcher.dispatch(chat_id, synthetic, { id: rec.rowId });
    return { ok: true };
  }

  // Learn the bot's own identity set for mention gating.
  async function learnIdentity() {
    if (injectedBotIdentity) return;
    try {
      const st = await transport.sessionStatus();
      const pn = st?.jid ? jidMap.bareJid(st.jid) : null;
      if (pn) { botIdentity.add(pn); const lid = await transport.resolveLid(pn).catch(() => null); if (lid) { botIdentity.add(jidMap.bareJid(lid)); jidMap.seed({ pn, lid }); } }
    } catch (e) { logger.warn?.('learnIdentity failed', e?.message); }
  }

  // Boot replay (SPEC §4.2): re-gate never-gated `received` rows always; recover
  // interrupted dispatched rows unless completed. (Clean/crash disposition + notices
  // are refined in 1b-D; v1 recovers unanswered work.)
  async function bootReplay(windowMs = 2 * 3600_000) {
    const cutoff = Date.now() - windowMs;
    let replayed = 0;
    for (const r of status.replayCandidates(cutoff)) {
      if (status.hasCompletedTurn(r.chat_jid, r.msg_id)) { status.markReplaySkipped(r.id); continue; }
      status.markReplayAttempted(r.id);
      const msg = reconstruct(r);
      try { await processInbound(msg, r.id); replayed++; } catch (e) { logger.error?.('replay', e?.message); }
    }
    if (replayed) logger.log?.(`[water] boot replay re-dispatched ${replayed} message(s)`);
  }

  // Rebuild a minimal normalized message from a stored row for replay.
  function reconstruct(r) {
    return {
      chatJid: r.chat_jid, chatType: r.chat_jid.endsWith('@g.us') ? 'group' : 'dm', msgId: r.msg_id,
      sender: { jid: r.sender_jid, altJid: r.sender_alt_jid, pushName: r.user, pn: null, lid: null },
      isFromMe: !!r.is_from_me, tsMs: r.ts, receivedAtMs: r.received_at, text: r.text,
      quote: r.quote_msg_id ? { msgId: r.quote_msg_id, participantJid: r.quote_participant } : undefined,
      mentions: [], attachments: [], _isReplay: true,
    };
  }

  let receiver = null;
  let ipc = null;
  let slaTimer = null;
  let pollTimer = null;
  async function start({ withTimers = true } = {}) {
    await learnIdentity();
    const pathToken = acc.webhook?.pathToken || 'water';
    heartbeat.start();
    receiver = createReceiver({
      port: acc.webhook.port, pathToken, hmacKey: acc.wuzapi.hmacKey || '',
      healthPayload: () => heartbeat.healthPayload(),
      emit: logEvent, logger,
      handlers: { onMessage, onConnectionEvent },
    });
    const addr = await receiver.listen();
    logger.log?.(`[water] account=${account} webhook on ${addr.address}:${addr.port}/hook/${pathToken}`);

    // water's own IPC socket (cron injectTurn, operator sends). Allowlisted ops.
    try {
      const secret = ipcServer.writeSecret(account);
      ipc = ipcServer.start({
        path: ipcServer.socketPathFor(account),
        secret,
        logger,
        handlers: {
          ping: async () => ({ pong: true }),
          injectTurn: async (p) => injectTurn(p),
          sendText: async (p) => toolDispatcher({ sessionKey: p.chat_id, chatId: p.chat_id, toolName: 'reply', text: p.text }),
        },
      });
    } catch (e) { logger.warn?.('ipc start failed', e?.message); }

    await bootReplay();

    if (withTimers) {
      slaTimer = setInterval(() => sla.tick().catch((e) => logger.error?.('sla', e?.message)), 30_000); slaTimer.unref?.();
      pollTimer = setInterval(() => transportWatchdog.poll().catch((e) => logger.error?.('poll', e?.message)), 60_000); pollTimer.unref?.();
    }
    return { port: addr.port };
  }

  async function stop() {
    if (slaTimer) clearInterval(slaTimer);
    if (pollTimer) clearInterval(pollTimer);
    heartbeat.stop();
    if (receiver) await receiver.close();
    try { ipc?.close?.(); } catch { /* */ }
    status.markInFlightForShutdown();
    db.prepare("INSERT OR REPLACE INTO daemon_state (k,v) VALUES ('clean_shutdown_at', ?)").run(String(Date.now()));
    try { await pm.shutdown?.(); } catch { /* */ }
    db.close();
  }

  return { start, stop, db, pm, gate, dispatcher, onMessage, processInbound, injectTurn,
    _internal: { transport, outbound, jidMap, sessions, status, toolDispatcher, botIdentity, escalator, sla, transportWatchdog, heartbeat } };
}

// CLI entry
function parseArgs(argv) {
  const a = { account: null, config: null, dataDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account') a.account = argv[++i];
    else if (argv[i] === '--config') a.config = argv[++i];
    else if (argv[i] === '--data-dir') a.dataDir = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.account) { console.error('water: --account <name> required'); process.exit(2); }
  const configPath = args.config || path.join(args.dataDir, 'config.json');
  const config = loadConfig(configPath);
  const daemon = createDaemon({ config, account: args.account, dataDir: args.dataDir });
  const shutdown = async (sig) => { console.log(`[water] ${sig} — shutting down`); try { await daemon.stop(); } finally { process.exit(0); } };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => shutdown(s));
  await daemon.start();
}

if (require.main === module) {
  main().catch((e) => { console.error('[water] fatal:', e.stack || e.message); process.exit(1); });
}

module.exports = { createDaemon, parseArgs };

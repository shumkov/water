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
  const tmuxRunner = createTmuxRunner({ logger, sessionPrefix: 'water' });
  const factory = createProcessFactory({
    config: { chats: scoped.chats, bot: { pm: 'cli' } },
    tmuxRunner, botName: account, toolDispatcher, channelsClaudeBin: vendored.path, db, logger,
    displayHint: WATER_DISPLAY_HINT,                         // orchestra: WhatsApp rendering rules
    maxOutboundFileBytes: (acc.mediaMaxMb || 100) * 1024 * 1024,
    // orchestra identity — water's names so the shared engine speaks WhatsApp.
    sessionPrefix: 'water',
    bridgeServerName: 'water-bridge',
    appDataDir: path.join(require('node:os').homedir(), '.water'),
    attachmentBase: '/tmp/water-attachments',
    productName: 'water',
    surfaceName: 'WhatsApp',
    pmDefault: 'cli',
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

  // Pull-model media fetch (SPEC §4.1): download bytes only for a dispatched turn,
  // size-checked against the cap before fetching. Over-cap/failure -> failed row ->
  // <attachment-failed> in the prompt. Voice transcription is roadmap.
  const setAttDownloaded = db.prepare("UPDATE attachments SET download_status='downloaded', local_path=@path WHERE id=@id");
  const setAttFailed = db.prepare("UPDATE attachments SET download_status='failed', error=@error WHERE id=@id");
  async function fetchMedia(att, { maxBytes }) {
    let ref;
    try { ref = JSON.parse(att.media_ref_json || '{}'); } catch { ref = {}; }
    if ((att.size_bytes || ref.FileLength || 0) > maxBytes) { setAttFailed.run({ id: att.id, error: 'oversize' }); return; }
    try {
      const { buffer } = await transport.downloadMedia(ref, att.kind);
      const dir = path.join(dataDir, 'inbox', att_dirsafe(att));
      require('node:fs').mkdirSync(dir, { recursive: true });
      const ext = (att.mime_type || '').split('/')[1] || 'bin';
      const dest = path.join(dir, `${att.id}.${ext}`);
      const tmp = `${dest}.tmp`;
      require('node:fs').writeFileSync(tmp, buffer);
      require('node:fs').renameSync(tmp, dest); // atomic
      setAttDownloaded.run({ id: att.id, path: dest });
    } catch (e) { setAttFailed.run({ id: att.id, error: e?.message || 'download failed' }); }
  }
  const att_dirsafe = (att) => String(att.message_id);

  const dispatcher = createDispatcher({
    pm, sessions, status, resolveChat: resolve, defaults: scoped.defaults,
    deliverFallback, errorReply, classify, attachmentsFor, fetchMedia,
    mediaMaxBytes: (acc.mediaMaxMb || 32) * 1024 * 1024, logEvent, logger,
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
  async function processInbound(msg, rowId, { isReplay = false } = {}) {
    const row = { id: rowId };
    const d = gate.decide(msg);
    logEvent(`gate-${d.action}`, { chatJid: msg.chatJid, reason: d.reason, sender: msg.sender.jid });
    switch (d.action) {
      case 'dispatch':
        return dispatcher.dispatch(msg.chatJid, msg, row, { isReplay }).catch((e) => logger.error?.('dispatch', e?.message));
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
    // isFromMe: never dispatched. Our own send echo (matches a minted id) is delivery
    // evidence; anything else is a human/other-device send — recorded as an out-row
    // (source='human-device') so the SLA watchdog's human-active suppression can see it.
    if (msg.isFromMe) {
      if (!outbound.isOwnSend(msg.chatJid, msg.msgId)) {
        try { recordInbound(msg, { account, direction: 'out', source: 'human-device' }); } catch (e) { logger.error?.('record human-device', e?.message); }
      }
      return;
    }
    // Inbound edit: update the ORIGINAL message's text/mentions in place (don't create a
    // second row keyed on the edit's own id), then RE-EVALUATE the edited content — an
    // edit can newly address the bot (added @mention / reply) or correct a message
    // mid-turn.
    if (msg.edit?.targetMsgId) {
      const target = msg.edit.targetMsgId;
      try {
        db.prepare('UPDATE messages SET text=@text, edited_ts=@ts WHERE chat_jid=@chat AND msg_id=@target')
          .run({ text: msg.text ?? null, ts: msg.tsMs, chat: msg.chatJid, target });
      } catch (e) { logger.error?.('record edit', e?.message); }
      logEvent('inbound-edit', { chatJid: msg.chatJid, target });

      // Gate the edited content under the ORIGINAL message id (normalize re-extracted its
      // mentions/quote from the edited payload).
      const edited = { ...msg, msgId: target, edit: undefined };
      if (gate.decide(edited).action !== 'dispatch') return;   // still unaddressed → text-only

      const proc = pm.get?.(msg.chatJid);
      // Turn in flight → fold the correction in (like polygram's edit-correction),
      // rather than starting a competing turn.
      if (proc?.inFlight && proc.injectUserMessage) {
        const ok = proc.injectUserMessage({
          content: `[edit] The user edited an earlier message — it now reads: ${msg.text ?? ''}`,
          priority: 'next', msgId: target, source: 'edit-fold',
        });
        if (ok) { logEvent('edit-injected', { chatJid: msg.chatJid, target }); return; }
      }
      // No live turn: an edit that added the mention to a not-yet-answered message earns a
      // reply now (WhatsApp linked-device patch #9). Skip if it was already answered.
      if (status.hasCompletedTurn(msg.chatJid, target)) return;
      const row = db.prepare("SELECT id FROM messages WHERE chat_jid=? AND msg_id=? AND direction='in' ORDER BY id DESC LIMIT 1").get(msg.chatJid, target);
      if (row) {
        logEvent('edit-redispatch', { chatJid: msg.chatJid, target });
        dispatcher.dispatch(msg.chatJid, edited, { id: row.id }).catch((e) => logger.error?.('dispatch(edit)', e?.message));
      }
      return;
    }
    const rec = recordInbound(msg, { account }); // throws on DB failure -> 500 -> wuzapi retries
    if (rec.deduped || !rec.rowId) return;       // already handled (retry/replay/reorder)
    processInbound(msg, rec.rowId).catch((e) => logger.error?.('processInbound', e?.message));
  }

  async function onConnectionEvent(ev) {
    await transportWatchdog.onConnectionEvent(ev);
  }

  // IPC-injected synthetic turn (cron jobs). Trusted (IPC-secret-gated) so it skips
  // the mention gate — but still fail-closed on the configured-chat boundary: never
  // dispatch a Claude turn + WhatsApp send into a chat that isn't in config.
  async function injectTurn({ chat_id, text, source = 'cron' }) {
    if (!resolve(chat_id)) return { ok: false, reason: 'unknown-chat' };
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

  // Boot replay (SPEC §4.2). Restart-intent disposition via the clean-shutdown marker:
  //  - `received` rows (never gated) ALWAYS re-gate — no turn ever started, so no dup.
  //  - `dispatched`/`replay-pending` rows (a turn had started): crash → recover;
  //    clean restart → skip (they were drained at shutdown, not lost).
  // Completion is gated on turn_metrics OR a delivered bot-reply after the inbound
  // (an out-row source='bot-reply' status='sent' ts >= inbound ts). Candidates
  // shadowed by a newer authorized abort are dropped (never resurrect a killed turn).
  const readCleanShutdown = db.prepare("SELECT v FROM daemon_state WHERE k='clean_shutdown_at'");
  const clearCleanShutdown = db.prepare("DELETE FROM daemon_state WHERE k='clean_shutdown_at'");
  const newerAbort = db.prepare("SELECT text, sender_jid, chat_jid FROM messages WHERE chat_jid=? AND direction='in' AND ts>? ");
  const botReplyAfterIn = db.prepare("SELECT 1 FROM messages WHERE chat_jid=? AND direction='out' AND source='bot-reply' AND status='sent' AND ts>=? LIMIT 1");
  const { isAbort } = require('./lib/handlers/abort-detector');

  async function bootReplay(windowMs = 2 * 3600_000) {
    const cutoff = Date.now() - windowMs;
    let cleanRestart = false;
    try { const m = readCleanShutdown.get(); cleanRestart = !!(m && m.v); clearCleanShutdown.run(); }
    catch { cleanRestart = false; } // any ambiguity → treat as crash → recover
    let replayed = 0, skipped = 0;
    for (const r of status.replayCandidates(cutoff)) {
      const startedTurn = r.handler_status === 'dispatched' || r.handler_status === 'replay-pending';
      // completion: a metrics row OR a delivered reply after this inbound
      if (status.hasCompletedTurn(r.chat_jid, r.msg_id) || botReplyAfterIn.get(r.chat_jid, r.ts)) { status.markReplaySkipped(r.id); continue; }
      // clean restart: a turn that had started was drained, not lost — skip it.
      if (startedTurn && cleanRestart) { status.markReplaySkipped(r.id); skipped++; continue; }
      // never resurrect a turn the user explicitly aborted after this message.
      const abortShadow = newerAbort.all(r.chat_jid, r.ts).some((a) => isAbort(a.text));
      if (abortShadow) { status.markReplaySkipped(r.id); skipped++; continue; }
      status.markReplayAttempted(r.id);
      const msg = reconstruct(r);
      try { await processInbound(msg, r.id, { isReplay: true }); replayed++; } catch (e) { logger.error?.('replay', e?.message); }
    }
    if (replayed || skipped) logger.log?.(`[water] boot replay: re-dispatched ${replayed}, skipped ${skipped} (${cleanRestart ? 'clean' : 'crash'} restart)`);
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
  let ambigTimer = null;
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
    // Eager webhook assert/repair at boot (not just the 60s poll): a reverted/lost
    // wuzapi webhook subscription would otherwise silently drop all inbound until the
    // first poll fires. Best-effort — a down wuzapi is caught by the poll + escalation.
    try { await transportWatchdog.poll(); } catch (e) { logger.warn?.('boot webhook reconcile', e?.message); }

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
      // Ambiguous-send sweeper: flip outbound rows stuck 'pending' > 60s to
      // failed('ambiguous-send') (a crashed/lost send callback) and GC the sent-cache.
      ambigTimer = setInterval(() => {
        try { for (const r of outbound.sweepAmbiguous()) logEvent('ambiguous-send', { chatJid: r.chat_jid, msgId: r.msg_id }); }
        catch (e) { logger.error?.('ambig-sweep', e?.message); }
      }, 30_000); ambigTimer.unref?.();
    }
    return { port: addr.port };
  }

  async function stop() {
    if (slaTimer) clearInterval(slaTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (ambigTimer) clearInterval(ambigTimer);
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

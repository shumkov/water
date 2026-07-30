#!/usr/bin/env node
// provenance: polygram@0.17.11 polygram.js main() (git 746bca6) — adapt (rewrite):
// water's daemon. One process per WhatsApp account. Wires the WuzAPI transport edge
// (webhook receiver in, REST client out) to the durable SQLite inbox, the access gate,
// and the proven Claude session engine (ProcessManager + CliProcess + channels bridge).
// See docs/SPEC.md §3-§4.

'use strict';

const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { loadConfig, scopeToAccount, resolveChat } = require('./lib/config');
const { openDb } = require('./lib/db');
const { createTransport } = require('./lib/transport/client');
const { createReceiver } = require('./lib/transport/webhook-receiver');
const { normalize } = require('./lib/transport/normalize');
const { createOutbound } = require('./lib/db/outbound');
const { createJidMap } = require('./lib/db/jid-map');
const { createSessions } = require('./lib/db/sessions');
const { createHandlerStatus } = require('./lib/db/handler-status');
const { createRecordInbound } = require('./lib/handlers/record-inbound');
const { createGate } = require('./lib/handlers/gate');
const { createDispatcher } = require('./lib/handlers/dispatcher');
const { createChannelsToolDispatcher } = require('./lib/process/channels-tool-dispatcher');
const { createFeedback } = require('./lib/feedback/feedback');
const { createQuestions } = require('./lib/handlers/questions');
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
const { createAuthDisabledGate } = require('./lib/ops/auth-disabled-gate');
const { createShutdownBarrier } = require('./lib/ops/shutdown-barrier');
const ipcServer = require('./lib/ipc/server');

// Per-sender cap on the restricted-DM canned reply: at most one send per sender in this
// rolling window. In-memory only (not persisted) — a safety cap against an auto-responder
// loop or a DM flood, not a product knob, so a restart resetting it is an acceptable
// residual (worst case one extra reply per sender, never an unbounded loop).
const RESTRICTED_DM_WINDOW_MS = 24 * 60 * 60 * 1000;

// The webhook URL water registers with WuzAPI, plus the prefix used to recognise a "foreign"
// webhook it must not clobber. Defaults to the loopback bind; webhook.advertiseHost lets a
// Docker-networked deployment advertise a bridge-gateway address the WuzAPI container can
// actually reach — water on the host is NOT reachable at the container's own 127.0.0.1.
function buildExpectedWebhook({ port, pathToken, advertiseHost } = {}) {
  // Coalesce on falsy (not just undefined) so an explicit "" can never diverge from the
  // receiver, which resolves the same values with `|| 'water'` / `|| '127.0.0.1'`.
  const host = advertiseHost || '127.0.0.1';
  const token = pathToken || 'water';
  const base = `http://${host}`;
  // `path` lets the watchdog recognise OUR webhook by path (/hook/<token>) across an
  // advertiseHost change, instead of by host — so a host change self-heals, not dead-locks.
  return { url: `${base}:${port}/hook/${token}`, path: `/hook/${token}`, events: undefined, baseUrlPrefix: base };
}

// Assemble a daemon for one account. Returns { start, stop } so tests can drive it
// with injected transport/logger without opening real sockets.
function createDaemon({
  config,
  account,
  dataDir,
  standby = false,
  logger = console,
  transport: injectedTransport,
  botIdentity: injectedBotIdentity,
  shutdownTimeoutMs = 300_000,
} = {}) {
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
  const shutdownBarrier = createShutdownBarrier();
  const admissionContext = new AsyncLocalStorage();

  // Boot sweeps: any pending outbound is a prior-life crash orphan.
  outbound.sweepCrashed();
  // Mark still-in-flight rows replay-pending happens at shutdown; boot replay runs in start().

  // Per-turn responsiveness feedback (typing + reaction cascade). Created before the
  // tool-dispatcher (an agent `react` flags markAgentReacted) and the PM (whose callbacks
  // drive the cascade). See docs/FEEDBACK_SPEC.md.
  const feedback = createFeedback({ transport, settings: acc.feedback || {}, logger, logEvent });

  // Delivery: the tool-dispatcher claude calls mid-turn (reply/edit/react).
  let dispatcher = null;
  const rawToolDispatcher = createChannelsToolDispatcher({
    transport, outbound, account, feedback,
    chunkText: chunkMarkdownText, formatText: toWhatsApp,
    logEvent: (kind, detail) => logEvent(kind, detail), logger,
  });
  const toolDispatcher = async (call) => {
    const result = await rawToolDispatcher(call);
    if (!result?.ok) {
      const token = admissionContext.getStore()
        || dispatcher?.inFlightToken(call.sessionKey);
      token?.taint('delivery-rejected');
    }
    return result;
  };

  // Session engine: pinned+vendored claude, tmux, cli backend.
  const sessionLauncher = process.env.ORCHESTRA_SESSION_LAUNCHER;
  const tmuxSocketName = process.env.ORCHESTRA_TMUX_SOCKET || null;
  const requireExistingServer = process.env.ORCHESTRA_TMUX_REQUIRE_SERVER === '1';
  logger.log?.(`[water] session containment configured: launcher=${sessionLauncher ? 'yes' : 'no'} socket=${tmuxSocketName ? 'yes' : 'no'} require-server=${requireExistingServer ? 'yes' : 'no'}`);
  const vendored = ensureVendoredClaudeBin(CLAUDE_CLI_PINNED_VERSION);
  if (!vendored.ok) throw new Error(`water: claude binary unavailable: ${vendored.reason}`);
  const tmuxRunner = createTmuxRunner({
    logger,
    sessionPrefix: 'water',
    socketName: tmuxSocketName,
    requireExistingServer,
  });
  const factory = createProcessFactory({
    config: { chats: scoped.chats, bot: { pm: 'cli' } },
    tmuxRunner, botName: account, toolDispatcher, channelsClaudeBin: vendored.path, db, logger,
    sessionLauncher,
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
  // orchestra ProcessManager callbacks drive the reaction cascade: turn-start/thinking →
  // 🤔, tool-use → tool face, subagent → 👾. Re-wired on every spawn (respawn-safe). The
  // callback signature is (sessionKey, ...payload, proc); tool-use's payload is the toolName.
  // Late-bound: the questions handler is created after the dispatcher (it needs the
  // dispatcher's in-flight-sender map), but the PM callbacks + gate below reference it.
  let questions = null;
  const pm = new ProcessManager({
    processFactory: factory, budget: acc.processBudget || 9, logger,
    callbacks: {
      onTurnStart:     (sk, p) => feedback.onEvent(sk, 'turn-start', p),
      onThinking:      (sk) => feedback.onEvent(sk, 'thinking'),
      onToolUse:       (sk, toolName) => feedback.onEvent(sk, 'tool-use', toolName),
      onSubagentStart: (sk, p) => feedback.onEvent(sk, 'subagent-start', p),
      onSubagentDone:  (sk, p) => feedback.onEvent(sk, 'subagent-done', p),
      onQuestionAsked: (sk, p) => questions?.onAsked(sk, p),   // `ask` tool (docs/ASK_SPEC.md)
    },
  });

  function logEvent(kind, detail) {
    try {
      const result = db.prepare('INSERT INTO events (ts, chat_jid, kind, detail_json) VALUES (?,?,?,?)')
        .run(Date.now(), detail?.chatJid || detail?.chat_jid || null, kind, JSON.stringify(detail || {}));
      return Number(result.lastInsertRowid);
    } catch {
      return null;
    }
  }

  // Bot identity set {pn, lid} for mention detection; learned at boot from the session.
  let botIdentity = injectedBotIdentity || new Set();

  // Opt-in canned reply for non-allowlisted DMs (see restrictedReply below). Absent/empty
  // config ⇒ disabled, full back-compat with today's silent drop.
  const dmRestrictedReply = acc.dmRestrictedReply;
  const restrictedDmEnabled = typeof dmRestrictedReply === 'string' && dmRestrictedReply.length > 0;
  const restrictedDmSeenAt = new Map(); // 'chatJid|canonical-identity' -> last-reply ts (see RESTRICTED_DM_WINDOW_MS)
  // Resolve through jidMap's identity set (like authorize()/isAdmin elsewhere in the
  // gate) so the same person addressed once as a pn and once as a lid still shares one
  // cap entry, instead of getting a fresh allowance under each form.
  function restrictedDmKey(chatJid, senderJid) {
    const identity = [...jidMap.identitySet(senderJid)].sort()[0];
    return `${chatJid}|${identity}`;
  }
  function hasRecentRestrictedReply(chatJid, senderJid) {
    const seenAt = restrictedDmSeenAt.get(restrictedDmKey(chatJid, senderJid));
    return seenAt !== undefined && Date.now() - seenAt < RESTRICTED_DM_WINDOW_MS;
  }
  function markRestrictedDmReplied(chatJid, senderJid) {
    restrictedDmSeenAt.set(restrictedDmKey(chatJid, senderJid), Date.now());
  }

  const gate = createGate({
    resolveChat: resolve, jidMap, botIdentity, adminJids: acc.adminJids || [],
    allowConfigCommands: acc.allowConfigCommands === true,
    hasOpenQuestionFor: (chatJid, senderJid) => (questions ? questions.isOpenFor(chatJid, senderJid) : false),
    restrictedDmEnabled, hasRecentRestrictedReply,
  });

  async function deliverFallback(msg, text) {
    await toolDispatcher({ sessionKey: msg.chatJid, chatId: msg.chatJid, toolName: 'reply', text, sourceMsgId: msg.msgId, participantJid: msg.sender.jid });
  }
  async function errorReply(msg, text) {
    await toolDispatcher({ sessionKey: msg.chatJid, chatId: msg.chatJid, toolName: 'reply', text });
  }
  // Canned "DMs aren't monitored" note for a non-allowlisted DM (gate action
  // 'restricted-dm'): no Claude turn, just the reply path — identical shape to errorReply.
  async function restrictedReply(msg) {
    await toolDispatcher({ sessionKey: msg.chatJid, chatId: msg.chatJid, toolName: 'reply', text: dmRestrictedReply });
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

  // Escalation (-> polygram IPC -> Telegram) is constructed here, ahead of the dispatcher,
  // because the dispatcher's authDisabledGate dependency needs it.
  const esc = acc.escalation || {};
  const escalator = createEscalator({ ipcBot: esc.ipcBot, chatId: esc.chatId, quietHours: esc.quietHours, logEvent, logger });
  const authDisabledGate = createAuthDisabledGate({ escalate: (sev, t) => escalator.escalate(sev, t), logEvent, logger });

  dispatcher = createDispatcher({
    pm, sessions, status, resolveChat: resolve, defaults: scoped.defaults,
    deliverFallback, errorReply, classify, attachmentsFor, fetchMedia, feedback,
    mediaMaxBytes: (acc.mediaMaxMb || 32) * 1024 * 1024, logEvent, logger,
    authDisabledGate,
  });

  // `ask` tool (docs/ASK_SPEC.md): DM-only real questions, group asks degrade non-blocking.
  questions = createQuestions({
    db, pm, jidMap,
    deliver: (chatJid, text) => toolDispatcher({ sessionKey: chatJid, chatId: chatJid, toolName: 'reply', text }),
    inFlightSender: (sk) => dispatcher.inFlightSender(sk),
    logEvent, logger,
  });
  // Boot: any 'open' question is a prior-life orphan (its bridge promise died with the old
  // process). Expire it WITHOUT answering, so it can't swallow a future message.
  questions.expireOrphansAtBoot();

  // Ops: SLA + transport watchdogs, heartbeat.
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
  const expectedWebhook = buildExpectedWebhook({ port: acc.webhook.port, pathToken: acc.webhook?.pathToken, advertiseHost: acc.webhook?.advertiseHost });
  const transportWatchdog = createTransportWatchdog({ transport, escalate: (sev, t) => escalator.escalate(sev, t), expectedWebhook, logEvent, logger, standby });
  if (standby) logger.log?.(`[water] STANDBY — connected + listening, NOT claiming the WuzAPI webhook (pre-flight)`);

  // Route one recorded inbound through the gate. Fire-and-forget from onMessage so the
  // webhook acks fast; a turn runs in the background.
  async function processInbound(msg, rowId, { isReplay = false, shutdownToken = null } = {}) {
    const row = { id: rowId };
    const d = gate.decide(msg);
    logEvent(`gate-${d.action}`, { chatJid: msg.chatJid, reason: d.reason, sender: msg.sender.jid });
    switch (d.action) {
      case 'dispatch':
        return dispatcher.dispatch(msg.chatJid, msg, row, { isReplay, shutdownToken });
      case 'abort':
        try { await pm.procs?.get(msg.chatJid)?.interrupt?.(); } catch { /* */ }
        questions.expireChat(msg.chatJid);   // an interrupt frees the lock but leaves the row open
        return status.markAborted(rowId);
      case 'ignore':
        return status.markIgnored(rowId, d.reason);
      case 'restricted-dm':
        // Canned "DMs aren't monitored" note. Skip on boot replay (the sender already
        // got it live; a restart must not re-blast old DMs). Mark the sender BEFORE the
        // send so a burst of near-simultaneous messages can't all slip past the cap.
        // Send is best-effort; the row is terminal either way so it can't replay or trip
        // the SLA.
        if (!isReplay) {
          markRestrictedDmReplied(msg.chatJid, msg.sender.jid);
          try { await restrictedReply(msg); }
          catch (e) { logger.error?.('restricted-dm reply', e?.message); }
        }
        return status.markIgnored(rowId, 'restricted-dm');
      case 'command':
        // v1: config commands are recorded; full handling is 1b-D.
        return status.markIgnored(rowId, 'command');
      case 'consume': {
        // The reply answers an open `ask`. Resolve it via the SYNCHRONOUS questions.consume
        // (→ pm.answerQuestion) RIGHT HERE — it MUST NOT go through dispatcher.dispatch: the
        // wedged ask-turn holds lockFor(chat), so acquiring that lock in the answer path would
        // deadlock. questions.consume never touches the lock (docs/ASK_SPEC.md §3.3).
        const r = questions.consume(msg);
        return status.markIgnored(rowId, r.ok ? 'answered-question' : 'question-reparse');
      }
      default:
        return status.markIgnored(rowId, 'unhandled');
    }
  }

  function busySummary() {
    return { account, in_flight: shutdownBarrier.count() };
  }

  async function runAdmitted({ kind, owner = null, rowId = null }, work) {
    const token = shutdownBarrier.admit({ kind, owner, rowId });
    if (!token) return { admitted: false, value: null };
    try {
      const value = await admissionContext.run(token, () => work(token));
      const tainted = token.isTainted();
      token.complete('durable-terminal');
      if (tainted && shutdownBarrier.isFenced() && rowId != null) {
        status.markReplayPending(rowId);
      }
      return { admitted: true, value };
    } catch (error) {
      if (shutdownBarrier.isFenced() && rowId != null) {
        try { status.markReplayPending(rowId); } catch { /* DB failure remains crash-like */ }
      }
      token.fail(error?.code === 'TIMEOUT' ? 'ambiguous' : 'rejected');
      throw error;
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
        db.prepare(`
          UPDATE messages
             SET text=@text,
                 raw_json=@rawJson,
                 quote_msg_id=@quoteMsgId,
                 quote_participant=@quoteParticipant,
                 edited_ts=@ts
           WHERE chat_jid=@chat AND msg_id=@target
        `).run({
          text: msg.text ?? null,
          rawJson: msg.rawJson ?? null,
          quoteMsgId: msg.quote?.msgId ?? null,
          quoteParticipant: msg.quote?.participantJid ?? null,
          ts: msg.tsMs,
          chat: msg.chatJid,
          target,
        });
      } catch (e) { logger.error?.('record edit', e?.message); }
      logEvent('inbound-edit', { chatJid: msg.chatJid, target });

      // Gate the edited content under the ORIGINAL message id (normalize re-extracted its
      // mentions/quote from the edited payload).
      const edited = { ...msg, msgId: target, edit: undefined };
      const decision = gate.decide(edited);
      if (decision.action !== 'dispatch') return;   // still unaddressed → text-only

      const proc = pm.get?.(msg.chatJid);
      // Turn in flight → fold the correction in (like polygram's edit-correction),
      // rather than starting a competing turn.
      const editBelongsToAdmittedTurn = !shutdownBarrier.isFenced()
        || shutdownBarrier.hasActiveOwner(msg.chatJid);
      if (editBelongsToAdmittedTurn && proc?.inFlight && proc.injectUserMessage) {
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
        if (shutdownBarrier.isFenced()) {
          status.resetForReplay(row.id);
          logEvent('edit-fenced-for-replay', { chatJid: msg.chatJid, target });
          return;
        }
        logEvent('edit-redispatch', { chatJid: msg.chatJid, target });
        runAdmitted(
          { kind: 'edit', owner: msg.chatJid, rowId: row.id },
          (token) => dispatcher.dispatch(
            msg.chatJid,
            edited,
            { id: row.id },
            { shutdownToken: token },
          ),
        ).catch((e) => logger.error?.('dispatch(edit)', e?.message));
      }
      return;
    }
    const rec = recordInbound(msg, { account }); // throws on DB failure -> 500 -> wuzapi retries
    if (rec.deduped || !rec.rowId) return;       // already handled (retry/replay/reorder)
    if (shutdownBarrier.isFenced()) {
      // An answer to a question owned by an admitted turn is completion evidence,
      // not a new turn. Everything else stays in `received` for boot replay.
      if (
        gate.decide(msg).action === 'consume'
        && shutdownBarrier.hasActiveOwner(msg.chatJid)
      ) {
        await processInbound(msg, rec.rowId);
      }
      return;
    }
    runAdmitted(
      { kind: 'webhook', owner: msg.chatJid, rowId: rec.rowId },
      (token) => processInbound(msg, rec.rowId, { shutdownToken: token }),
    ).catch((e) => logger.error?.('processInbound', e?.message));
  }

  async function onConnectionEvent(ev) {
    if (shutdownBarrier.isFenced()) {
      logEvent('connection-during-shutdown', { kind: ev.kind });
      return;
    }
    const admission = await runAdmitted(
      { kind: 'connection-event', owner: 'transport' },
      () => transportWatchdog.onConnectionEvent(ev),
    );
    return admission.value;
  }

  // IPC-injected synthetic turn (cron jobs). Trusted (IPC-secret-gated) so it skips
  // the mention gate — but still fail-closed on the configured-chat boundary: never
  // dispatch a Claude turn + WhatsApp send into a chat that isn't in config.
  async function injectTurn({ chat_id, text, source = 'cron' }) {
    if (shutdownBarrier.isFenced()) return { ok: false, reason: 'shutting-down' };
    if (!resolve(chat_id)) return { ok: false, reason: 'unknown-chat' };
    const token = shutdownBarrier.admit({ kind: 'ipc-inject', owner: chat_id });
    if (!token) return { ok: false, reason: 'shutting-down' };
    const synthetic = {
      chatJid: chat_id, chatType: chat_id.endsWith('@g.us') ? 'group' : 'dm', msgId: `inj-${Date.now()}`,
      sender: { jid: 'water:inject', altJid: null, pushName: source, pn: null, lid: null },
      isFromMe: false, tsMs: Date.now(), receivedAtMs: Date.now(), text, mentions: [], attachments: [],
    };
    let rec = null;
    try {
      rec = recordInbound(synthetic, { account, source: `cron:${source}` });
      token.rowId = rec.rowId || null;
      if (rec.rowId && !rec.deduped) {
        await admissionContext.run(token, () => dispatcher.dispatch(
          chat_id, synthetic, { id: rec.rowId }, { shutdownToken: token },
        ));
      }
      const tainted = token.isTainted();
      token.complete('durable-terminal');
      if (tainted && shutdownBarrier.isFenced() && rec?.rowId) {
        status.markReplayPending(rec.rowId);
      }
      return { ok: true };
    } catch (error) {
      if (shutdownBarrier.isFenced() && rec?.rowId) status.markReplayPending(rec.rowId);
      token.fail('rejected');
      throw error;
    }
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
  // A delivered bot-reply after the inbound is the only replay-suppression evidence
  // (an out-row source='bot-reply' status='sent' ts >= inbound ts). A success metric can
  // precede fallback delivery, so it cannot make a nonterminal row safe to skip.
  // Candidates shadowed by a newer authorized abort are dropped (never resurrect a
  // killed turn).
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
    let replayed = 0, skipped = 0, failed = 0;
    for (const r of status.replayCandidates(cutoff)) {
      const startedTurn = r.handler_status === 'dispatched' || r.handler_status === 'replay-pending';
      // A metrics row can be written before fallback delivery. Only durable reply
      // evidence may suppress a still-nonterminal replay candidate.
      if (botReplyAfterIn.get(r.chat_jid, r.ts)) {
        status.markReplaySkipped(r.id);
        continue;
      }
      // clean restart: a turn that had started was drained, not lost — skip it.
      if (startedTurn && cleanRestart) { status.markReplaySkipped(r.id); skipped++; continue; }
      // never resurrect a turn the user explicitly aborted after this message.
      const abortShadow = newerAbort.all(r.chat_jid, r.ts).some((a) => isAbort(a.text));
      if (abortShadow) { status.markReplaySkipped(r.id); skipped++; continue; }
      const msg = reconstruct(r);
      try {
        const admission = await runAdmitted(
          { kind: 'boot-replay', owner: r.chat_jid, rowId: r.id },
          async (token) => {
            await processInbound(msg, r.id, { isReplay: true, shutdownToken: token });
          },
        );
        if (!admission.admitted) break;
        replayed++;
      } catch (e) {
        status.markReplayPending(r.id);
        failed++;
        logger.error?.('replay', e?.message);
      }
    }
    if (replayed || skipped) logger.log?.(`[water] boot replay: re-dispatched ${replayed}, skipped ${skipped} (${cleanRestart ? 'clean' : 'crash'} restart)`);
    const unresolved = status.replayCandidates(cutoff).length;
    if (failed || unresolved) {
      logEvent('water-boot-replay-incomplete', { replayed, skipped, failed, unresolved });
      const error = new Error(`water: boot replay incomplete (${failed} failed, ${unresolved} unresolved)`);
      error.code = 'BOOT_REPLAY_INCOMPLETE';
      throw error;
    }
    logEvent('water-boot-replay-complete', { replayed, skipped, failed: 0, unresolved: 0 });
    return { replayed, skipped, failed: 0, unresolved: 0 };
  }

  // Rebuild from the committed raw webhook so gate-relevant structured context
  // (native mentions and edited quotes) survives a restart.
  function reconstruct(r) {
    if (r.raw_json) {
      try {
        const event = normalize(JSON.parse(r.raw_json));
        if (event?.type === 'message' && event.message) {
          return {
            ...event.message,
            chatJid: r.chat_jid,
            chatType: r.chat_jid.endsWith('@g.us') ? 'group' : 'dm',
            msgId: r.msg_id,
            sender: {
              ...event.message.sender,
              jid: r.sender_jid,
              altJid: r.sender_alt_jid,
              pushName: r.user,
            },
            isFromMe: !!r.is_from_me,
            tsMs: r.ts,
            receivedAtMs: r.received_at,
            text: r.text,
            _isReplay: true,
          };
        }
      } catch {
        // Rows predating raw webhook storage keep the minimal compatibility path.
      }
    }
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
  let questionTimer = null;
  let stopPromise = null;

  function startWorkTimer(kind, intervalMs, work) {
    const timer = setInterval(() => {
      runAdmitted(
        { kind: `timer:${kind}`, owner: `timer:${kind}` },
        () => work(),
      ).catch((error) => logger.error?.(kind, error?.message));
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  async function sendTextFromIpc(params) {
    if (shutdownBarrier.isFenced()) return { ok: false, reason: 'shutting-down' };
    const token = shutdownBarrier.admit({ kind: 'ipc-send', owner: params.chat_id });
    if (!token) return { ok: false, reason: 'shutting-down' };
    try {
      const result = await admissionContext.run(token, () => toolDispatcher({
        sessionKey: params.chat_id,
        chatId: params.chat_id,
        toolName: 'reply',
        text: params.text,
      }));
      if (!result?.ok) {
        token.fail('delivery-rejected');
        return { ok: false, reason: 'delivery-rejected' };
      }
      token.complete('ipc-delivered');
      return result;
    } catch (error) {
      token.fail('rejected');
      throw error;
    }
  }

  async function start({ withTimers = true } = {}) {
    const startupToken = shutdownBarrier.admit({ kind: 'startup', owner: 'daemon' });
    if (!startupToken) {
      const error = new Error('water: start rejected during shutdown');
      error.code = 'SHUTTING_DOWN';
      throw error;
    }
    logEvent('water-start', { admitted: true });
    const assertStartOpen = () => {
      if (!shutdownBarrier.isFenced()) return;
      const error = new Error('water: shutdown began during startup');
      error.code = 'SHUTTING_DOWN';
      throw error;
    };
    try {
      await admissionContext.run(startupToken, () => learnIdentity());
      assertStartOpen();
      const pathToken = acc.webhook?.pathToken || 'water';
      const bindHost = acc.webhook?.bindHost || '127.0.0.1';
      // HMAC posture (fail-loud): require a signed webhook UNLESS explicitly opted out with
      // webhook.requireHmac:false (trust the receiver's bind host + host firewall as the
      // boundary). Never a silent skip: a missing key with requireHmac still on aborts the boot.
      const hmacKey = acc.wuzapi.hmacKey || '';
      const requireHmac = acc.webhook?.requireHmac !== false;
      if (requireHmac && !hmacKey) {
        throw new Error('water: no wuzapi.hmacKey configured. Set the shared HMAC secret, or set webhook.requireHmac:false to trust the bind host + firewall (unsigned webhooks).');
      }
      const skipHmac = !requireHmac && !hmacKey;
      if (skipHmac) {
        const wildcard = bindHost === '0.0.0.0' || bindHost === '::';
        logger.warn?.(`[water] HMAC DISABLED (webhook.requireHmac:false) — unsigned webhooks trusted; ${wildcard
          ? `bind is ${bindHost} (ALL interfaces) — the ONLY boundary is the host firewall`
          : `the boundary is the ${bindHost} bind + host firewall`}`);
      }
      heartbeat.start();
      receiver = createReceiver({
        port: acc.webhook.port, host: bindHost, pathToken, hmacKey, skipHmac,
        healthPayload: () => heartbeat.healthPayload(),
        emit: logEvent, logger,
        handlers: { onMessage, onConnectionEvent },
      });
      const addr = await receiver.listen();
      assertStartOpen();
      logEvent('water-receiver-ready', { ready: true });
      logger.log?.(`[water] account=${account} webhook on ${addr.address}:${addr.port}/hook/${pathToken}`);
      // Eager webhook assert/repair at boot (not just the 60s poll): a reverted/lost
      // wuzapi webhook subscription would otherwise silently drop all inbound until the
      // first poll fires. Best-effort — a down wuzapi is caught by the poll + escalation.
      try {
        await runAdmitted(
          { kind: 'startup-reconcile', owner: 'transport' },
          () => transportWatchdog.poll(),
        );
      } catch (e) {
        logger.warn?.('boot webhook reconcile', e?.message);
      }
      assertStartOpen();

      // water's own IPC socket (cron injectTurn, operator sends). Allowlisted ops.
      const secret = ipcServer.writeSecret(account);
      ipc = await ipcServer.start({
        path: ipcServer.socketPathFor(account),
        secret,
        logger,
        handlers: {
          ping: async () => ({ pong: true }),
          busy: async () => busySummary(),
          injectTurn: async (params) => injectTurn(params),
          sendText: async (params) => sendTextFromIpc(params),
        },
      });
      assertStartOpen();

      await bootReplay();
      assertStartOpen();

      if (withTimers) {
        slaTimer = startWorkTimer('sla', 30_000, () => sla.tick());
        pollTimer = startWorkTimer('poll', 60_000, () => transportWatchdog.poll());
        // Ambiguous-send sweeper: flip outbound rows stuck 'pending' > 60s to
        // failed('ambiguous-send') (a crashed/lost send callback) and GC the sent-cache.
        ambigTimer = startWorkTimer('ambig-sweep', 30_000, () => {
          for (const r of outbound.sweepAmbiguous()) {
            logEvent('ambiguous-send', { chatJid: r.chat_jid, msgId: r.msg_id });
          }
        });
        // `ask` timeout sweep — the SOLE anti-wedge for a DM ask (the daemon defers its own
        // turn-timeout while a question is open, so this frees a stuck DM turn + its lock).
        questionTimer = startWorkTimer('question-sweep', 30_000, () => questions.sweep());
      }
      logEvent('water-admission-open', { ready: true });
      startupToken.complete('durable-terminal');
      return { port: addr.port };
    } catch (error) {
      startupToken.fail('startup-rejected');
      throw error;
    }
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (slaTimer) clearInterval(slaTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (ambigTimer) clearInterval(ambigTimer);
      if (questionTimer) clearInterval(questionTimer);
      heartbeat.stop();

      // Clearing callbacks and fencing are synchronous, so nothing can slip
      // between the timer stop and the admitted-token snapshot.
      const snapshot = shutdownBarrier.fence();
      logEvent('water-shutdown-fenced', { admitted: snapshot.length });
      const drain = await shutdownBarrier.wait(snapshot, { timeoutMs: shutdownTimeoutMs });
      logEvent('water-shutdown-drain', {
        clean: drain.clean,
        timed_out: drain.timedOut,
        admitted: drain.admitted,
        completed: drain.completed,
        rejected: drain.rejected,
      });
      let clean = drain.clean;

      try { if (receiver) await receiver.close(); } catch { clean = false; }
      try { if (ipc) await ipc.close(); } catch { clean = false; }
      try { await pm.shutdown?.(); } catch { clean = false; }

      try {
        if (clean) {
          db.prepare("INSERT OR REPLACE INTO daemon_state (k,v) VALUES ('clean_shutdown_at', ?)").run(String(Date.now()));
        } else {
          status.markInFlightForShutdown();
          clearCleanShutdown.run();
        }
      } catch {
        clean = false;
        try {
          status.markInFlightForShutdown();
          clearCleanShutdown.run();
        } catch { /* DB ambiguity stays crash-like */ }
      }
      const stopEventId = logEvent('water-stop', { clean });
      try {
        db.close();
      } catch {
        // A failed close makes durability ambiguous even if writing the clean marker
        // succeeded. Invalidate it while the handle is still usable, then retry close.
        clean = false;
        try {
          status.markInFlightForShutdown();
          clearCleanShutdown.run();
        } catch { /* a persisted clean marker remains an unavoidable DB failure */ }
        if (stopEventId != null) {
          try {
            db.prepare('UPDATE events SET detail_json=? WHERE id=?')
              .run(JSON.stringify({ clean: false }), stopEventId);
          } catch { /* lifecycle evidence shares the same DB ambiguity */ }
        }
        try { db.close(); } catch { /* process exit is the final containment boundary */ }
      }
      return { ...drain, clean };
    })();
    return stopPromise;
  }

  return {
    start,
    stop,
    db,
    pm,
    gate,
    dispatcher,
    onMessage,
    onConnectionEvent,
    processInbound,
    injectTurn,
    busySummary,
    _internal: {
      transport,
      outbound,
      jidMap,
      sessions,
      status,
      toolDispatcher,
      botIdentity,
      escalator,
      sla,
      transportWatchdog,
      heartbeat,
      shutdownBarrier,
      runAdmitted,
      sendTextFromIpc,
      questions,
    },
  };
}

// CLI entry
function parseArgs(argv) {
  const a = { account: null, config: null, dataDir: process.cwd(), standby: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account') a.account = argv[++i];
    else if (argv[i] === '--config') a.config = argv[++i];
    else if (argv[i] === '--data-dir') a.dataDir = argv[++i];
    else if (argv[i] === '--standby') a.standby = true;   // pre-flight: don't claim the webhook
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.account) { console.error('water: --account <name> required'); process.exit(2); }
  const configPath = args.config || path.join(args.dataDir, 'config.json');
  const config = loadConfig(configPath);
  const daemon = createDaemon({ config, account: args.account, dataDir: args.dataDir, standby: args.standby });
  let shuttingDown = false;
  let shutdownPromise = null;
  const shutdown = (sig) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    console.log(`[water] ${sig} — shutting down`);
    shutdownPromise = daemon.stop().finally(() => process.exit(0));
    return shutdownPromise;
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(s, () => { void shutdown(s); });
  }
  try {
    await daemon.start();
  } catch (error) {
    if (shuttingDown) {
      await shutdownPromise;
      return;
    }
    throw error;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[water] fatal:', e.stack || e.message); process.exit(1); });
}

module.exports = { createDaemon, parseArgs, buildExpectedWebhook };

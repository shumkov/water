// Transport watchdog (SPEC §4.5) — two-signal liveness + bounded revive. Never
// restarts anything on message silence alone.
//   (a) poll GET /session/status every 60s (non-200 = down); compare webhook/events
//       to config and repair drift.
//   (b) connection webhook events.
// logged-out / temp-ban / client-outdated -> CRITICAL, NO auto-revive (needs a human).
// connect-failure (wuzapi exhausted retries, connected=0 persisted) -> auto-revive via
// POST /session/connect, cooldown 5min / <=3 per hour. A bare connected:false triggers
// revive only after >=3 consecutive down polls AND no recent Disconnected (status can't
// tell "wuzapi gave up" from "whatsmeow mid-reconnect").

'use strict';

const CRITICAL_KINDS = new Set(['logged-out', 'temp-ban', 'client-outdated']);
const SUBSCRIBE = ['Message', 'Connected', 'Disconnected', 'ConnectFailure', 'KeepAliveTimeout', 'KeepAliveRestored', 'LoggedOut', 'TemporaryBan', 'ClientOutdated', 'StreamError', 'PairSuccess'];

function createTransportWatchdog({
  transport, escalate, expectedWebhook, logEvent = () => {}, logger = console, now = Date.now,
  // Standby (pre-flight): monitor the connection but do NOT claim/repair the WuzAPI
  // webhook — so water can be deployed and verified without hijacking inbound delivery
  // while the old bridge is still live. The cutover flips this off.
  standby = false,
  reviveCooldownMs = 5 * 60_000, reviveMaxPerHour = 3, downPollsBeforeRevive = 3,
} = {}) {
  let downPolls = 0;
  let lastDisconnectAt = 0;
  let humanHoldUntil = 0; // after a CRITICAL that needs a human, don't auto-revive
  const reviveTimes = [];

  function canRevive() {
    const t = now();
    if (t < humanHoldUntil) return false;
    while (reviveTimes.length && t - reviveTimes[0] > 3600_000) reviveTimes.shift();
    if (reviveTimes.length >= reviveMaxPerHour) return false;
    if (reviveTimes.length && t - reviveTimes.at(-1) < reviveCooldownMs) return false;
    return true;
  }

  async function revive(reason) {
    if (!canRevive()) { logEvent('transport-revive-skipped', { reason }); return false; }
    reviveTimes.push(now());
    logEvent('transport-revive', { reason });
    try { await transport.connectSession(SUBSCRIBE); return true; }
    catch (e) { await escalate('CRITICAL', `session revive failed (${reason}): ${e.message}`); return false; }
  }

  // Handle a normalized connection webhook event.
  async function onConnectionEvent(ev) {
    logEvent('connection', { kind: ev.kind });
    if (ev.kind === 'disconnected' || ev.kind === 'keepalive-timeout') { lastDisconnectAt = now(); return; }
    if (ev.kind === 'connected' || ev.kind === 'keepalive-restored') { downPolls = 0; return; }
    if (CRITICAL_KINDS.has(ev.kind)) {
      humanHoldUntil = now() + 24 * 3600_000; // needs a human (re-pair / wait / bump)
      await escalate('CRITICAL', `WhatsApp session ${ev.kind} — bot is offline until a human acts (re-pair / wait out a ban / bump wuzapi).`);
      return;
    }
    if (ev.kind === 'connect-failure') {
      await escalate('CRITICAL', 'wuzapi ConnectFailure (retries exhausted) — attempting revive.');
      await revive('connect-failure-event');
    }
  }

  // Poll session status: liveness + webhook/events drift repair.
  async function poll() {
    let st;
    try { st = await transport.sessionStatus(); }
    catch (e) { downPolls++; logEvent('status-poll-down', { downPolls, error: e.message }); if (downPolls >= downPollsBeforeRevive && now() - lastDisconnectAt > 60_000) await revive('poll-unreachable'); return; }

    if (st && st.connected === false) {
      downPolls++;
      if (downPolls >= downPollsBeforeRevive && now() - lastDisconnectAt > 2 * 60_000) await revive('poll-connected-false');
    } else {
      downPolls = 0;
    }

    // Webhook/events drift repair (split-brain guarded: only overwrite empty or ours).
    // Skipped in standby — pre-flight must not claim the webhook.
    if (!standby && expectedWebhook && st) {
      const cur = st.webhook || '';
      const foreign = cur && !cur.startsWith(expectedWebhook.baseUrlPrefix || 'http://127.0.0.1');
      if (!cur || (!foreign && cur !== expectedWebhook.url)) {
        try { await transport.setWebhook({ url: expectedWebhook.url, events: expectedWebhook.events || SUBSCRIBE }); logEvent('webhook-repaired', {}); }
        catch (e) { logger.warn?.('webhook repair failed', e?.message); }
      } else if (foreign) {
        await escalate('INFO', `wuzapi webhook is owned by another consumer (${cur}) — a stale test water?`);
      }
    }
  }

  return { onConnectionEvent, poll, revive, _state: () => ({ downPolls, reviveTimes: reviveTimes.length }) };
}

module.exports = { createTransportWatchdog, SUBSCRIBE };

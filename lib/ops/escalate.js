// Escalation to Ivan on Telegram, via the polygram daemon's IPC socket (SPEC §4.5).
// water and polygram share the VPS; water asks polygram to send a Telegram message to
// Ivan's DM. Precondition (verified): polygram's IPC `send` rejects a chat_id not in
// the target bot's config, so escalation.chatId must be a chat of escalation.ipcBot.
// CRITICAL always pages; INFO respects quiet hours.

'use strict';

const { tell } = require('../ipc/client');

function inQuietHours(now, quiet) {
  if (!quiet) return false;
  // now: Date; quiet: {from:"HH:MM", to:"HH:MM", tz}. tz handling is approximate —
  // we compare wall-clock HH:MM in the configured offset via Intl.
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const [h, m] = parts.split(':').map(Number);
    const cur = h * 60 + m;
    const [fh, fm] = quiet.from.split(':').map(Number);
    const [th, tm] = quiet.to.split(':').map(Number);
    const from = fh * 60 + fm; const to = th * 60 + tm;
    return from <= to ? cur >= from && cur < to : cur >= from || cur < to; // handles overnight
  } catch { return false; }
}

// deps: { ipcBot, chatId, quietHours, tellFn=tell, logEvent, logger, nowFn }
function createEscalator({ ipcBot, chatId, quietHours = null, tellFn = tell, logEvent = () => {}, logger = console, nowFn = () => new Date() } = {}) {
  // No ipcBot configured → escalation is a no-op. Netdata is the single alert surface for this
  // deployment (docs MONITORING_SPEC / WATER_MONITORING_SPEC): water's conditions surface via the
  // Layer-1 httpchecks + Layer-2 health-check, not a second Telegram channel. Skipping here avoids
  // pointless `escalation FAILED` noise (and stops it inflating healthz.escalated, which counts
  // escalation-failed events). Set escalation.ipcBot to re-enable the Telegram path.
  const enabled = !!(ipcBot && String(ipcBot).trim());
  // severity: 'CRITICAL' | 'INFO'. Returns true if sent.
  async function escalate(severity, text) {
    if (!enabled) { logEvent('escalation-skipped', { severity, reason: 'no-ipcBot' }); return false; }
    if (severity === 'INFO' && inQuietHours(nowFn(), quietHours)) {
      logEvent('escalation-suppressed-quiet', { severity });
      return false;
    }
    const prefix = severity === 'CRITICAL' ? '🚨 water CRITICAL' : 'ℹ️ water';
    try {
      await tellFn(ipcBot, 'sendMessage', { chat_id: chatId, text: `${prefix}: ${text}` }, { source: 'water:escalate' });
      logEvent('escalation-sent', { severity });
      return true;
    } catch (e) {
      // The Telegram path is down — log loudly; the doctor cron is the backstop.
      logger.error?.(`[water] escalation FAILED (${severity}): ${e.message}`);
      logEvent('escalation-failed', { severity, error: e.message });
      return false;
    }
  }
  return { escalate, inQuietHours: (now) => inQuietHours(now, quietHours) };
}

module.exports = { createEscalator, inQuietHours };

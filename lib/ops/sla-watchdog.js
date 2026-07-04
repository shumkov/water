// SLA watchdog (SPEC §4.5) — the "customer waited 4 hours" killer feature.
//
// Fires ONLY for dispatched rows (gate-passed; `ignored` rows can never trigger it)
// with no completed turn and no delivered reply, once past
//   holdAfterMs = max(slaMinutes*60000, maxTurnHard + 120000)
// keyed off the HARD ceiling because busy-aware turn ceilings legitimately re-arm past
// maxTurn. Sends a per-chat holding reply ONCE per turn (latch on confirmed send).
// Suppresses the holding reply (but still escalates INFO) when a human answered from
// the phone (a human-device out-row newer than the stuck inbound, by event ts).

'use strict';

function createSlaWatchdog({
  db, escalate, sendHolding, resolveChat, defaults = {},
  slaMinutes = 10, logEvent = () => {}, logger = console, now = Date.now,
} = {}) {
  const latched = new Set(); // msg keys we've already holding-replied for

  // Candidate stuck turns: dispatched inbound, no completed turn, no reply row after it.
  const stuck = db.prepare(`
    SELECT m.* FROM messages m
     WHERE m.direction='in' AND m.handler_status='dispatched'
       AND NOT EXISTS (SELECT 1 FROM turn_metrics t WHERE t.chat_jid=m.chat_jid AND t.msg_id=m.msg_id AND t.error IS NULL)
  `);
  const humanAfter = db.prepare(`
    SELECT 1 FROM messages o
     WHERE o.chat_jid=? AND o.direction='out' AND o.source='human-device' AND o.ts > ? LIMIT 1
  `);
  const botReplyAfter = db.prepare(`
    SELECT 1 FROM messages o
     WHERE o.chat_jid=? AND o.direction='out' AND o.source='bot-reply' AND o.status='sent' AND o.ts >= ? LIMIT 1
  `);

  function holdAfterMs(chatJid) {
    const chat = resolveChat?.(chatJid) || {};
    const hardMs = chat.maxTurnHard || defaults.maxTurnHard || 90 * 60_000;
    return Math.max(slaMinutes * 60_000, hardMs + 120_000);
  }

  async function tick() {
    const t = now();
    for (const row of stuck.all()) {
      // a bot reply already went out for this turn → not stuck
      if (botReplyAfter.get(row.chat_jid, row.ts)) continue;
      if (t - row.ts < holdAfterMs(row.chat_jid)) continue;
      const key = `${row.chat_jid}:${row.msg_id}`;
      if (latched.has(key)) continue;

      const humanActive = humanAfter.get(row.chat_jid, row.ts);
      if (humanActive) {
        // A human is handling it from the phone — don't send a robotic reply, but a
        // wedged turn must never be fully invisible.
        await escalate('INFO', `turn stuck in ${row.chat_jid} but a human is answering in-chat (msg ${row.msg_id})`);
        latched.add(key);
        logEvent('sla-suppressed-human', { chatJid: row.chat_jid, msgId: row.msg_id });
        continue;
      }

      let delivered = false;
      try { delivered = await sendHolding(row); } catch (e) { logger.error?.('sla holding send', e?.message); }
      if (delivered) {
        latched.add(key); // latch only on confirmed send; a failed send retries next tick
        await escalate('INFO', `turn stuck > SLA in ${row.chat_jid} (msg ${row.msg_id}); sent holding reply`);
        logEvent('sla-holding-sent', { chatJid: row.chat_jid, msgId: row.msg_id });
      }
    }
  }

  return { tick, holdAfterMs, _latched: latched };
}

module.exports = { createSlaWatchdog };

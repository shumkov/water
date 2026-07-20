// Heartbeat (SPEC §4.5, §11) — writes ~/water/heartbeat.json every 60s (the
// MONITORING_SPEC heartbeat-file pattern) and provides the /healthz payload. netdata
// reads the file's freshness + the counts; /healthz returns 503 when stale.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createHeartbeat({ db, dataDir, account, intervalMs = 60_000, now = Date.now }) {
  const file = path.join(dataDir, 'heartbeat.json');
  const pendingOut = db.prepare("SELECT COUNT(*) c FROM messages WHERE direction='out' AND status='pending'");
  const escalated = db.prepare("SELECT COUNT(*) c FROM events WHERE kind='escalation-failed' AND ts > ?");
  // Distinct signal from `escalated` (SPEC: docs/AUTH_DISABLED_HANDLING_SPEC.md) — Ivan wants an
  // active auth-disabled outage diagnosable in Netdata as its own counter, not folded into the
  // generic escalation-failure count.
  const authDisabled = db.prepare("SELECT COUNT(*) c FROM events WHERE kind='auth-disabled' AND ts > ?");
  const lastWebhook = db.prepare("SELECT MAX(received_at) t FROM messages WHERE direction='in'");
  let lastBeat = now();
  let timer = null;

  function snapshot() {
    return {
      account, ts: now(),
      pending: pendingOut.get().c,
      escalated: escalated.get(now() - 3600_000).c,
      authDisabled: authDisabled.get(now() - 3600_000).c,
      lastWebhookAt: lastWebhook.get().t || null,
    };
  }

  function beat() {
    lastBeat = now();
    const snap = snapshot();
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snap));
      fs.renameSync(tmp, file); // atomic
      db.prepare("INSERT OR REPLACE INTO daemon_state (k,v) VALUES ('heartbeat_at', ?)").run(String(snap.ts));
    } catch { /* best effort */ }
    return snap;
  }

  // /healthz payload: heartbeat age drives the 200-vs-503 decision in the receiver.
  function healthPayload() {
    const snap = snapshot();
    return { heartbeatAgeS: Math.round((now() - lastBeat) / 1000), pending: snap.pending, escalated: snap.escalated, authDisabled: snap.authDisabled, lastWebhookAt: snap.lastWebhookAt };
  }

  function start() { beat(); timer = setInterval(beat, intervalMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); }

  return { start, stop, beat, healthPayload, snapshot, file };
}

module.exports = { createHeartbeat };

// Escalation gate for classify()'s 'authDisabled' kind (SPEC: docs/AUTH_DISABLED_HANDLING_SPEC.md).
// AUTH_DISABLED is account-wide (Anthropic disabled Claude Code / subscription access), so every
// chat's turns fail identically for the duration of the outage — this gate escalates once per
// outage instead of once per failed turn, own file/tests like sla-watchdog.js/transport-watchdog.js
// (dispatcher.js has no account-wide state today and must not own this).

'use strict';

function createAuthDisabledGate({ escalate = null, logEvent = () => {}, logger = console } = {}) {
  let escalated = false; // provisional latch: true once an escalate attempt is in flight or
                          // confirmed sent for the current outage — not "outage is active".

  function onFailure({ sessionKey, msgId } = {}) {
    // Fires on EVERY AUTH_DISABLED-coded turn failure, not deduped — feeds the heartbeat.js
    // counter regardless of whether the escalate call below dedupes.
    logEvent('auth-disabled', { chatJid: sessionKey, msgId });
    logger.error?.(`[auth] Claude Code access disabled — turn for ${sessionKey} rejected. Re-enable in the Anthropic Console or set ANTHROPIC_API_KEY.`);

    if (escalated) return;
    // Set BEFORE the async call — the check-and-set above is synchronous (no await in between),
    // so concurrently-failing chats in the same tick can't double-fire this.
    escalated = true;
    if (!escalate) return;
    // Fire-and-forget: must not be awaited by the caller (dispatcher's catch block runs while
    // holding that chat's per-session dispatch lock — escalate() must never hold it).
    Promise.resolve(escalate('CRITICAL', 'water: Claude Code access disabled -- re-enable in Console or set ANTHROPIC_API_KEY'))
      .then((sent) => { if (!sent) escalated = false; })   // no-op (no ipcBot) or failed send —
      .catch((e) => {                                       // un-latch so the NEXT occurrence retries.
        escalated = false;
        // escalate() itself already logs its own known failure modes (IPC down, no ipcBot) —
        // reaching this catch means something UNEXPECTED broke, which is exactly the case an
        // operator most needs to hear about. Must not be silent.
        logger.error?.(`[auth-disabled-gate] escalate() threw unexpectedly: ${e?.message}`);
        logEvent('auth-disabled-escalate-error', { error: e?.message });
      });
  }

  // Any successful turn proves the outage ended (AUTH_DISABLED blocks the whole account, so
  // nothing can succeed while it's active) — safe to call on every successful dispatch.
  function onSuccess() { escalated = false; }

  return { onFailure, onSuccess };
}

module.exports = { createAuthDisabledGate };

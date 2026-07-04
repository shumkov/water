// provenance: polygram@0.17.11 lib/session-key.js (git 746bca6) — adapt: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Session-key derivation for per-chat (and optionally per-topic) Claude
 * sessions.
 *
 * Default behaviour (no `isolateTopics` or `false`): all topics in a chat
 * collapse into a single session keyed by chat_id. Claude sees every
 * topic's messages in one context window. This is the intuitive default —
 * topics are usually organisational (like Slack #channels), not genuine
 * project boundaries. Outbound replies still land in the originating topic
 * via `message_thread_id`, and the prompt stamps `topic="..."` on every
 * inbound message so Claude can follow parallel dialogs within the shared
 * session.
 *
 * Opt-in (`isolateTopics: true`): each topic gets its own Claude session
 * with its own `claude_session_id`. Context is tightly isolated — Orders
 * topic's conversation can't bleed into Billing topic's memory. This
 * matches OpenClaw's model and is the right call when topics represent
 * genuinely separate projects.
 *
 * rc.48: per-topic config overrides. `topics[threadId]` can be either a
 * string (legacy: just a label) or an object with optional fields:
 *   { name, agent, cwd, model, effort, permissionMode }
 * Object form lets a topic override chat-level config — typically used
 * to scope a single topic to a different agent (e.g. music-curation),
 * a different working dir, or to switch from `bypassPermissions` to
 * `default` so canUseTool prompts fire for sensitive operations in
 * that topic only. See getTopicConfig.
 *
 * Per-topic overrides only take effect when isolateTopics: true (each
 * topic has its own SDK Query). With isolateTopics: false all topics
 * share one Query; the Query's options are fixed at first-spawn time.
 * polygram emits a one-time startup warning if topic overrides are
 * configured on a non-isolating chat.
 */

'use strict';

function getSessionKey(chatId, threadId, chatConfig) {
  const isolate = chatConfig?.isolateTopics === true;
  if (threadId && isolate) return `${chatId}:${threadId}`;
  return chatId;
}

function getChatIdFromKey(sessionKey) {
  return sessionKey.split(':')[0];
}

/**
 * Inverse of `getChatIdFromKey`: returns the thread_id portion of an
 * isolated-topic sessionKey, or null when there's no thread suffix.
 * Used by rc.47 autonomous-wakeup routing — when ScheduleWakeup
 * fires inside a polygram-spawned Query without a corresponding
 * pm.send, we derive (chat_id, thread_id) from sessionKey to route
 * the autonomous output back to the right Telegram chat/topic.
 */
function getThreadIdFromKey(sessionKey) {
  if (typeof sessionKey !== 'string' || !sessionKey) return null;
  const idx = sessionKey.indexOf(':');
  if (idx < 0) return null;
  const thread = sessionKey.slice(idx + 1);
  return thread || null;
}

/**
 * Resolve the human-readable name for a topic. Handles both the legacy
 * string form (`topics["100"] = "Orders"`) and the rc.48 object form
 * (`topics["200"] = { name: "Music", agent: "music-curation" }`). Falls
 * back to the threadId itself if the topic has no name field.
 */
function getTopicName(chatConfig, threadId) {
  if (threadId == null || threadId === '') return null;
  const t = chatConfig?.topics?.[threadId];
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object' && typeof t.name === 'string' && t.name) {
    return t.name;
  }
  return String(threadId);
}

/**
 * rc.48: extract per-topic SdkOptions overrides. Returns the topic
 * entry's overridable fields (model, effort, cwd, agent,
 * permissionMode), excluding `name` (which is a polygram label, not
 * an SdkOptions field — see getTopicName).
 *
 * Returns `{}` for:
 *   - missing threadId
 *   - missing chatConfig.topics
 *   - threadId not present in topics
 *   - legacy string topic entry (label-only, no overrides)
 *   - object with only `name`
 *
 * Callers (composeSdkOptions, polygram's spawn flow) merge this on
 * top of chat-level config. Per-topic overrides take HIGHEST
 * precedence — including overriding the chat-level permissionMode,
 * which is the principal rc.48 use case (loosen one topic from the
 * agent's `bypassPermissions` default to `default`).
 */
function getTopicConfig(chatConfig, threadId) {
  if (threadId == null || threadId === '') return {};
  const t = chatConfig?.topics?.[threadId];
  if (!t || typeof t !== 'object') return {};
  // Strip `name` — that's the label, not an override. Everything else
  // in the entry is an override candidate.
  const { name, ...overrides } = t;
  return overrides;
}

/**
 * Resolve the config object a per-chat/topic setting (model/effort) should be
 * WRITTEN to, given where the command/card was used. When in a topic, return
 * (creating if needed) that topic's override entry — so a /model in the Music
 * topic targets Music alone and matches what the per-topic card displays,
 * instead of leaking to the chat root and every other topic that inherits it
 * (the 2026-06-12 "/model in Music does nothing" bug). At the chat level
 * (no thread), the writable scope is the chat config itself.
 *
 * @returns {{ scope: object, threadId: (string|null) }}
 */
function getConfigWriteScope(chatConfig, threadId) {
  const tid = (threadId == null || threadId === '') ? null : String(threadId);
  // Mirror getSessionKey's isolation rule: a per-topic override only takes
  // effect when isolateTopics === true (otherwise every topic shares the
  // chatId-keyed session and topics[tid].model is silently ignored — the
  // 2026-06-12 review found the topic-scope fix re-broke /model on the DEFAULT
  // non-isolated chats and made the card lie). So write the topic scope ONLY
  // when isolated; otherwise write the chat root (the session that actually
  // runs), and report threadId:null so the audit row reflects chat-level reach.
  if (tid && chatConfig?.isolateTopics === true) {
    chatConfig.topics = chatConfig.topics || {};
    // A topic can be stored in the legacy / hand-edited form where the entry
    // is the bare name string (topics["329"] = "Advertising") rather than the
    // canonical object ({ name: "Advertising" }). getTopicConfig / getTopicName
    // already tolerate that; the write path must too — assigning a property to
    // a string throws under strict mode, which silently swallowed every /model
    // + /effort button tap in such a topic. Normalise to the object form,
    // preserving the name.
    const existing = chatConfig.topics[tid];
    if (typeof existing === 'string') {
      chatConfig.topics[tid] = { name: existing };
    } else if (!existing || typeof existing !== 'object') {
      chatConfig.topics[tid] = {};
    }
    return { scope: chatConfig.topics[tid], threadId: tid };
  }
  return { scope: chatConfig, threadId: null };
}

module.exports = {
  getSessionKey,
  getChatIdFromKey,
  getThreadIdFromKey,
  getTopicName,
  getTopicConfig,
  getConfigWriteScope,
};

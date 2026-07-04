// The ONE intake gate (SPEC §4.2, §7). One ordered chain decides, for every inbound,
// whether it dispatches a turn or is marked terminal `ignored(reason)`. Every
// non-dispatch outcome carries a typed reason code so "why didn't the bot answer?"
// is one query, and ignored rows can never trip replay or the SLA watchdog (I7).
//
// Pure decision logic — I/O (marking rows, emitting events) is the caller's job.
// Predicates are injected so the matrix is exhaustively testable.

'use strict';

const { isAbort } = require('./abort-detector');

const ADMIN_CMD = /^\/(model|effort|new|reset|status|config)\b/i;
const VERDICT_CMD = /^(approve|deny)\s+(\S+)/i;

// deps:
//   resolveChat(chatJid) -> effective chat config | null (null = not configured)
//   jidMap { identitySet(jid)->Set, matchesAny(jid, list)->bool, suffixKind(jid) }
//   botIdentity: Set of the bot's own bare JIDs {pn, lid}
//   adminJids: string[] (pn/lid forms)
//   dmPolicy, groupPolicy: 'allowlist'
//   hasOpenQuestionFor(chatJid, senderJid) -> bool
//   isAlbumSiblingOf(msg) -> bool   (media within window of an accepted msg, same sender)
//   isTurnInitiator(chatJid, senderJid) -> bool  (sender owns the in-flight turn)
function createGate(deps) {
  const {
    resolveChat, jidMap, botIdentity, adminJids = [],
    dmPolicy = 'allowlist', groupPolicy = 'allowlist',
    allowConfigCommands = false,
    hasOpenQuestionFor = () => false,
    isAlbumSiblingOf = () => false,
    isTurnInitiator = () => false,
  } = deps;

  const isAdmin = (jid) => jidMap.matchesAny(jid, adminJids);

  // Compile mentionPatterns ONCE per pattern string (cached), not per message — a
  // recompile-and-run on attacker-controlled text every message is wasteful and a
  // ReDoS amplifier. Patterns are already regex-validated at config load.
  const _reCache = new Map();
  function compiledPattern(pat) {
    let re = _reCache.get(pat);
    if (re === undefined) { try { re = new RegExp(pat, 'i'); } catch { re = null; } _reCache.set(pat, re); }
    return re;
  }

  // Does this message address the bot? (mention gating, NOT authorization)
  function isMentioned(msg, chat) {
    // native @mention of the bot
    for (const m of msg.mentions ?? []) {
      if (setHasIdentity(jidMap, botIdentity, m)) return true;
    }
    // quote-reply to one of the bot's own messages
    const qp = msg.quote?.participantJid;
    if (qp && setHasIdentity(jidMap, botIdentity, qp)) return true;
    // name-trigger regexes (mentionPatterns), case-insensitive, precompiled+cached
    for (const pat of chat.mentionPatterns ?? []) {
      const re = compiledPattern(pat);
      if (re && re.test(msg.text ?? '')) return true;
    }
    return false;
  }

  // Authorization: allowFrom (if present) must contain the sender's identity set.
  // Returns 'ok' | 'not-allowed' | 'unresolved-identity'.
  function authorize(msg, chat) {
    if (!chat.allowFrom || chat.allowFrom.length === 0) return 'ok';
    if (jidMap.matchesAny(msg.sender.jid, chat.allowFrom)) return 'ok';
    // lid-only sender with no known pn counterpart: we can't yet tell — flag distinctly
    // so a legitimate partner's first message is visible, not a silent drop.
    const set = jidMap.identitySet(msg.sender.jid);
    const lidOnly = jidMap.suffixKind(msg.sender.jid) === 'lid' && set.size === 1;
    return lidOnly ? 'unresolved-identity' : 'not-allowed';
  }

  function decide(msg) {
    const chat = resolveChat(msg.chatJid);

    // 1. configured-chat check (fail-closed allowlist)
    if (!chat) return ignore('unknown-chat');

    const sessionKey = msg.chatJid;

    // 2. never dispatch our own / other-device sends
    if (msg.isFromMe) return ignore('is-from-me', sessionKey);

    // 3. abort — for all chats, exempt from allowConfigCommands. Authorized when:
    //    DM ‖ admin ‖ the sender owns the in-flight turn.
    if (isAbort(msg.text)) {
      const dm = msg.chatType === 'dm';
      if (dm || isAdmin(msg.sender.jid) || isTurnInitiator(msg.chatJid, msg.sender.jid)) {
        return { action: 'abort', sessionKey };
      }
      // an unauthorized "stop" in a group is ordinary chatter → fall through
    }

    // 4. admin / verdict commands (adminJids only). Approval verdicts are ALWAYS
    //    available to admins (independent of allowConfigCommands — turning config
    //    commands off must not disable the approval surface, SPEC §8). Config
    //    commands (/model, /effort, /new, /status) additionally require the
    //    per-account allowConfigCommands flag; when off they fall through to the
    //    agent like any other text.
    const verdict = VERDICT_CMD.exec(msg.text ?? '');
    if (verdict && isAdmin(msg.sender.jid)) {
      return { action: 'command', kind: 'verdict', verb: verdict[1].toLowerCase(), id: verdict[2], sessionKey };
    }
    if (allowConfigCommands && ADMIN_CMD.test(msg.text ?? '') && isAdmin(msg.sender.jid)) {
      return { action: 'command', kind: 'config', sessionKey };
    }

    // 5. question-consume: an open question owned by this sender absorbs the reply
    if (hasOpenQuestionFor(msg.chatJid, msg.sender.jid)) {
      return { action: 'consume', sessionKey };
    }

    // 6. album-sibling inheritance: a media sibling of an accepted message dispatches
    if ((msg.attachments?.length ?? 0) > 0 && isAlbumSiblingOf(msg)) {
      return { action: 'dispatch', sessionKey, reason: 'album-sibling' };
    }

    // 7. shouldHandle: authorization AND mention gate
    const auth = authorize(msg, chat);
    if (auth === 'unresolved-identity') return ignore('unresolved-identity', sessionKey);
    if (auth === 'not-allowed') return ignore('not-allowed', sessionKey);

    if (msg.chatType === 'dm') return { action: 'dispatch', sessionKey };

    // group
    const requireMention = chat.requireMention !== false;
    if (!requireMention) return { action: 'dispatch', sessionKey };
    if (isMentioned(msg, chat)) return { action: 'dispatch', sessionKey };
    return ignore('unaddressed', sessionKey);
  }

  return { decide, isMentioned, authorize };
}

function ignore(reason, sessionKey) {
  return { action: 'ignore', reason, sessionKey };
}

// True if `jid` denotes any identity in the bot's own identity set (resolving both
// forms through the map).
function setHasIdentity(jidMap, botIdentity, jid) {
  for (const x of jidMap.identitySet(jid)) if (botIdentity.has(x)) return true;
  return false;
}

module.exports = { createGate };

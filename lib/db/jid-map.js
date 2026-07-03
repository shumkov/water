// WhatsApp identity resolution: phone-number JID <-> LID.
//
// Group senders can arrive as `<n>@lid` (AddressingMode:"lid") with the phone-number
// JID only in Info.SenderAlt, and only when whatsmeow knows the mapping. Allowlists /
// admin / mention checks must therefore match on the identity SET {pn, lid}, never on
// one form. This module is the store + the resolver. See SPEC §4.1 / §7.

'use strict';

function suffixKind(jid) {
  if (typeof jid !== 'string') return null;
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) return 'pn';
  if (jid.endsWith('@lid')) return 'lid';
  return null;
}

// Normalize a JID to bare "<user>@<server>", dropping a device suffix like ":3"
// (66821683034:3@s.whatsapp.net -> 66821683034@s.whatsapp.net) so identity compares
// are device-independent.
function bareJid(jid) {
  if (typeof jid !== 'string') return jid;
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  let user = jid.slice(0, at);
  const server = jid.slice(at + 1);
  const colon = user.indexOf(':');
  if (colon >= 0) user = user.slice(0, colon);
  return `${user}@${server}`;
}

function createJidMap(db) {
  const upsert = db.prepare(`
    INSERT INTO jid_map (pn_jid, lid_jid, push_name, first_seen_ts, last_seen_ts)
    VALUES (@pn, @lid, @pushName, @ts, @ts)
    ON CONFLICT(pn_jid, lid_jid) DO UPDATE SET
      last_seen_ts = @ts,
      push_name = COALESCE(@pushName, push_name)
  `);
  const byPn = db.prepare('SELECT * FROM jid_map WHERE pn_jid = ?');
  const byLid = db.prepare('SELECT * FROM jid_map WHERE lid_jid = ?');

  // Record a (pn, lid) pair observed together on one message. Either side may be
  // absent; a pair with only one known side is not stored (nothing to map yet).
  function observe({ pn, lid, pushName, ts }) {
    const p = pn ? bareJid(pn) : null;
    const l = lid ? bareJid(lid) : null;
    if (!p || !l) return; // need both forms to record a mapping
    upsert.run({ pn: p, lid: l, pushName: pushName ?? null, ts: ts ?? Date.now() });
  }

  // Observe from a normalized sender {jid, altJid}: classify each side by suffix and
  // pair them if one is pn and the other is lid.
  function observeSender({ jid, altJid, pushName, ts }) {
    const a = { kind: suffixKind(jid), jid };
    const b = { kind: suffixKind(altJid), jid: altJid };
    const pn = [a, b].find((x) => x.kind === 'pn')?.jid;
    const lid = [a, b].find((x) => x.kind === 'lid')?.jid;
    if (pn && lid) observe({ pn, lid, pushName, ts });
  }

  // Return the identity SET for a JID: the JID itself (bare) plus any known
  // counterpart form. Used by every allowlist / admin / mention comparison.
  function identitySet(jid) {
    const bare = bareJid(jid);
    const set = new Set([bare]);
    const kind = suffixKind(bare);
    if (kind === 'pn') {
      for (const r of db.prepare('SELECT lid_jid FROM jid_map WHERE pn_jid = ?').all(bare)) {
        if (r.lid_jid) set.add(r.lid_jid);
      }
    } else if (kind === 'lid') {
      for (const r of db.prepare('SELECT pn_jid FROM jid_map WHERE lid_jid = ?').all(bare)) {
        if (r.pn_jid) set.add(r.pn_jid);
      }
    }
    return set;
  }

  // True if two JIDs denote the same identity (either equal bare, or mapped).
  function sameIdentity(a, b) {
    const setA = identitySet(a);
    return setA.has(bareJid(b));
  }

  // True if `jid` matches any allowlist entry, resolving through the map both ways.
  function matchesAny(jid, allow) {
    const set = identitySet(jid);
    for (const entry of allow) {
      const eBare = bareJid(entry);
      if (set.has(eBare)) return true;
      // Also expand the allowlist entry's own identity set (entry may be pn, sender lid).
      for (const x of identitySet(eBare)) if (set.has(x)) return true;
    }
    return false;
  }

  // Seed a known pair (from wuzapi resolveLid or group participant lists).
  function seed({ pn, lid, ts }) {
    observe({ pn, lid, ts });
  }

  return { observe, observeSender, identitySet, sameIdentity, matchesAny, seed, bareJid, suffixKind,
    _byPn: (pn) => byPn.get(bareJid(pn)), _byLid: (lid) => byLid.get(bareJid(lid)) };
}

module.exports = { createJidMap, bareJid, suffixKind };

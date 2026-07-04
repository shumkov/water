// provenance: polygram@0.17.11 lib/db/sessions.js (git 746bca6) — adapt: WhatsApp
// sessionKey = chat JID (no topics); spawn-identity drift healing kept. Maps a chat
// to its claude_session_id (for --resume) + the spawn identity it was created under.

'use strict';

// Spawn-identity fields: if any of these drift from the stored session, the old
// conversation was built under a different agent/cwd — resuming it would run under
// the wrong context, so we drop the row and spawn fresh. model/effort are applied
// live (no respawn) and are NOT identity.
const SPAWN_IDENTITY = ['agent', 'cwd'];

function createSessions(db) {
  const get = db.prepare('SELECT * FROM sessions WHERE session_key = ?');
  const upsert = db.prepare(`
    INSERT INTO sessions (session_key, chat_jid, claude_session_id, agent, cwd, model, effort, pm_backend, created_ts, last_active_ts)
    VALUES (@sessionKey, @chatJid, @claudeSessionId, @agent, @cwd, @model, @effort, @pmBackend, @ts, @ts)
    ON CONFLICT(session_key) DO UPDATE SET
      claude_session_id = @claudeSessionId, agent = @agent, cwd = @cwd,
      model = @model, effort = @effort, pm_backend = @pmBackend, last_active_ts = @ts
  `);
  const clear = db.prepare('DELETE FROM sessions WHERE session_key = ?');

  // Resolve the session id to resume for a fresh spawn, healing drift: if the stored
  // spawn identity (agent/cwd) differs from what we're about to spawn, drop the row
  // and return null so the spawn starts fresh under the new identity.
  function resolveForSpawn(sessionKey, spawnCtx) {
    const row = get.get(sessionKey);
    if (!row) return null;
    for (const f of SPAWN_IDENTITY) {
      if ((row[f] ?? null) !== (spawnCtx[f] ?? null)) {
        clear.run(sessionKey);
        return null;
      }
    }
    return row.claude_session_id;
  }

  function persist(sessionKey, { chatJid, claudeSessionId, agent, cwd, model, effort, pmBackend = 'cli', ts = Date.now() }) {
    if (!claudeSessionId) return;
    upsert.run({ sessionKey, chatJid, claudeSessionId, agent: agent ?? null, cwd: cwd ?? null, model: model ?? null, effort: effort ?? null, pmBackend, ts });
  }

  function clearSession(sessionKey) { clear.run(sessionKey); }

  return { get: (k) => get.get(k), resolveForSpawn, persist, clearSession };
}

module.exports = { createSessions, SPAWN_IDENTITY };

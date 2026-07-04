// provenance: polygram@0.17.11 lib/claude-bin.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// 0.12 Phase 4: moved from lib/process/tmux-process.js into the helper module
// that consumes it, so the constant survives TmuxProcess deletion. CliProcess
// + spike scripts + polygram boot all import from here now.
// 0.12.0-rc.18: bumped 2.1.142 → 2.1.158 (latest installed) chasing the
// dev-channels reliability issues (see docs/0.12.0-known-issues.md).
// 0.12.0-rc.38: bumped 2.1.158 → 2.1.173. Two reasons: (1) the ~32s startup
// deaths root-caused 2026-06-11 to a stale MCP connect-timeout racing the
// --resume session-id swap — a newer claude may fix the timer (2.1.173 also
// adds "Channel notifications re-registered after reconnect"); (2) keep the
// research-preview channels current. Per-bump re-validation done 2026-06-11:
// resume-dialog env vars survive (CLAUDE_CODE_RESUME_THRESHOLD_MINUTES /
// _TOKEN_THRESHOLD), trust + dev-channels dialogs unchanged, "esc to
// interrupt" hint unchanged (template-rendered), but the channels READY
// banner text CHANGED → readySignal in cli-process.js matches both forms.
// Re-validate the channel flow on each bump via
// tests/e2e-channels-real-claude.test.js (run with E2E_REAL_CLAUDE=1).
const CLAUDE_CLI_PINNED_VERSION = '2.1.173';

/**
 * Resolve + verify the pinned claude CLI binary.
 *
 * Why this exists: the tmux + CLI backends read claude CLI internal
 * artefacts (TUI banner ASCII, READY hint strings, channel notification
 * registration timing, MCP-init order) — none a stable public contract.
 * polygram pins ONE version (`CLAUDE_CLI_PINNED_VERSION`) and must
 * spawn THAT binary, never whatever `claude` on $PATH happens to
 * resolve to.
 *
 * Before this module the tmux runner spawned the bare string
 * `claude`, resolved through $PATH. The claude CLI installs each
 * version as a standalone binary at
 *   ~/.local/share/claude/versions/<version>
 * and points ~/.local/bin/claude (a symlink) at the active one.
 * Its auto-updater re-points that symlink whenever a new version
 * lands — so a $PATH spawn silently drifts (shumorobot 2026-05-16:
 * CLI auto-updated 2.1.142 → 2.1.143 between deploys).
 *
 * Spawning the ABSOLUTE versioned path avoids the symlink-drift, but is
 * NOT immune to the updater: claude keeps only the ~3 newest versions
 * and PRUNES (deletes) the rest. Once the pin falls out of the top 3 the
 * pinned path is a dead file → every cli spawn exits in ~14ms (prod
 * outages 2026-06-21/22). So `verifyPinnedClaudeBin` (point-in-time check)
 * is not enough; `ensureVendoredClaudeBin` (below, 0.17) keeps a
 * polygram-owned copy the pruner can't touch.
 */

/**
 * Absolute path to the pinned claude binary.
 *
 * Resolution order:
 *   1. WATER_CLAUDE_BIN env — explicit override (non-standard
 *      installs, CI, hosts where the layout differs).
 *   2. ~/.local/share/claude/versions/<version> — the standard
 *      claude-CLI install location.
 *
 * The returned path is NOT guaranteed to exist — callers verify
 * via verifyPinnedClaudeBin().
 *
 * @param {string} version — pinned version, e.g. '2.1.142'
 * @returns {string} absolute path
 */
function resolvePinnedClaudeBin(version) {
  const override = process.env.WATER_CLAUDE_BIN;
  if (override) return override;
  return path.join(os.homedir(), '.local', 'share', 'claude', 'versions', version);
}

/**
 * Verify the pinned binary exists and is executable.
 *
 * @param {string} version — pinned version, e.g. '2.1.142'
 * @returns {{ ok: boolean, path: string, reason?: string }}
 *   ok=true → path is a spawnable binary.
 *   ok=false → reason carries an operator-actionable message.
 */
function verifyPinnedClaudeBin(version) {
  const binPath = resolvePinnedClaudeBin(version);
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return { ok: true, path: binPath };
  } catch (err) {
    const code = err && err.code ? err.code : (err && err.message) || 'unknown';
    return {
      ok: false,
      path: binPath,
      reason: `pinned claude CLI v${version} not found or not executable at `
        + `${binPath} (${code}). Install it with \`claude install ${version}\` `
        + 'or set WATER_CLAUDE_BIN to the correct binary path.',
    };
  }
}

// ─── 0.17: vendored pinned binary (immune to claude's auto-pruner) ──────────
//
// claude's updater deletes all but the ~3 newest versions, so the pinned
// version eventually vanishes from ~/.local/share/claude/versions and every
// cli spawn dies. We can't fall forward (the cli backend reads version-specific
// TUI internals). Fix: polygram keeps its OWN copy of the exact pinned binary
// in a dir the pruner never touches, and spawns from there. Once vendored it
// never depends on the system copy or the network again.

/**
 * polygram-owned vendor dir for claude binaries. Under ~/.local/share/water
 * (XDG data) — claude's pruner only touches ~/.local/share/claude/versions, and
 * `npm i -g polygram` only replaces the package dir, so this survives both.
 * Override with WATER_CLAUDE_VENDOR_DIR.
 */
function vendorDir() {
  return process.env.WATER_CLAUDE_VENDOR_DIR
    || path.join(os.homedir(), '.local', 'share', 'polygram', 'claude-bin');
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// Atomic: copy to a unique tmp in the same dir, chmod, then rename over.
function _atomicCopyExec(src, dst) {
  const tmp = `${dst}.tmp.${process.pid}.${Date.now()}`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dst);
}

// Remove vendored binaries (and stale .tmp.*) that aren't the live version.
function _gcVendored(dir, keepVersion, logger) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === keepVersion) continue;
    // Never delete an in-flight copy: a CONCURRENT boot (multi-bot host shares
    // this dir) may be mid-copy into `<keepVersion>.tmp.<pid>.<ts>`; removing it
    // ENOENTs that boot's rename → it falls back to SDK. Skip all .tmp.* — a
    // genuinely orphaned tmp is cheap to leave (cleaned when its version is GC'd
    // by name, or harmless). Defense-in-depth: only GC version-shaped names so a
    // misconfigured vendor dir can't nuke unrelated files.
    if (name.includes('.tmp.')) continue;
    if (!/^\d+\.\d+\.\d+$/.test(name)) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch (e) {
      logger?.warn?.(`[claude-bin] vendor GC: could not remove ${name}: ${e.message}`);
    }
  }
}

/**
 * Ensure a polygram-owned copy of the pinned claude binary exists and return
 * its path. Steady state is a single stat (fast). On a cold/pruned host it
 * obtains the binary once (copy from the system install, else `claude install`
 * then copy) and caches it forever.
 *
 * @param {string} version
 * @param {{ logger?: object }} [opts]
 * @returns {{ ok: boolean, path: string, vendored?: boolean, reason?: string }}
 */
function ensureVendoredClaudeBin(version, { logger = console } = {}) {
  // Explicit override wins, unchanged — non-standard installs / CI / tests.
  const override = process.env.WATER_CLAUDE_BIN;
  if (override) {
    return isExecutable(override)
      ? { ok: true, path: override, vendored: false }
      : { ok: false, path: override, reason: `WATER_CLAUDE_BIN=${override} not executable` };
  }

  const dir = vendorDir();
  const vendored = path.join(dir, version);

  // Fast path: already vendored.
  if (isExecutable(vendored)) {
    _gcVendored(dir, version, logger);
    return { ok: true, path: vendored, vendored: true };
  }

  // Need to obtain it. Ensure the dir exists.
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return { ok: false, path: vendored, reason: `cannot create vendor dir ${dir}: ${e.message}` };
  }

  const versionsDir = process.env.WATER_CLAUDE_VERSIONS_DIR
    || path.join(os.homedir(), '.local', 'share', 'claude', 'versions');
  const systemPath = path.join(versionsDir, version);

  // (a) copy from the system install if present.
  if (isExecutable(systemPath)) {
    try {
      _atomicCopyExec(systemPath, vendored);
      logger?.log?.(`[claude-bin] vendored claude v${version} ← ${systemPath} → ${vendored}`);
    } catch (e) {
      return { ok: false, path: vendored, reason: `copy ${systemPath} → ${vendored} failed: ${e.message}` };
    }
  } else {
    // (b) try to install the exact version, then copy. If
    // WATER_CLAUDE_INSTALL_BIN is set, use it VERBATIM (no fallback — an
    // explicit override that's wrong must fail loudly, not silently shell out to
    // a different claude). Otherwise prefer ~/.local/bin/claude, else PATH.
    let installerBin = process.env.WATER_CLAUDE_INSTALL_BIN;
    if (!installerBin) {
      const localBin = path.join(os.homedir(), '.local', 'bin', 'claude');
      installerBin = isExecutable(localBin) ? localBin : 'claude';
    }
    logger?.warn?.(`[claude-bin] pinned claude v${version} absent from ${systemPath}; installing via ${installerBin}…`);
    try {
      // Synchronous: blocks boot until the install completes. Rare (deploys
      // pre-install the pin → the fast copy path above is the norm). On the VPS
      // polygram boots DETACHED in tmux (Type=oneshot start-sessions.sh), so
      // this block is NOT gated by systemd's TimeoutStartSec; on the Mac launchd
      // has no hard start-timeout. Timeout kept under the VPS unit's 120s anyway.
      execFileSync(installerBin, ['install', version], { timeout: 110_000, stdio: 'ignore' });
    } catch (e) {
      return {
        ok: false, path: vendored,
        reason: `claude v${version} not present and \`claude install ${version}\` failed (${e.message}). `
          + 'Install it manually or set WATER_CLAUDE_BIN.',
      };
    }
    if (!isExecutable(systemPath)) {
      return { ok: false, path: vendored, reason: `claude install ${version} ran but ${systemPath} still missing` };
    }
    try {
      _atomicCopyExec(systemPath, vendored);
      logger?.log?.(`[claude-bin] installed + vendored claude v${version} → ${vendored}`);
    } catch (e) {
      return { ok: false, path: vendored, reason: `copy after install failed: ${e.message}` };
    }
  }

  _gcVendored(dir, version, logger);
  if (!isExecutable(vendored)) {
    return { ok: false, path: vendored, reason: `vendored copy ${vendored} is not executable after copy` };
  }
  return { ok: true, path: vendored, vendored: true };
}

module.exports = {
  resolvePinnedClaudeBin,
  verifyPinnedClaudeBin,
  ensureVendoredClaudeBin,
  vendorDir,
  CLAUDE_CLI_PINNED_VERSION,
};

# Shared-library strategy: copy now, extract later

**Decision (Ivan, 2026-07-04):** copy polygram's interactive-Claude-session engine
into water now (with provenance), extract it into a shared library only after water
is in production. This doc records why, and how to keep the eventual extraction cheap.

## What is (and isn't) shareable

The reusable surface is one layer, not polygram-as-a-whole: the **interactive
Claude-CLI session engine** — the part that spawns, injects into, observes, and
recovers a long-lived `claude` process, independent of which chat network the
messages came from. Verified transport-agnostic during research (chat IDs are opaque
strings to it):

- `process/process-manager.js` — weighted LRU pool, spawn/evict/pin, lazy respawn
- `process/cli-process.js` — the tmux'd claude CLI driver (argv assembly, startup
  gate, finalizer ladder, input ledger, busy-aware ceilings, mid-turn watchdogs)
- `process/channels-bridge*.{mjs,js}` — the MCP channels injection protocol
- `process/hook-*.js` — hooks-ndjson turn observability
- `tmux/*` — tmux lifecycle (spawn, startup-gate, orphan-sweep, log-tail)
- `claude-bin.js` — pin + vendor the claude binary (the module behind the outages)
- `process/factory.js`, `process/process.js` — the backend abstraction + base class

NOT shareable (transport-specific, stays in each consumer): everything that touches
the network's message shape, delivery API, gate/policy, or persistence schema.

## Why copy now instead of extract now

- Extraction is a **refactor of production polygram** (a revenue system): pull ~4,000
  lines of its most load-bearing code into a package, re-wire the daemon, re-run
  ~1,600 tests — real risk, zero immediate water benefit.
- "Transport-agnostic" ≠ "already a clean library." The layer still carries
  polygram-isms (daemon-side socket server wiring, event names, `POLYGRAM_*` env).
  A shared package means **designing** that API — a project of its own.
- Designing the API now means designing it against **one** consumer (water doesn't
  exist yet). The right time to factor out a shared abstraction is when a second real
  consumer exists and the true seams have revealed themselves — the "write it twice
  before you extract" rule.
- Two release cadences would couple: a water fix needing a lib tweak would gate on a
  polygram release, and vice versa.
- The channels API is research-preview and can change/vanish upstream. Two copies can
  be pinned and patched independently while it's unstable; a shared lib around an
  unstable contract is more fragile, not less.

## How to keep the future extraction cheap (rules for the copy)

1. **Copy verbatim.** The only edits allowed inside these files are values already
   parameterized: env-var prefix (`POLYGRAM_` → `WATER_`), the bridge server name
   (`polygram-bridge` → `water-bridge`), the vendor path, and the tmux session
   prefix. No logic changes, no reformatting, no "while I'm here" cleanups.
2. **Provenance header on every file:**
   `// provenance: polygram@<version> lib/<path> (git <sha>) — verbatim*: <constants changed>`
   `verbatim*` = only the parameterized constants above differ; `adapt` = structural
   change (must be justified in the header). Anything marked `adapt` will need manual
   reconciliation at extraction time — keep that set as small as possible.
3. **Isolate the parameterized constants** at the top of each module (or in a small
   `process/params.js`) so a future extraction replaces one config object, not a
   scattered find-replace.
4. **Keep the copies diff-clean against upstream.** Periodically
   `diff` water's `process/`+`tmux/` against the pinned polygram version; a clean
   diff (modulo the known constants) is the signal that extraction is still cheap.
   A growing diff is technical debt to pay down or consciously accept.
5. **Don't fork the pinned claude version casually.** water and polygram should track
   the same pinned CLI version (2.1.173) so the shared code's version-sensitive
   assumptions stay identical — divergence here is the most expensive kind.

## Extraction trigger + target (later)

Extract when ALL hold: water is in production; both consumers are stable; and either
a third channel appears OR the maintenance cost of keeping two copies in sync becomes
real (the diff in rule 4 keeps drifting). Target package: `@shumkov/claude-channels`
(or similar) — the session engine + the channels-bridge protocol + claude-bin, with a
small documented API surface designed against both real consumers. polygram and water
then both depend on it; the transport/persistence/gate layers stay in each.

## Low-risk early option (not taken now, available anytime)

`claude-bin.js` alone (pin + vendor, ~240 lines, pure, zero coupling — the exact
module behind the 2026-06-21/22 outages) could be extracted into a tiny shared
package independently of the rest, if de-duplicating just the binary-pinning pain
becomes worthwhile before the full extraction. Recorded here as an option, not a
current action.


---

## Status: extracted (water side) — 2026-07-04

The engine now lives in [`@shumkov/orchestra`](https://github.com/shumkov/orchestra); water depends on it (`file:../orchestra`, will be an npm range on publish). The real-claude E2E passes against the extracted package (a WhatsApp message injected via the bridge round-trips through `mcp__water-bridge__reply`). Two cli-process app-couplings (display-hint, file-cap) became injected options — the only divergence from the proven copy; recorded in orchestra's `docs/EXTRACTION.md`.

**Polygram migration is NOT done here** — it modifies a production revenue system and gets its own spec + review + Ivan's merge (see below).

# Provenance

water reuses polygram's proven modules by **copy with provenance**, not by depending
on polygram internals (see [`SHARED-LIB.md`](./SHARED-LIB.md) for why). Every copied
file carries a header:

```
// provenance: polygram@<version> lib/<path> (git <sha>) — <mode>: <what changed>
```

`verbatim` = identifiers/renames only · `verbatim*` = only parameterized constants
(env prefix, bridge name, vendor path) differ · `adapt` = structural change (justified
in the header) · new files have no header.

Reference upstream: **polygram@0.17.11** (git `746bca6`) at
`~/Projects/shumkov/polygram`. Keep copies diff-clean against this pin (SHARED-LIB
rule 4); a growing diff is debt to pay down or consciously accept.

## Map (implemented so far)

| water file | polygram origin | mode | notes |
|---|---|---|---|
| `lib/db.js` | `lib/db.js` | adapt | migration runner; user_version derived from max file number (closes the bump-the-constant footgun); water schema |
| `lib/config.js` | `lib/config.js` + `config-scope.js` | adapt | WhatsApp accounts/chats shape, no bots/topics |
| `lib/handlers/record-inbound.js` | `lib/handlers/record-inbound.js` | adapt | InboundMessage envelope, string ids, dedup on (chat,sender,msg) |
| `lib/handlers/abort-detector.js` | `lib/abort-detector.js` | adapt | + Thai keyword set |
| `lib/handlers/gate.js` | `lib/handlers/gate-inbound.js` | adapt (rewrite-heavy) | WhatsApp predicates, `ignored` terminal marking, LID-resolved allowlist |

## New (water-authored, no polygram origin)

`lib/transport/{hmac,normalize,client,webhook-receiver}.js`,
`lib/db/{jid-map,outbound}.js` — the WuzAPI transport edge and WhatsApp-specific
identity/outbound lifecycle. These are the parts polygram has no analog for.

## To be copied (Phase 1b — verbatim*/adapt)

`lib/process/*` (process-manager, cli-process, channels-bridge*, factory,
hook-*), `lib/tmux/*`, `lib/claude-bin.js`, `lib/process-guard.js`,
`lib/async-lock.js`, `lib/queue-utils.js`, `lib/secret-detect.js`,
`lib/db/{sessions,auto-resume,replay-window,sent-cache,events-retention,secret-sweep,inbox}.js`,
`lib/handlers/{dispatcher,redeliver,drop-redeliver,replay-disposition}.js`,
`lib/error/{classify,net}.js`, `lib/ipc/{server,client}.js`,
`lib/delivery/{streamer,chunk}.js` (← `lib/telegram/*`), `lib/voice/*`,
`lib/prompt.js`. Each gets a provenance header at copy time.

# water

A WhatsApp daemon for Claude Code. One interactive Claude session per WhatsApp chat
(group or DM), driven over [WuzAPI](https://github.com/asternic/wuzapi) (whatsmeow),
inheriting the reliability architecture of [polygram](https://github.com/shumkov/polygram)
(its Telegram sibling).

Built to replace the UMI business's failing Baileys channel plugin: a durable SQLite
inbox, boot replay with turn-completion gating, a pinned+vendored `claude` binary, and
an SLA watchdog so a customer never waits hours for a reply.

> Status: **in development.** Design is complete and reviewed; the foundation and
> transport edge are built and tested. Not yet deployed. See the docs below.

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — design + rationale (architecture, data model,
  failure modes, invariants, deployment). The source of truth.
- [`docs/wuzapi-contract.md`](docs/wuzapi-contract.md) — the WuzAPI transport contract,
  verified against source.
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — module tree, migrations, contracts,
  build task plan.
- [`docs/SHARED-LIB.md`](docs/SHARED-LIB.md) — the copy-now/extract-later decision for
  polygram's session engine.
- [`docs/PROVENANCE.md`](docs/PROVENANCE.md) — which modules are copied from polygram.

## Architecture (one line)

```
WhatsApp ⇄ WuzAPI (docker, loopback) ⇄ water daemon (SQLite inbox, per-chat gate,
           write-before-ack/send)      ⇄ one interactive `claude` CLI per chat JID
```

## Develop

Requires Node ≥ 22.

```bash
npm install
npm test          # unit + integration, no network, no live WhatsApp
```

## Licence

MIT.

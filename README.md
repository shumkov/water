# water

A WhatsApp daemon for Claude Code. One interactive Claude session per WhatsApp chat
(group or DM), driven over [WuzAPI](https://github.com/asternic/wuzapi) (whatsmeow),
inheriting the reliability architecture of [polygram](https://github.com/shumkov/polygram)
(its Telegram sibling).

Built to replace the UMI business's failing Baileys channel plugin: a durable SQLite
inbox, boot replay with turn-completion gating, a pinned+vendored `claude` binary, and
an SLA watchdog so a customer never waits hours for a reply.

> Status: **code complete, pre-production.** Runs on the shared
> [`@shumkov/orchestra`](https://github.com/shumkov/orchestra) engine; 129 unit tests + a
> real-`claude` end-to-end proof pass. Not yet run against live WhatsApp — a staged cutover
> to replace the UMI Baileys plugin is specced. See the docs below.

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

## Install & run

water is a long-running daemon: it consumes a [WuzAPI](https://github.com/asternic/wuzapi)
webhook, gates messages, and drives one `claude` CLI session per chat. Setup is three
pieces — **WuzAPI** (the WhatsApp bridge), **water** (this daemon), and a **`config.json`**.

### Prerequisites

- **Node ≥ 22** and **tmux** (water spawns each `claude` in a tmux session).
- **Docker** (to run WuzAPI).
- A **WhatsApp account** + phone to link (WuzAPI is a linked-device bridge — you scan a QR).
- **Claude auth for a headless host.** water auto-vendors a pinned `claude` binary
  (`2.1.173`) on first boot, but the spawned `claude` still needs to authenticate. On a
  server, generate a long-lived token with `claude setup-token` and export it (e.g. source
  it from the systemd unit) so subprocesses don't need the desktop keychain.

### 1. WuzAPI — the WhatsApp bridge

Run WuzAPI bound to **loopback only** (water talks to it over `127.0.0.1`; never expose it):

```bash
docker run -d --name wuzapi --restart unless-stopped \
  -p 127.0.0.1:8099:8080 \
  -v wuzapi-dbdata:/app/dbdata \           # ⚠️ the whatsmeow session store lives in /app/dbdata
  -e WUZAPI_ADMIN_TOKEN=<admin-token> \
  asternic/wuzapi
```

> **Persist `/app/dbdata`, not `/app/data`.** WuzAPI keeps `main.db` (the whatsmeep device
> pairing) and `users.db` (user tokens) in `/app/dbdata`, next to the binary. If that isn't
> on a named volume/bind, recreating the container **loses the pairing** and you must
> re-scan the QR.

Then create a user and link your WhatsApp (via WuzAPI's admin API or its web UI at
`http://127.0.0.1:8099`):

1. `POST /admin/users` (with the admin token) → returns a **user token** — this is
   `wuzapi.userToken` in water's config.
2. Connect the user and **scan the QR** with WhatsApp → *Linked devices* on your phone.
   Verify `GET /session/status` returns `loggedIn: true`.
3. Point WuzAPI's **webhook** at water and subscribe to message events:
   `POST /webhook` with `{"webhook": "http://127.0.0.1:8090/hook/water", "events": ["Message"]}`
   (host/port/path must match `webhook.port` + `webhook.pathToken` below). Set the shared
   **HMAC secret** WuzAPI signs with to the same value as water's `wuzapi.hmacKey`.

> **WuzAPI-in-Docker → water-on-host: don't use `127.0.0.1` in the webhook URL.** WuzAPI
> posts the webhook from *inside* its container, where `127.0.0.1` is the container's own
> loopback — not the host. If water runs on the host, `http://127.0.0.1:8090` is unreachable
> and **every message is silently dropped** (WuzAPI logs `connection refused` and dead-letters
> it). Instead bind water where the container can reach it and advertise that address: set
> `webhook.bindHost` to `0.0.0.0` and `webhook.advertiseHost` to the docker-bridge gateway
> (find it with `docker network inspect <net> -f '{{(index .IPAM.Config 0).Gateway}}'`, e.g.
> `172.21.0.1`), and use that same host in the webhook URL above. **Pin the network's
> subnet/gateway** (compose `ipam.config`) so the gateway IP is stable, and **firewall the
> port** so only the bridge subnet reaches it. When WuzAPI and water share a network namespace
> (host networking, or both in the same compose), the `127.0.0.1` defaults are correct.

See [`docs/wuzapi-contract.md`](docs/wuzapi-contract.md) for the exact endpoints/fields.

### 2. water

```bash
git clone https://github.com/shumkov/water && cd water
npm install                      # pulls @shumkov/orchestra (the shared engine)
```

The pinned `claude` binary vendors automatically on first run into
`~/.local/share/orchestra/claude-bin/2.1.173`. To point it elsewhere (or reuse an existing
vendored copy), set `ORCHESTRA_CLAUDE_VENDOR_DIR`.

### 3. Configure — `config.json`

Copy [`config.example.json`](config.example.json) and edit. Shape:

```jsonc
{
  "accounts": {
    "umi": {                                   // one process per account (--account umi)
      "wuzapi": {
        "baseUrl": "http://127.0.0.1:8099",    // WuzAPI REST base (loopback)
        "userToken": "<wuzapi-user-token>",    // from step 1.1 — sent as the `token` header
        "hmacKey": "<shared-webhook-hmac-secret>"  // MUST equal WuzAPI's webhook secret
      },
      "webhook": { "port": 8090, "pathToken": "water" },  // listens on <bindHost>:<port>/hook/<pathToken>
                                                          // + "bindHost"/"advertiseHost" if WuzAPI is dockerized (see step 3 note)
      "dmPolicy": "allowlist",                 // fail-closed: only configured chats are served
      "groupPolicy": "allowlist",
      "adminJids": ["<your-pn>@s.whatsapp.net", "<your-lid>@lid"],
      "mediaMaxMb": 32
    }
  },
  "chats": {
    "120363...@g.us": {                        // key = the WhatsApp JID (group @g.us / DM @s.whatsapp.net)
      "account": "umi",
      "agent": "umi-partner",                  // claude agent + workspace for THIS chat
      "cwd": "/home/you/agents/umi-sales",
      "model": "sonnet", "effort": "medium",
      "requireMention": true,                  // only act on @mention or reply-to-bot
      "mentionPatterns": ["\\bumi\\b"],
      "allowFrom": ["<partner-jid>"]           // optional per-chat sender allowlist
    }
  },
  "defaults": { "model": "sonnet", "effort": "medium" }
}
```

Config is validated **fail-loud** at boot — a bad/missing field aborts with a clear error.
`userToken` and `hmacKey` are secrets: keep them out of git (render from a secret store, or
a `config.json` outside the repo).

### 4. Run

```bash
node water.js --account umi --config ./config.json --dataDir ~/.water
```

- `--account <name>` (required) — which account block to serve; one daemon per account.
- `--config <path>` — defaults to `<dataDir>/config.json`.
- `--dataDir <dir>` — SQLite DB (`<account>.db`), the media inbox, and heartbeat live here;
  defaults to the current directory.

As a service (systemd):

```ini
[Service]
WorkingDirectory=/home/you/water
Environment=ORCHESTRA_CLAUDE_VENDOR_DIR=/home/you/.local/share/orchestra/claude-bin
ExecStart=/usr/bin/node water.js --account umi --config /home/you/.water/config.json --dataDir /home/you/.water
Restart=on-failure
```

### 5. Verify

- Send a WhatsApp message that addresses the bot (an `@mention` or reply) in a configured
  chat; watch the daemon log for the inbound → dispatch → `channels-delivered` round-trip.
- `curl http://127.0.0.1:8090/healthz` — `200` when healthy, `503` if the WuzAPI heartbeat
  is stale.

## Develop

```bash
npm install
npm test          # unit + integration, no network, no live WhatsApp
```

## Licence

MIT.

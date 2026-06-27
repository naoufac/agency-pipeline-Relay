# deploy/ — Relay infrastructure

The live `systemd` unit files that keep Relay durable (survive crash **and** reboot).
They are exact copies of what is installed in `/etc/systemd/system/`. Full runbook: [`../docs/OPERATIONS.md`](../docs/OPERATIONS.md).

## Units
- **`systemd/relay.service`** — the Relay HTTP server backing `board/api/email.naples.agency`.
  Reads `/root/agency-pipeline/.env` (gitignored; holds `MINIMAX_API_KEY` + `DATABASE_URL`).
  `Restart=always`, so a crash or reboot brings it straight back. (No build-time vendoring step — pages are built by the deterministic component renderer, so `npm install` is the only prerequisite.)
- **`systemd/anouf-named-tunnel.service`** — cloudflared named tunnel `anouf-chat`
  (UUID `269600e7-db71-4e84-99ea-fae3019fea23`) serving every `*.naples.agency` hostname. `Restart=always`.
- Postgres is the `ap-pg` Docker container, set to `--restart unless-stopped` (survives reboot).

## Install / restore on a fresh box
```bash
cp deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now relay anouf-named-tunnel
docker update --restart unless-stopped ap-pg
# create /root/agency-pipeline/.env from .env.example (MINIMAX_API_KEY + DATABASE_URL) first —
# without it Relay boots in STUB mode and ships fake sites.
```

## Prove it survives a crash (deterministic, never trust self-report)
```bash
kill -9 $(systemctl show -p MainPID --value relay); sleep 4
systemctl is-active relay
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/board   # expect 200
```

## Why a tunnel and not a new Caddy/grey-cloud DNS
Both public `:80/:443` on the only IP are owned by another tenant's stack (`saiid-wp`), there is no
Cloudflare API token on the box for DNS edits, and grey-clouding would expose the origin IP. The flakiness
was never Cloudflare itself — it was that cloudflared ran **unsupervised**. Supervising it (this unit) is the
lowest-blast-radius "works for life" fix. Tailscale Funnel (`anouf.tailbb043c.ts.net` → `:8787`) remains a
redundant, already-supervised path to Relay. Full rationale: `../docs/OPERATIONS.md` §8.

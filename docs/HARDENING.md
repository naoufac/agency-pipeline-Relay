# Relay — Hardening backlog

Output of the 2026-06-27 durability review (20 findings across infra + code). Every "done"
is a deterministic external check, never an agent's word. Items are ranked; **DONE** are applied
and verified, **DEFER** are real but need load-testing or cross-tenant coordination.

## DONE (applied + verified 2026-06-27)
- **Supervise the public path.** cloudflared now runs under `anouf-named-tunnel.service` (`Restart=always`,
  enabled) instead of a hand-started process; Relay runs under `relay.service` (`Restart=always`, enabled,
  env from `.env`); Postgres `ap-pg` is `--restart unless-stopped`. Crash-tested: SIGKILL → respawn in 2–3s → board 200.
- **Capture the secret.** `MINIMAX_API_KEY`/`DATABASE_URL` lived only in the running process (no `.env` on disk);
  now persisted to `/root/agency-pipeline/.env` (gitignored, mode 600) and loaded via systemd `EnvironmentFile`.
- **Fresh-clone safety — Tailwind removed entirely.** The whole un-styled-fresh-clone failure mode is gone:
  the ~120 MB `tools/tailwindcss` binary, `tools/setup.sh`, the `package.json` `postinstall`, and the
  `relay.service` `ExecStartPre` were all **deleted**. The deterministic render engine (`src/render.ts` +
  `src/components.ts`) composes every page from vetted components with an inlined design-system `<style>`, so
  pages are complete by construction — there is no binary to vendor and nothing a redeploy can leave un-styled.
- **No more silent lies.** `server.ts` logs a loud banner at boot if `MINIMAX_API_KEY` is unset (stub mode),
  so stub output is never mistaken for real work.
- **Database backups (was MISSING).** 21 projects / 190 tasks / 203 outputs sat in one Postgres volume with no dump (the box's `crown-jewels` backup does not cover it). Added `relay-db-backup.sh` — restorable `pg_dump` every 6h, 14 kept; verified a 280 KB dump with real rows.
- **Monitoring/alerting.** `relay-uptime-check.sh` pings `board.naples.agency` every 5 min and Telegram-alerts on any up↔down transition.
- **Unbounded spend closed.** `/api/run` now has a per-IP rate-limit (5 / 15 min) + a global 6-concurrent-project cap (also shields the pg pool). Tested: 6th call → 429. Plus `process.on(uncaughtException/unhandledRejection)` so crashes exit clean for systemd.
- **Ingress decoupled.** Relay moved off the shared `anouf-chat` tunnel onto its own supervised `relay-tunnel.service` (tunnel `relay`, UUID `8be3443c-…`); board/api/email CNAMEs re-pointed via the Cloudflare API (the token is embedded in `/root/.cloudflared/cert.pem` — extract its `apiToken` field). Crash-tested: kill → respawn in 2s. The shared tunnel no longer routes them.
- **DB survives reboot** (policy set) and **infra is documented** (`docs/OPERATIONS.md`, `deploy/`, `AGENTS.md`, `docs/ARCHITECTURE.md`).

## DEFER (tracked, not yet applied)
- **[HIGH] Idempotent schema bootstrap** (`db/schema.sql`, `src/db.ts`): schema opens with unconditional
  `DROP TABLE … CASCADE` and the server never applies it on boot → a fresh DB 500s, and `run.ts`/`demo.ts`
  drop all shipped work. Fix: `CREATE … IF NOT EXISTS` / `CREATE OR REPLACE`, apply at boot before `listen()`,
  gate destructive reset behind `RESET=1`, add a numbered `migrations/` dir.
- **[HIGH] Fail-loud on missing key (hard).** Today the banner warns but the server still serves stub sites.
  Decide: hard-exit in production, or badge `project.params.agent='stub'` and surface it in the UI/KPI.
- **[MED] Scheduler scoping / pool exhaustion** (`runner.ts`, `server.ts`): global `claim()` + one `runLoop`
  per project + per-`/api/run`, all `runnerId='runner-1'`; 3+ concurrent projects can exhaust pool `max=8`.
  Fix: scope `claim()`/`reconcile()` by `project_id`, unique `runnerId` per loop, one scheduler or larger pool.
- **[MED] Reclaim/lease race** (`runner.ts`): 240s lease can be shorter than a slow render+compile+LLM task →
  double-claim → double write to the same artifact. Fix: terminal UPDATEs conditional on `claimed_by`,
  heartbeat-extend the lease, only resurrect provably-dead owners.
- **[MED] Retry backoff / circuit breaker** (`runner.ts`, `agents.ts`): 3 full attempts with no backoff hammer
  MiniMax on a 429/outage. Fix: exponential backoff, fail-fast on identical repeated failure, circuit breaker.
- **[LOW] Persist shipped output** (`sites/` is gitignored, ephemeral): store final verified HTML in Postgres
  or object storage; stop QA's screenshot clobbering the `preview.png` thumbnail.
- **[LOW] Frontend** (`web/*`): polling cadence, vis-network CDN without SRI, API-down error states, a11y polish.
- **[cross-tenant] Supervise dormant naples upstreams** dash:8090 / gab44:8091 / fleet:8888 / fleet-api:8095 /
  fleet-state:8096 — other projects; the tunnel serves them 502 until each gets its own unit. Coordinate first.

## Accepted residual risk
Relay rides its own dedicated tunnel + the Cloudflare edge. The remaining single point is the Cloudflare edge
itself (inherent to serving a custom domain through CF); Tailscale Funnel (`anouf.tailbb043c.ts.net` → `:8787`)
is a live, independent 2nd path to Relay. The box has no spare public `:80/:443`, so a direct-Caddy alternative
isn't available without evicting another tenant.

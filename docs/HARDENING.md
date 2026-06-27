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
- **Fresh-clone safety (Tailwind binary).** `tools/setup.sh` is now idempotent + validates the download;
  `package.json` `postinstall` and `relay.service` `ExecStartPre` vendor it automatically. A redeploy can no
  longer silently ship un-styled pages.
- **No more silent lies.** `excellence.ts` now logs loudly (instead of silently returning raw HTML) when the
  Tailwind binary is missing / compile fails / css is empty; `server.ts` logs a loud banner at boot if
  `MINIMAX_API_KEY` is unset (stub mode), so stub output is never mistaken for real work.
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
All naples hostnames ride one tunnel + the Cloudflare edge (single point of failure). Accepted: the user wants
the custom `naples.agency` domains and the box has no spare public `:80/:443`. Tailscale Funnel
(`anouf.tailbb043c.ts.net` → `:8787`) is the redundant, already-supervised path to Relay.

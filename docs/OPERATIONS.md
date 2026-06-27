# Relay — Operations Runbook

**Audience:** a human operator OR an AI agent who has SSH on this box and needs to keep Relay (the agency pipeline) and its public `*.naples.agency` hostnames alive, deploy changes, and fix outages without breaking the other tenants on this server.

**Golden rule (zero-trust, mirrors the product):** never declare something "up" from an agent's word. Confirm with a deterministic external check — an HTTP status code, `systemctl is-active`, `ss -ltnp`, a `docker ps` line. Every procedure below ends in such a check.

**Verified-as-of:** 2026-06-27 on host `135.181.44.161`. Re-derive ground truth at any time with the commands in [§9 Quick reference](#9-quick-reference-commands).

> **Durability status — APPLIED 2026-06-27.** The cloudflared→systemd migration (§8) is DONE. `anouf-named-tunnel.service` (Restart=always), `relay.service` (Restart=always, `EnvironmentFile=/root/agency-pipeline/.env`), and `ap-pg` (`--restart unless-stopped`) are all **enabled** and were **crash-tested** (SIGKILL → auto-respawn in 2–3s → board 200). No `*.naples.agency` hostname depends on a hand-started process anymore. Live unit files are vendored at [`deploy/systemd/`](../deploy/systemd/). Remaining (deferred) hardening is tracked in [HARDENING.md](./HARDENING.md).

---

## 0. TL;DR for an operator who just got paged

```bash
# Is Relay up locally and publicly?
curl -s -o /dev/null -w 'local %{http_code}\n'  http://127.0.0.1:8787/healthz
for h in board api email; do curl -s -o /dev/null -w "$h %{http_code}\n" --max-time 8 https://$h.naples.agency/healthz; done
# Is the DB up?
docker ps --filter name=ap-pg --format '{{.Names}} {{.Status}}'
# Is the public tunnel up?
pgrep -af 'tunnel run anouf-chat' || pgrep -af cloudflared
```
- Local 200 + public 200 → all good.
- Local 200 + public not-200 → tunnel problem → [§7.3](#73-tunnel--public-naples-hostnames-down).
- Local not-200 → Relay down → [§7.1](#71-relay-server-down-board--api--email-return-502).
- DB line missing → Postgres down → [§7.2](#72-postgres-ap-pg-down).

---

## 1. What Relay is (one paragraph)

A brief comes in via `POST /api/run`; an LLM planner (`src/planner.ts`) explodes it into a DAG of tasks stored in Postgres; a scheduler (`src/runner.ts` `runLoop`) claims ready tasks (`FOR UPDATE SKIP LOCKED` + lease reclaim, so it is restart-safe), each task is one MiniMax LLM call (`src/agents.ts`), every output passes a **deterministic verify gate** (`src/verify.ts` — zero-trust). For "build" tasks the LLM no longer writes HTML at all: it emits a JSON **spec** (brand tokens + an ordered list of sections — hero/features/split/gallery/cta/form), and a deterministic renderer (`src/render.ts` `renderPage`) composes the full self-contained page from hand-built vetted components (`src/components.ts`) — deriving a WCAG-safe palette from the 2 brand colours so contrast is guaranteed, and a CSS-only hamburger nav that is responsive by construction. `src/media.ts` `processMedia` then fills the `<img data-q>` slots with real Pexels photos served locally; the runner instruments the page for the CMS, writes it to `sites/<projectId>/<slug>.html`, and verifies it via `site_renders`. The HTTP server (`src/server.ts`) serves the dashboard (`web/`), the JSON API, and the produced sites at `/sites/<id>/`. **Postgres is the single source of truth**; the runner holds no state, so it can crash and resume.

---

## 2. Verified infrastructure map (ground truth)

### 2.1 Network entrypoints

| Component | Process / container | Binds | Supervised? | Survives reboot? | Purpose |
|---|---|---|---|---|---|
| **saiid-wp caddy** | docker `saiid-wp-caddy-1` (`caddy:2`, RestartPolicy `unless-stopped`) | `135.181.44.161:80` and `:443` (also 443/udp, 2019/tcp internal) | docker restart policy | **yes** | Different project (saiid-wp). Owns the box's only public 80/443 → wordpress. **OFF-LIMITS.** |
| **host caddy** | `caddy run --config /etc/caddy/Caddyfile` (PID ~2396734, **PPid≠1, started manually**) | binds `135.181.44.161` only for `ephemeris.135.181.44.161.sslip.io` → `127.0.0.1:8717` | **no** (unit `caddy.service` exists but is **inactive + disabled**) | **no** | Fronts the ephemeris backend. Coexists with docker caddy on the public IP via sslip.io. |
| **cloudflared** | `cloudflared … tunnel run anouf-chat` (PID ~3421365, **PPid=1, manual nohup**) | no public local port; loopback `127.0.0.1:20241` metrics | **no** | **no** | Named tunnel `anouf-chat` (UUID `269600e7-db71-4e84-99ea-fae3019fea23`). Public ingress for all 8 `*.naples.agency` hostnames via Cloudflare edge. |
| **Relay HTTP server** | `npm exec tsx src/server.ts` (PID ~3423219, **PPid=1, manual**, cwd `/root/agency-pipeline`) | `0.0.0.0:8787` | **no** | **no** | The app. Serves `web/`, `/api/*`, `/sites/<id>/*`. Backs `board/api/email.naples.agency`. |
| **Tailscale Funnel** | `tailscaled` (PID ~3187955, **systemd-enabled**) | `100.109.76.4:443` + IPv6 `:443` | **yes** (systemd) | **yes** | Funnel ON: `https://anouf.tailbb043c.ts.net` → `127.0.0.1:8787` (a redundant public path to Relay). Plus tailnet-only `:18789` → openclaw gateway. |
| **ap-pg (Postgres)** | docker `ap-pg` (`postgres:16`, RestartPolicy `unless-stopped`) | `0.0.0.0:5439->5432` | docker restart policy | **yes** | Relay's database (`agency`). |
| **ephemeris backend** | `python3` (PID ~2096053) | `127.0.0.1:8717` | **no** | **no** | Other project; fronted by host caddy. |
| **others** | `searxng` (`:8889`, unless-stopped), `nao-grok` (no ports), `saiid-wp-wordpress-1`/`saiid-wp-db-1` (internal), openclaw gateway node (`127.0.0.1:18789` + tailnet), sshd `:22`, cupsd `:631` | various | mixed | mixed | Unrelated tenants. Do not touch. |

### 2.2 `*.naples.agency` hostname → upstream map

All 8 hostnames resolve to Cloudflare (orange-cloud `104.21.6.206` / `172.67.135.67`; NS `jo/pete.ns.cloudflare.com`) and reach the box through the single named tunnel `anouf-chat`. Mappings live in **`/root/.cloudflared/config.yml`**:

| Hostname | Upstream | Owner | Live as of 2026-06-27 |
|---|---|---|---|
| `board.naples.agency` | `http://127.0.0.1:8787` | **Relay** | ✅ 200 |
| `api.naples.agency` | `http://127.0.0.1:8787` | **Relay** | ✅ 200 |
| `email.naples.agency` | `http://127.0.0.1:8787` | **Relay** | ✅ 200 |
| `dash.naples.agency` | `http://127.0.0.1:8090` | other project | ❌ upstream down (502/404) |
| `gab44.naples.agency` | `http://127.0.0.1:8091` | other project | ❌ upstream down |
| `fleet.naples.agency` | `http://127.0.0.1:8888` | other project | ❌ upstream down |
| `fleet-api.naples.agency` | `http://127.0.0.1:8095` | other project | ❌ upstream down |
| `fleet-state.naples.agency` | `http://127.0.0.1:8096` | other project | ❌ upstream down |

> Note: a second tunnel `gab44` (UUID `e7486033-…`) is defined in `/root/.cloudflared/gab44.yml` but is **NOT** the running process. The live tunnel is `anouf-chat`. Do not start the gab44 tunnel.

### 2.3 OFF-LIMITS — do not touch (will break other tenants)

- **`saiid-wp-caddy-1`** container, its config `/root/saiid-wp/Caddyfile` (read-only bind-mounted to `/etc/caddy/Caddyfile` *inside that container* — note this is a different file from the host caddy's `/etc/caddy/Caddyfile`), and the public ports `135.181.44.161:80`/`:443`. The new naples proxy must **never** try to bind those ports.
- The entire **saiid-wp** docker-compose stack: `saiid-wp-wordpress-1`, `saiid-wp-db-1`, volumes `saiid-wp_caddy_data`/`_config`, network `saiid-wp_default` (172.18.0.0/16), `/root/saiid-wp/*` and its `.env`.
- **dash (8090), gab44 (8091), fleet (8888), fleet-api (8095), fleet-state (8096)** — other projects' apps. Preserve their tunnel ingress mappings **byte-for-byte**; do not change their ports or code.
- **ephemeris backend** (`127.0.0.1:8717`) and its host-caddy vhost `ephemeris.135.181.44.161.sslip.io`. The only allowed change here is enabling the existing `caddy.service` (which already serves it) — never alter `/etc/caddy/Caddyfile`.
- **Tailscale** identity/tailnet config and the existing Funnel mapping to `:8787` — leave intact (it's a useful redundant path to Relay).
- **`searxng`, `nao-grok`, `ap-pg`** container configs — do not change image/ports. `ap-pg` is already `unless-stopped`; leave it.
- **Cloudflare DNS** zone records and the `anouf`/`gab44` tunnel credential JSONs — do not delete/rotate. Reuse the existing named tunnel.

---

## 3. Files, env vars & secrets — where everything lives

| Thing | Location |
|---|---|
| App code | `/root/agency-pipeline/` (git repo; cwd for the server) |
| Source | `src/` (`server.ts`, `planner.ts`, `runner.ts`, `verify.ts`, `agents.ts`, `render.ts`, `components.ts`, `media.ts`, `cms.ts`, `qa.ts`, `kpi.ts`, `db.ts`) |
| Frontend | `web/` (`index.html`, `app.js`, `styles.css`) |
| DB schema (DDL) | `db/schema.sql` — **destructive**: starts with `DROP TABLE … CASCADE`. See [§4.4](#44-database-schema). |
| Produced websites (artifacts) | `/root/agency-pipeline/sites/<projectId>/` — `index.html`, other `<slug>.html`, `preview.png` (board thumbnail). **Gitignored, host-local, no backup.** |
| Inline fonts | `src/fonts.ts` (base64 WOFF2, committed) |
| Env example | `.env.example` |
| Tunnel config | `/root/.cloudflared/config.yml` (+ creds `269600e7-….json`, `cert.pem`) |
| Host-caddy vhost | `/etc/caddy/Caddyfile` (ephemeris only — **do not edit**) |

### 3.1 Environment variables (read straight from `process.env`)

| Var | Used by | Default if unset | Notes |
|---|---|---|---|
| `DATABASE_URL` | `src/db.ts` | `postgresql://postgres:postgres@127.0.0.1:5439/agency` | Points at the `ap-pg` docker container. |
| `PORT` | `src/server.ts` | `8787` | Don't change — the tunnel + Funnel target 8787. |
| `MINIMAX_API_KEY` | `src/agents.ts` | **(unset → STUB MODE)** | **Critical.** If unset, the system silently produces fake "Generated offline by Relay (stub)" sites that still PASS every gate. See ⚠️ below. |
| `MINIMAX_BASE_URL` | `src/agents.ts` | `https://api.minimax.io/v1` | OpenAI-compatible endpoint. |
| `MINIMAX_MODEL` | `src/agents.ts` | `MiniMax-Text-01` | M2 emits `<think>` tags; Text-01 is clean. |

> ⚠️ **Where the secret lives today:** there is **no `.env` file** and the server has **no `dotenv` loader**. `MINIMAX_API_KEY` only reaches Relay because it was **exported in the shell that launched the process** (verified present in `/proc/<pid>/environ`). This means: if you restart Relay from a fresh shell that did NOT export the key, **Relay silently drops to stub mode and ships placeholder garbage that still passes verify.** This is a durability gap — see [§8 G6](#8-durability-gaps--their-fixes). Until fixed, always confirm the key after any restart:
> ```bash
> tr '\0' '\n' < /proc/$(pgrep -f 'tsx src/server.ts' | tail -1)/environ | grep -q MINIMAX_API_KEY && echo 'KEY present' || echo 'STUB MODE — key missing!'
> ```

---

## 4. Deploy / start / stop / restart each piece

> Today everything except Postgres and Tailscale is a **manual process**. The procedures below are the *current reality*. The **durable** way to run them (systemd) is in [§8](#8-durability-gaps--their-fixes) — apply that to stop doing this by hand.

### 4.1 Relay HTTP server

**Prereqs (once per box / fresh clone):** `npm install`, `chromium-browser` on PATH (verified: `/usr/bin/chromium-browser`), and a reachable Postgres. That's the full set — there is no binary to vendor and no setup script to run (the deterministic render engine ships complete pages by construction).

**Start (manual, current method):**
```bash
cd /root/agency-pipeline
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5439/agency'
export MINIMAX_API_KEY='<the real key>'      # MANDATORY — without it you ship stubs
export MINIMAX_BASE_URL='https://api.minimax.io/v1'
export MINIMAX_MODEL='MiniMax-Text-01'
nohup npm exec tsx src/server.ts > /var/log/relay.out 2>&1 &
```
On boot, the server **auto-resumes** any project with unfinished tasks (`server.ts` lines 124-130) — no manual kick needed.

**Verify (deterministic):**
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz   # expect 200
ss -ltnp | grep ':8787'                                                   # expect a node listener
```

**Stop:**
```bash
pkill -f 'tsx src/server.ts'      # kills the npm/sh/node tree
# or target precisely:
kill "$(pgrep -f 'tsx src/server.ts' | head -1)"
```

**Restart:** stop, then start. **Re-confirm the MiniMax key is in the env** (see §3.1 warning).

> **Durable replacement:** install `relay.service` (systemd, `Restart=always`) per [§8 G2](#8-durability-gaps--their-fixes). Then use `systemctl restart relay` and never touch `nohup` again.

### 4.2 Postgres (`ap-pg`)

Already durable (`unless-stopped`). You rarely touch it.
```bash
docker ps --filter name=ap-pg                      # status
docker restart ap-pg                               # restart
docker start ap-pg                                 # if stopped
# Recreate from scratch (ONLY if the container is gone — destroys nothing if a named volume exists):
docker run -d --name ap-pg --restart unless-stopped \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=agency \
  -p 5439:5432 postgres:16
```
**Verify:** `docker exec ap-pg pg_isready -U postgres` → `accepting connections`.

### 4.3 The proxy (cloudflared tunnel `anouf-chat`)

**Start (manual, current method):**
```bash
nohup cloudflared --no-autoupdate tunnel --config /root/.cloudflared/config.yml run anouf-chat \
  > /var/log/cloudflared.out 2>&1 &
```
**Verify:**
```bash
cloudflared tunnel info anouf-chat                 # expect ~4 active edge connections
for h in board api email; do curl -s -o /dev/null -w "$h %{http_code}\n" https://$h.naples.agency/healthz; done
```
**Stop:** `pkill -f 'tunnel run anouf-chat'`

> **Durable replacement:** install `cloudflared.service` (systemd, `Restart=always`) per [§8 G1](#8-durability-gaps--their-fixes) / the [migration plan](#10-safe-migration-plan-cloudflared--durable-proxy). After that, `systemctl restart cloudflared`.

### 4.4 Database schema

The schema is `db/schema.sql`. ⚠️ It is **destructive** — it begins with `DROP TABLE … CASCADE` on `projects/tasks/…`, so applying it **wipes all projects and shipped work**.

- `server.ts` **never** applies the schema. On a brand-new empty DB the server will start but every query 500s with "relation does not exist".
- The only callers that create the schema are `src/run.ts` (applies unless `RESET=0`) and `src/demo.ts` (always). Both **drop everything**.

**Create the schema on a fresh DB without losing data (first-time only):**
```bash
cd /root/agency-pipeline
docker exec -i ap-pg psql -U postgres -d agency < db/schema.sql
```
On an already-populated DB, **do not** re-run this — it deletes everything. (Durable fix: make the schema idempotent — see [§8 G7](#8-durability-gaps--their-fixes).)

### 4.5 Host caddy (ephemeris — only touch to make durable)

```bash
caddy validate --config /etc/caddy/Caddyfile      # sanity-check before any start
systemctl enable --now caddy                       # makes ephemeris fronting durable (unit already correct)
curl -s -o /dev/null -w '%{http_code}\n' https://ephemeris.135.181.44.161.sslip.io/
```
Do **not** edit `/etc/caddy/Caddyfile`. If `systemctl start caddy` reports a bind conflict with saiid-wp's docker caddy, **leave caddy manual** rather than risk saiid-wp (see [§10 risks](#10-safe-migration-plan-cloudflared--durable-proxy)).

---

## 5. Where artifacts live & how to inspect them

- Produced sites: `/root/agency-pipeline/sites/<projectId>/index.html` (+ other pages + `preview.png`).
- Served at `https://board.naples.agency/sites/<projectId>/` (and `http://127.0.0.1:8787/sites/<id>/`).
- The home-page screenshot `preview.png` is the board thumbnail (written by the index build's `site_renders` check, `verify.ts`).
- ⚠️ `sites/` is **gitignored and host-local with no backup** — a host migration loses every shipped site. The HTML *source* also lives in Postgres (`task_outputs` / `page_snapshots`), so the canonical content is recoverable from the DB, but the rendered files on disk are not backed up. See [§8 G8](#8-durability-gaps--their-fixes).

List recent projects and their on-disk sites:
```bash
curl -s http://127.0.0.1:8787/api/projects | head -c 2000
ls -dt /root/agency-pipeline/sites/*/ | head
```

---

## 6. Logs — how to tail

| What | How |
|---|---|
| Relay (manual) | `tail -f /var/log/relay.out` (only if you started it with the redirect above). Otherwise stdout is wherever the launching shell sent it. |
| Relay (systemd, after G2) | `journalctl -u relay -f` |
| cloudflared (manual) | `tail -f /var/log/cloudflared.out`; live tunnel health: `cloudflared tunnel info anouf-chat` |
| cloudflared (systemd, after G1) | `journalctl -u cloudflared -f` |
| Postgres | `docker logs -f ap-pg` |
| host caddy | `journalctl -u caddy -f` (after enabling) or its manual stdout |
| **In-app run events** (best signal for pipeline health) | query the DB — see below |

**Run events are the truth for what the pipeline is doing** (planned / task_done / verify_failed / agent_error / task_unblocked):
```bash
docker exec -it ap-pg psql -U postgres -d agency -c \
"select at, type, detail from run_events order by id desc limit 40;"
```

---

## 7. Troubleshooting

### 7.1 Relay server down (board / api / email return 502)

**Diagnose:** `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz`
- **Not 200 / connection refused** → process is dead. `pgrep -f 'tsx src/server.ts'` (empty confirms it).

**Fix:** restart per [§4.1](#41-relay-http-server). **Confirm the MiniMax key survived** (§3.1 warning) — a key-less restart silently ships stubs.

**If it crashes immediately on start:**
- `relation "projects" does not exist` → schema not applied → [§4.4](#44-database-schema).
- `ECONNREFUSED 127.0.0.1:5439` → Postgres down → [§7.2](#72-postgres-ap-pg-down).
- Port already in use → an old instance is still bound: `pkill -f 'tsx src/server.ts'` then start.

After fixing, the server auto-resumes unfinished projects on boot.

### 7.2 Postgres (`ap-pg`) down

**Diagnose:** `docker ps -a --filter name=ap-pg` and `docker exec ap-pg pg_isready -U postgres`.
**Fix:**
```bash
docker start ap-pg || docker restart ap-pg
docker exec ap-pg pg_isready -U postgres        # expect "accepting connections"
```
If the container is gone entirely, recreate it ([§4.2](#42-postgres-ap-pg)). If the data volume is also gone, you must re-apply the schema ([§4.4](#44-database-schema)) — past projects are lost (no backup; durability gap G8). After the DB is back, restart Relay so it reconnects and resumes.

### 7.3 Tunnel / public naples hostnames down

**Symptom:** `http://127.0.0.1:8787/healthz` = 200 but `https://board.naples.agency/healthz` ≠ 200.
**Diagnose:**
```bash
pgrep -af 'tunnel run anouf-chat'                 # is the process alive?
cloudflared tunnel info anouf-chat                # expect ~4 edge connections
```
**Fix:**
- Process dead → restart per [§4.3](#43-the-proxy-cloudflared-tunnel-anouf-chat). (Durable fix: G1 systemd unit.)
- Process alive but 0 connections / Cloudflare 1033/error → restart the tunnel; check Cloudflare status. The `anouf-chat` config (`config.yml`) is correct and unchanged — do not edit it to "fix" connectivity.
- **dash/gab44/fleet\*** returning 502/404 is **expected** — those upstreams (8090/8091/8888/8095/8096) are down and are other projects' apps. That is not a Relay problem; do not start them.
- **Redundant fallback:** Relay is also reachable at `https://anouf.tailbb043c.ts.net` via Tailscale Funnel (systemd-supervised). If the Cloudflare path is flapping, that ts.net URL still serves the board/API.

### 7.4 A project is deadlocked / blocked

KPI status `blocked` is **honest** (`src/kpi.ts`): `active===0 && blocked>0` means nothing can move but work remains — it is **not** reported as "running". This happens when an upstream task hit `failed` (exhausted its 3 attempts), so its downstreams can never become ready.

**Diagnose:**
```bash
docker exec -it ap-pg psql -U postgres -d agency -c \
"select seq, department, status, attempts, verify from tasks where project_id='<ID>' order by seq;"
docker exec -it ap-pg psql -U postgres -d agency -c \
"select type, detail from run_events where project_id='<ID>' and type in ('verify_failed','agent_error') order by id desc limit 10;"
```
Common causes from the `detail`:
- `MiniMax 429/5xx` → provider rate-limited/down → wait and **re-ready** the failed tasks (below), or re-run the brief.
- `tokens must declare palette.text and palette.bg` → branding task didn't emit WCAG-passing tokens.
- `external/unbundled asset reference` or `unfilled placeholder left in copy` → a build task produced un-inlined assets or bracketed `[Title Case]` text (note: the placeholder regex can false-flag legit copy like `[Sign In]` — a known gate quirk).

**Re-drive a blocked project** (reset failed tasks so the loop retries them; the running server's resume loop or a new `/api/run` will pick them up):
```bash
docker exec -it ap-pg psql -U postgres -d agency -c \
"update tasks set status='ready', attempts=0, claimed_by=null, lease_expires_at=null
 where project_id='<ID>' and status='failed';"
docker exec -it ap-pg psql -U postgres -d agency -c \
"update projects set status='running' where id='<ID>';"
```
Then restart Relay (or it will pick them up on its next resume) and watch `run_events`. If MiniMax was the cause, fix the key/quota first.

### 7.5 Broken images

**External/placeholder images** — handled deterministically: `runner.ts`/`media.ts` strip external `<img src=http…>`, `url(http…)`, and `placeholder` assets before writing; `media.ts` `processMedia` fills `<img data-q>` slots with locally-served Pexels photos; `verify.ts` `site_renders` rejects any page that still references `https?:` assets, `app.css`, or `via.placeholder`. If a site shows broken images, check it isn't an **old** artifact from before this sanitizer — re-run the build. (Styling/nav/contrast can no longer be wrong: the deterministic renderer composes every page from vetted components with an inlined design-system `<style>` and a WCAG-safe palette, so the old "un-styled 1998-look" failure mode does not exist.)

### 7.6 Screenshots blank / `site_renders` failing for everything

`site_renders` shells out to `chromium-browser --headless`. If it's missing or broken, every build fails the gate.
```bash
command -v chromium-browser                        # expect /usr/bin/chromium-browser
chromium-browser --headless=new --no-sandbox --screenshot=/tmp/t.png --window-size=800,600 about:blank && ls -la /tmp/t.png
```
If chromium is gone, install it; the verify call already passes `--no-sandbox --disable-gpu --disable-dev-shm-usage` for container environments.

### 7.7 Stub mode (fake sites that pass every gate)

If shipped sites all say *"Generated offline by Relay (stub)"*, `MINIMAX_API_KEY` was not in Relay's env at start (§3.1). Fix the env and restart Relay. Stub mode is **silent** — it does not error — so this is easy to miss; always run the key-present check after a restart.

---

## 8. Durability gaps & their fixes

The whole stack is fragile to reboot/crash: only **tailscaled** and the two docker containers (**ap-pg**, **saiid-wp-caddy-1**) are properly supervised. Everything else is a manual process reparented to init. Gaps, by severity:

| # | Gap | Impact | Fix |
|---|---|---|---|
| **G1** | **cloudflared `anouf-chat` is a manual process (PPid=1), no systemd, no restart.** | Reboot/crash takes **all 8 `*.naples.agency`** offline permanently until a human restarts it. | Install `cloudflared.service` (`Restart=always`, references `--config /root/.cloudflared/config.yml`, **not** `service install`'s token mode). See [§10](#10-safe-migration-plan-cloudflared--durable-proxy). |
| **G2** | **Relay is a manual `npm exec tsx src/server.ts` (PPid=1), no supervision.** Any uncaught crash/OOM/reboot kills the HTTP server + scheduler + boot-resume; in-flight `runLoop` promises die silently. | board/api/email go down and stay down. | Create `/etc/systemd/system/relay.service` (`Restart=always`, `RestartSec=2`, `WorkingDirectory=/root/agency-pipeline`, `ExecStart=/usr/bin/npm exec tsx src/server.ts`, `EnvironmentFile=/root/agency-pipeline/.env`, `After=docker.service`); `systemctl enable --now relay`. Add `process.on('unhandledRejection'/'uncaughtException')` handlers that log and exit so systemd restarts cleanly. |
| ~~**G3**~~ | ~~Tailwind binary absent on a fresh clone → un-styled pages that still pass the gate.~~ | — | **Resolved (2026-06-27)** — the Tailwind dependency was removed entirely by the deterministic render engine (`src/render.ts` + `src/components.ts`). There is no binary to vendor, no `setup.sh`, and no silent-no-op excellence step; pages are styled by construction, so this gap can no longer occur. |
| **G4** | **No idempotent DB migrations.** `db/schema.sql` starts with `DROP TABLE … CASCADE`; `server.ts` never applies it; the only creators (`run.ts`/`demo.ts`) wipe all data. | Fresh DB → server 500s on every query; "fixing" it via run.ts destroys existing projects. | Split schema into `CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE`, run it from `server.ts` boot before `listen()`, add a numbered `schema_migrations` table, gate destructive reset behind `RESET=1` only. |
| **G5** | **Scheduler concurrency:** `claim()` selects ready tasks with **no `project_id` filter**, but boot-resume starts one `runLoop` per unfinished project and every `/api/run` starts another — all with the same hardcoded `runnerId='runner-1'`. N loops compete over one global pool; pool `max=8` (db.ts) vs `cap=4`/loop means 3+ concurrent projects exhaust connections and stall. | Slowdowns / stalls under concurrency; cross-project task claims. | Scope `claim()`/`reconcile()` by `project_id`; give each loop a unique `runnerId` (e.g. `${hostname}-${pid}-${projectId}`); or run ONE global scheduler; size the pg pool ≥ sum of loop caps; de-dupe boot-resume. |
| **G6** | **Secret/env not validated; no `.env`, no dotenv loader.** Missing `MINIMAX_API_KEY` → silent stub mode that still passes every gate. `DATABASE_URL` defaults to a hardcoded dev DSN. | A restart from the wrong shell ships placeholder garbage with no error. | Validate required env at boot (fail loud + exit if key missing in prod, or badge `params.agent='stub'` in UI/KPIs). Load `.env` explicitly (dotenv or systemd `EnvironmentFile`). Remove the hardcoded password default. |
| **G7** | **host caddy (ephemeris) started manually**; `caddy.service` exists but is **inactive + disabled**. | Reboot loses ephemeris fronting. | `systemctl enable --now caddy` (unit already correct: `Restart=on-failure`, `CAP_NET_BIND_SERVICE`). Validate first; if it bind-conflicts with saiid-wp docker caddy, leave manual. |
| **G8** | **`sites/` is gitignored, host-local, no backup.** | Host migration loses every shipped site (HTML source survives in Postgres `task_outputs`, but rendered files + screenshots don't). | Back up / object-store `sites/` (or store final HTML bytes in Postgres as the single source of truth); write qa's screenshot to a distinct path so it can't clobber the canonical `preview.png` thumbnail. |
| **G9** | **ephemeris backend** (`python3 :8717`) and the dormant naples upstreams **dash/gab44/fleet\*** have no supervisor. | Even with a durable tunnel, these return 502/404 after reboot. | Each needs its own `Restart=always` systemd unit. **These are other projects — coordinate with their owners before authoring/enabling; out of scope for Relay ops.** |
| **G10** | **Single point of failure:** all naples hostnames ride one cloudflared tunnel + Cloudflare edge (the "flaky" part). No Cloudflare API token on the box, so DNS changes are manual-dashboard-only. | Residual risk even after G1. | Accepted: keep custom domains via the durable tunnel; **Tailscale Funnel** (`anouf.tailbb043c.ts.net`) remains a redundant, systemd-supervised path to Relay. |

**Priority order to make the stack "lasting":** G2 (Relay) and G1 (tunnel) first — they restore the public service automatically on reboot. Then G6 (so restarts don't silently ship stubs), G7 (ephemeris durable), then G4/G5/G8 hardening. G9 with the other teams. (G3 is resolved — the Tailwind dependency was removed.)

---

## 9. Quick reference (commands)

```bash
# --- Health ---
curl -s -o /dev/null -w 'local %{http_code}\n' http://127.0.0.1:8787/healthz
for h in board api email; do curl -s -o /dev/null -w "$h %{http_code}\n" --max-time 8 https://$h.naples.agency/healthz; done
docker exec ap-pg pg_isready -U postgres
cloudflared tunnel info anouf-chat

# --- Who is listening / who is supervised ---
ss -ltnp | grep -E ':8787|:5439|:8717'
ps -eo pid,ppid,args | grep -E 'tsx src/server.ts|tunnel run anouf-chat|/caddy run' | grep -v grep
systemctl is-active cloudflared relay caddy tailscaled 2>/dev/null   # after durable migration

# --- Is the MiniMax key really in Relay's env? (else STUB MODE) ---
tr '\0' '\n' < /proc/$(pgrep -f 'tsx src/server.ts' | tail -1)/environ | grep -q MINIMAX_API_KEY \
  && echo 'KEY present' || echo 'STUB MODE — key missing!'

# --- Restart each piece (manual / current) ---
pkill -f 'tsx src/server.ts';        (cd /root/agency-pipeline && nohup npm exec tsx src/server.ts > /var/log/relay.out 2>&1 &)
pkill -f 'tunnel run anouf-chat';    nohup cloudflared --no-autoupdate tunnel --config /root/.cloudflared/config.yml run anouf-chat > /var/log/cloudflared.out 2>&1 &
docker restart ap-pg

# --- Pipeline state for a project ---
docker exec -it ap-pg psql -U postgres -d agency -c \
"select seq,department,status,attempts,verify from tasks where project_id='<ID>' order by seq;"
docker exec -it ap-pg psql -U postgres -d agency -c \
"select at,type,detail from run_events where project_id='<ID>' order by id desc limit 30;"

# --- Submit a brief / inspect output ---
curl -s -X POST http://127.0.0.1:8787/api/run -H 'content-type: application/json' -d '{"brief":"a coffee shop in Oslo"}'
curl -s 'http://127.0.0.1:8787/api/board?id=<ID>' | head -c 1500
curl -s 'http://127.0.0.1:8787/api/kpi?id=<ID>'  | head -c 1500
```

---

## 10. SAFE MIGRATION PLAN (cloudflared → durable proxy)

**Goal:** make `*.naples.agency` "work for life" and survive reboot/crash by replacing the flaky **manual** cloudflared process with a properly supervised, auto-restarting **cloudflared systemd service** over the *existing* named tunnel, and bringing Relay under systemd too — with **ZERO Cloudflare DNS changes** and **ZERO risk** to saiid-wp / ephemeris / dash / gab44 / fleet.

**Chosen approach — Option (c) hardened:** keep the existing Cloudflare orange-cloud DNS + named tunnel `anouf-chat` (no DNS edits, no public-port contention with saiid-wp's 80/443), and convert the unsupervised cloudflared process into a durable systemd unit (`Restart=always`, `WantedBy=multi-user.target`) so it reconnects automatically on crash/reboot. The tunnel architecture is already correct (4 live edge connections, `config.yml` maps all 8 hostnames); the **only real defect is supervision.**

**Rejected alternatives:**
- **(a) add naples vhosts to saiid-wp's caddy** — edits another stack's read-only-mounted Caddyfile and shares its 80/443. High blast radius, violates off-limits. ❌
- **(b) new dedicated host-Caddy + grey-cloud A-records** — needs free public 80/443 (both taken on the only public IP), needs manual Cloudflare DNS edits (no API token on box), and exposes the origin IP. More moving parts, more risk, no benefit over a durable tunnel. ❌
- *Optional polish within (c):* front the tunnel with the already-installed host caddy on a loopback port so all 8 hostnames terminate at one local reverse proxy (single ingress entry) — nice-to-have, not required. The minimal durable fix is just systemd-izing cloudflared.

Tailscale Funnel (already live to `:8787`) stays as a redundant, `ts.net`-hostname fallback for Relay.

### Steps (deterministic checks at each gate)

1. **Snapshot good state.**
   ```bash
   cp /root/.cloudflared/config.yml /root/.cloudflared/config.yml.$(date +%s).bak
   ps -eo pid,ppid,args | grep -E 'cloudflared|server.ts' > /root/migration-pre.txt
   ```
2. **Baseline the tunnel + service before any change.**
   ```bash
   cloudflared tunnel info anouf-chat                          # expect ~4 connections
   curl -s -o /dev/null -w '%{http_code}\n' https://board.naples.agency/api/board   # expect 200
   ```
3. **Write the cloudflared systemd unit explicitly** (do **not** rely on `cloudflared service install`, which can default to a token-based service that ignores `config.yml` and drops the multi-hostname ingress):
   ```
   [Unit]
   Description=cloudflared tunnel anouf-chat (naples.agency)
   After=network-online.target
   Wants=network-online.target
   [Service]
   Type=notify
   ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config /root/.cloudflared/config.yml tunnel run anouf-chat
   Restart=always
   RestartSec=5
   TimeoutStartSec=0
   User=root
   [Install]
   WantedBy=multi-user.target
   ```
4. Write it and reload:
   ```bash
   cat > /etc/systemd/system/cloudflared.service <<'EOF'
   ... (content from step 3) ...
   EOF
   systemctl daemon-reload
   ```
5. **Hand routing to systemd in one window** to minimize downtime (re-resolve the PID at run time):
   ```bash
   kill "$(pgrep -f 'tunnel run anouf-chat')" ; systemctl enable --now cloudflared
   ```
   Cloudflare edge re-establishes connections within a few seconds.
6. **Verify tunnel durability:**
   ```bash
   systemctl is-enabled cloudflared        # enabled
   systemctl status cloudflared            # active (running)
   cloudflared tunnel info anouf-chat       # connections back
   for h in board api email; do curl -s -o /dev/null -w "$h %{http_code}\n" https://$h.naples.agency/; done
   # board/api/email = 200; dash/gab44/fleet* = 502/404 (upstreams down — unchanged behavior)
   ```
7. **Make Relay durable.** Write `/etc/systemd/system/relay.service`:
   ```
   [Unit]
   Description=Relay agency-pipeline http server (board/api/email.naples.agency)
   After=network-online.target docker.service
   Wants=network-online.target
   [Service]
   WorkingDirectory=/root/agency-pipeline
   ExecStart=/usr/bin/npm exec tsx src/server.ts
   Restart=always
   RestartSec=5
   Environment=NODE_ENV=production
   EnvironmentFile=/root/agency-pipeline/.env
   User=root
   [Install]
   WantedBy=multi-user.target
   ```
   First create `/root/agency-pipeline/.env` (from `.env.example`) containing the **real** `MINIMAX_API_KEY`, `DATABASE_URL`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL` — this also closes gap **G6** (no more "key only lives in a shell"). Then:
   ```bash
   systemctl daemon-reload
   kill "$(pgrep -f 'tsx src/server.ts' | head -1)" ; systemctl enable --now relay
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz    # 200
   tr '\0' '\n' < /proc/$(pgrep -f 'tsx src/server.ts' | tail -1)/environ | grep -q MINIMAX_API_KEY && echo 'KEY present'
   ```
   (`ap-pg` is already `unless-stopped`, so the DB survives reboot.)
8. **Make ephemeris's fronting durable** (already-correct unit, just disabled — do **not** edit the Caddyfile):
   ```bash
   caddy validate --config /etc/caddy/Caddyfile
   systemctl enable --now caddy
   curl -s -o /dev/null -w '%{http_code}\n' https://ephemeris.135.181.44.161.sslip.io/
   ss -ltnp | grep -E ':80 |:443 '   # confirm NO new bind conflict with saiid-wp docker caddy
   ```
9. **(Listed, not authored here)** For full naples coverage, create `Restart=always` units for the dormant upstreams dash:8090, gab44:8091, fleet:8888, fleet-api:8095, fleet-state:8096 so the tunnel has live origins after reboot. **These are other projects — coordinate before enabling.**
10. **Reboot-survival proof (the deterministic external check, not self-report):**
    ```bash
    systemctl reboot     # in a maintenance window
    # after boot, with NO manual intervention:
    systemctl is-active cloudflared relay caddy tailscaled       # all active
    for h in board api email; do curl -s -o /dev/null -w "$h %{http_code}\n" https://$h.naples.agency/; done   # 200s
    ```
11. **Document** the three systemd units, the tunnel UUID, the hostname→port map, and the survives-reboot verification commands (this file + `README.md`) so both AI and humans can re-derive ground truth.

### Risks & mitigations

- **Brief tunnel downtime (~seconds)** during step 5 when swapping manual→systemd cloudflared. Mitigated by `kill`+`enable` in immediate succession; Cloudflare edge re-handshakes automatically.
- **`cloudflared service install` token trap:** it may install a token-based service that ignores `config.yml` and drops the multi-hostname ingress. Mitigated by writing the explicit unit that references `--config /root/.cloudflared/config.yml` (step 3).
- **`npm exec tsx` PATH under systemd** may resolve a different node/npm than the interactive shell. Mitigated by absolute `/usr/bin/npm` (verified: `command -v npm` → `/usr/bin/npm`) and, if needed, adding the resolved PATH to the unit's `Environment`.
- **Enabling `caddy.service`:** it has `CAP_NET_BIND_SERVICE` and binds `135.181.44.161`. Confirm it does **not** collide with saiid-wp docker's :80/:443 (it serves only ephemeris sslip.io and currently coexists). `caddy validate` + `ss -ltnp` after start. **If a bind conflict appears, leave caddy manual rather than risk saiid-wp.**
- **Killing the wrong PID:** the PIDs in this doc are point-in-time. **Always re-resolve at execution** via `pgrep -f 'tunnel run anouf-chat'` and `pgrep -f 'tsx src/server.ts'` before `kill`.
- **Residual SPOF:** durability still depends on Cloudflare edge + one tunnel. Accepted (user wants custom naples domains; box has no spare public 80/443). Tailscale Funnel remains a redundant path to Relay.

### Rollback

Each step is independently reversible and touches only **new** files (no DNS, no saiid-wp, no Cloudflare-dashboard changes — nothing to revert on the edge).
```bash
# Tunnel back to manual:
systemctl disable --now cloudflared
nohup cloudflared --no-autoupdate tunnel --config /root/.cloudflared/config.yml run anouf-chat &   # config.yml unchanged; timestamped backup from step 1 exists
# Relay back to manual:
systemctl disable --now relay
cd /root/agency-pipeline && nohup npm exec tsx src/server.ts &
# Caddy back to its prior (inactive) state:
systemctl disable --now caddy
```
Deleting the three new unit files + `systemctl daemon-reload` fully restores the original manual-process topology.

---

*Keep this file accurate. After any infra change, re-run the [§9 quick reference](#9-quick-reference-commands) health and supervision checks and update the tables in [§2](#2-verified-infrastructure-map-ground-truth) so the next operator (human or AI) inherits ground truth, not stale notes.*

# AGENTS.md — read this first

You are an AI agent (or a new dev) about to change **Relay**, the autonomous agency pipeline in this
repo. This file is the contract for continuing the work without breaking it. Read it top to bottom
before you touch anything. It is deliberately concrete: real file paths, real commands, real gotchas.

If you only remember one thing: **completion is a deterministic external check, never an agent's
word, never your own claim that "it's done."** That principle is load-bearing in the code and in how
you should work on the code.

---

## 1. What Relay is (in one breath)

A brief comes in → an LLM **planner** explodes it into a DAG of tasks → AI **department agents**
(one API call each) run the tasks stage-by-stage (parallel where independent, sequential where one
feeds the next) → every output passes a **deterministic verify gate** → the result is a real,
shippable, multi-page website served at `/sites/<projectId>/`.

Postgres is the single source of truth. The scheduler is a thin, disposable, restart-safe loop —
everything it needs is recomputed from the DB rows, so killing it mid-run and restarting just
resumes.

The website you are running (`web/`) **is** the product: submit a brief, watch the agency build it
live, open the finished site.

For the *why* and the locked principles, see [`MISSION.md`](MISSION.md). For history + forward plan,
[`ROADMAP.md`](ROADMAP.md). For the full architecture spec, [`docs/SPEC.md`](docs/SPEC.md). For the
stack-evolution decision, [`docs/RELAY-STACK-DECISION.md`](docs/RELAY-STACK-DECISION.md). The
companion **operations** doc `docs/OPERATIONS.md` covers the production/hosting layout (proxy,
durability, what's live on this box) — **read it before touching any service**, because other
people's stacks (`saiid-wp`, `ephemeris`, `dash`, `gab44`, `fleet*`) share this machine and must not
break. The essentials are also summarized in §7 below.

---

## 2. Repo map (every `src/` file in one line)

| File | What it is |
|---|---|
| `src/server.ts` | HTTP server on `0.0.0.0:8787`. Serves `web/` (static, mtime cache-busting), the JSON API (`/api/board`, `/api/projects`, `/api/kpi`, `/api/output`, `POST /api/run`), the produced sites under `/sites/<id>/*`, `/healthz`, and `/roadmap`→`/#/roadmap`. On boot it **resumes** every project that still has unfinished tasks (restart-safe). |
| `src/planner.ts` | LLM planner: brief → `{pages, tasks}`. `validate()` is the spine: keeps 4–7 *thinking* tasks only, forces exactly one canonical `branding` task to `wcag`, content/copy → `json`, the rest → `min:280`, then appends **one render-verified build task per page** (`artifact=<slug>.html`, `verify=site_renders`) + a `qa` pass on Home. Stores `pages` in `projects.params`. Falls back to a small template plan if the LLM is unavailable. |
| `src/runner.ts` | The whole scheduler (`runLoop`): `reclaim` (lease expiry → resurrect crashed tasks) → `reconcile` (promote ready via the `v_ready_tasks` view, a safety net) → `claim` (`FOR UPDATE SKIP LOCKED`) → `processTask`. `processTask` runs the agent, writes the artifact, runs the sanitizer (strips external `<img>`/`url(http…)`/placeholder), applies the excellence layer, then verifies. Retry-with-feedback: on a re-attempt it feeds the last failure reason back to the agent. |
| `src/verify.ts` | The verify rules — **the zero-trust gate.** `nonempty` · `contains:` · `min:N` (weak floors); `json` / `json:keys` · `wcag` (declared text/bg pair ≥ 4.5:1 AA) · `sql_applies` (runs the DDL in a rolled-back tx) · `site_renders` (headless chromium screenshot must be non-blank + structural HTML + no external/placeholder assets). Also exports `firstJson()` (parses the FIRST brace-balanced block) and `SITES` (the `sites/` URL). |
| `src/agents.ts` | An agent is *just one API call*: `Ctx {brief, upstream, feedback?, pages?, self?}` in → text/artifact out. `ROLE` holds one system prompt per department; `build` is a Tailwind-utility-class design contract; `content`/`branding` emit a single JSON object. Provider = **MiniMax** (OpenAI-compatible). Exports `runAgent()` and the generic `llm()` (used by the planner). With no `MINIMAX_API_KEY`, deterministic **stubs** run so the whole engine works offline. |
| `src/excellence.ts` | `applyExcellence(html)`: compiles the vendored Tailwind v4 standalone binary (`tools/tailwindcss`, gitignored, ~120MB) **scoped to just that one page** via `@import "tailwindcss" source(none); @source "<abs page>";` (~150ms, not ~1min) + inlines base64 WOFF2 fonts, then injects one `<style>` before `</head>`. **Never throws** — on any failure it returns the input unchanged. |
| `src/fonts.ts` | Generated. The base64 `@font-face` WOFF2 blob (`FONT_FACES`) that `excellence.ts` inlines (Inter / Space Grotesk / Fraunces). Large; do not hand-edit. |
| `src/kpi.ts` | `computeKpi`: the one source of truth for KPIs (API + CLI). **Honest by construction**: a deadlocked project (nothing can move but work remains) reports `status: 'blocked'`, not `'running'`; "verification rigor" counts **only** real checks (`sql_applies` / `site_renders` / `wcag` / `json*`), never the weak floors. |
| `src/db.ts` | The `pg` Pool + helpers: `makePool`, `applySchema` (re-runnable DDL), `ev` (log a `run_event`), `counts`, `board`. `DATABASE_URL` defaults to the local docker Postgres on `:5439`. |
| `src/run.ts` | CLI entrypoint: `npm run run -- "your brief"` — plan + run a brief to completion, print the board. (Re-applies the schema unless `RESET=0`.) |
| `src/demo.ts` | The end-to-end **proof**: plan → run 3 steps → simulate a crash → restart → finish, then assert against the DB (all tasks `done`, the unblock trigger fired, the database task produced real SQL). Exits non-zero on any failure. This is your "is the engine still honest" test. |
| `src/kpi-cli.ts` | `npm run kpi -- [projectId]` — the same numbers as `/api/kpi`, in the terminal. |

Other directories:
- `db/schema.sql` — the engine as SQL: `projects`, `tasks`, `task_dependencies`, `task_outputs`, `run_events`, the `task_status` enum, the `v_ready_tasks` view, and the `trg_unblock` trigger that promotes downstream tasks the instant an upstream hits `done`. Re-runnable (drops + recreates).
- `web/` — the frontend. `index.html` (nav: Your sites / Roadmap / About / + New, hamburger on mobile), `app.js` (hash router `#/`, `#/p/:id` tabs, `#/roadmap` visual timeline, in-place reconciling card updates), `styles.css` (design system + responsive).
- `tools/` — `setup.sh` (vendors the Tailwind binary), `tailwindcss` (the gitignored binary), `render-*.mjs` (offline diagram renderers).
- `assets/` — the source WOFF2 fonts (gitignored) that were base64'd into `src/fonts.ts`.
- `docs/` — `SPEC.md`, `RELAY-STACK-DECISION.md`, `OPERATIONS.md`, diagrams.

---

## 3. Core conventions — never violate these

These are not style preferences. Each one is wired into the code and into how the product stays
honest. Breaking one is a regression even if everything still "looks" green.

1. **Zero-trust verification.** A task is `done` **only** when its deterministic check in
   `verify.ts` passes. Never trust an agent's prose ("I built the page"), never trust your own
   reasoning that the output is fine. If you add capability, add a check that *runs/renders/parses*
   the thing — not one that just looks for a keyword. See the rigor distinction in `kpi.ts`:
   `nonempty`/`min`/`contains` are weak floors and do **not** count toward rigor; only
   `sql_applies`/`site_renders`/`wcag`/`json*` do.

2. **An agent is exactly one API call.** `Ctx` (brief + the upstream outputs it depends on +
   optional feedback/pages/self) → text/artifact out. No multi-step agent internals, no tool loops,
   no hidden state. If a department needs more power, it gets a better prompt or a better verify
   gate — not an inner agent framework.

3. **The dashboard never lies.** KPIs and status come from real DB rows via `kpi.ts`. A stuck
   project says `blocked`; rigor reflects only real checks; completion reflects verified `done`
   tasks. Do not invent optimistic numbers, do not report "running" when nothing can move, do not
   show a site link unless the file actually exists on disk (`server.ts` checks
   `existsSync(.../index.html)` before exposing `/sites/<id>/`).

4. **Verify on MOBILE, not desktop.** The operator views this on a phone. A change to `web/` is not
   "done" until you've checked the **mobile viewport** (hamburger nav, phone-first layout). A real
   past bug: a "responsive" change that was only verified on desktop and shipped broken on mobile
   (commit `e4c1584`). Produced sites are render-checked at `1280×860`, but the **Relay UI itself**
   must be verified narrow.

5. **State lives in Postgres; the runner is disposable.** Never hold graph/scheduling logic in
   memory across a run. Everything is recomputed from rows (`v_ready_tasks`, the trigger,
   lease reclaim). This is what makes crash/restart resume work — don't undermine it by caching
   readiness or progress in the Node process.

6. **Never store projects in memory.** Relay projects are DB rows, not entries in any agent memory /
   notes / scratchpad system. Don't push project state into an external memory store "to be helpful."

7. **Sites are self-contained and gate-safe.** A produced page ships zero external references — all
   CSS and fonts are inlined by `excellence.ts`, all imagery is CSS/SVG/inline. `site_renders`
   actively rejects `src=http…`, `url(http…)`, external `<link>`, `app.css`, `via.placeholder`, and
   unfilled `[Placeholder]` copy. Do not "optimize" by linking to a CDN — it will (correctly) fail
   the gate and is also a durability liability.

8. **Excellence must never break a build.** `applyExcellence` is wrapped so any failure returns the
   HTML unchanged. Keep it that way — the design layer is an enhancement, not a dependency of
   shipping.

---

## 4. How to extend safely

General rule: make the smallest change that adds the capability **plus its deterministic check**,
then prove it with `npm run demo` and a real run. Don't gold-plate.

### Add a new verify rule
1. Add a branch in `verify(pool, task, content)` in `src/verify.ts`. It must do real work
   (run / render / parse) and return `{ ok, log }` with an honest, specific `log`.
2. If it's a *real* check (not a weak floor), add its name to the `realCheck` filter in
   `src/kpi.ts` so rigor counts it. If it's a weak floor, deliberately leave it out.
3. Wire it where tasks are created — in `planner.ts` `validate()` (set `t.verify = '<rule>'` for the
   relevant department) or in the build/qa task construction.
4. Prove it: feed a brief that exercises the new department, confirm a passing run and a
   *failing* one (the gate must actually be able to say no — a check that can't fail is theater).

### Add a new department (agent)
1. Add a one-line role to `ROLE` in `src/agents.ts` (system prompt) and a matching `stub()` case so
   the offline path still produces something valid.
2. Decide its verify rule and bind it in `planner.ts` `validate()` (the planner maps departments →
   verify rules; e.g. `branding`→`wcag`, content/copy→`json`, else `min:280`). If the LLM planner
   may emit your department by name, make sure `validate()` keeps it (today it drops only `build`/`qa`
   from the thinking phase, which are re-added deterministically).
3. If the department writes a file, give its task an `artifact` (e.g. `something.html`) — `runner.ts`
   will persist `sites/<projectId>/<artifact>`, run the sanitizer + excellence layer, and
   `site_renders` will verify it.

### Add a page / change the page set
- Pages come from the planner's `{pages}` (2–5, first must be `{slug:'index', title:'Home'}`) and are
  stored in `projects.params.pages`. `validate()` emits one `build` task per page
  (`artifact=<slug>.html`, `verify=site_renders`) that fans in from **all** thinking steps, plus a
  `qa` task on Home. The `build` agent receives `self` (this page) and `pages` (the whole nav) so it
  emits a shared sticky nav with relative `<slug>.html` links. To change page rules, edit `normPages`
  / the build-task loop in `planner.ts` — keep "first page is always `index`."

### Add a new stack / SSG (the planned Phase 5/6 work)
- See `docs/RELAY-STACK-DECISION.md` and `ROADMAP.md`. The intended shape: a **deterministic**
  classifier in the planner picks an archetype/stack and writes `params.archetype` / `params.stack`;
  a new verify rule (e.g. `ssg_builds` = "the SSG build exits 0") proves it. Keep the same contract:
  agents emit content as text, the runner writes files and a deterministic check decides `done`.
  Do not introduce a stack whose success can't be checked deterministically.

### Change the planner
- The LLM output is untrusted: `llmPlan()` strips fences, slices the first `{`…last `}`, parses, and
  **everything real is enforced in `validate()`**, not assumed from the LLM. If you loosen
  `validate()`, you loosen the guarantees. Keep these invariants: exactly one canonical `branding`
  task on `wcag`; one render-verified `build` per page; `depends_on` only references earlier seqs
  (it re-maps + de-cycles); a usable template fallback when the LLM is unavailable.

### Change the served frontend (`web/`)
- `server.ts` cache-busts `app.js`/`styles.css` by stamping their mtime into `index.html` and sends
  `no-cache` on the shell, so a change always invalidates — you don't need to hand-bump versions.
  After editing, **verify on a mobile viewport** (convention #4).

---

## 5. Known gotchas (these have bitten before)

- **`firstJson` parses ONE brace-balanced block.** Agents (esp. `content`/`copywriting`) sometimes
  emit two JSON objects back-to-back. `firstJson()` in `verify.ts` walks braces and returns the
  first complete object; the prompts explicitly say "exactly one JSON object, no second block." If
  you change JSON handling, preserve this — naive `JSON.parse` on a two-block reply throws and would
  fail valid work.
- **Tailwind source-scoping is what makes excellence fast.** The input CSS is
  `@import "tailwindcss" source(none); @source "<abs page path>";`. `source(none)` disables v4's
  whole-tree auto-scan (~1 min); `@source` scopes it to the single page (~150ms). Don't remove either
  — and `@source` needs an **absolute** path to the temp page file.
- **The sanitizer strips external/placeholder assets *before* verify.** `processTask` in `runner.ts`
  removes external `<img>`, `url(http…)`, and placeholder images and replaces them with a gradient.
  This is a safety net so a slightly-off agent output still ships; `site_renders` is the hard gate
  that rejects anything that slips through. Keep both layers.
- **Cache-busting is automatic, by mtime.** Served `/sites/*` assets get `max-age=3600`; the Relay
  shell gets `no-cache` and mtime-stamped query strings. If you see "stale UI," it's almost never a
  caching bug in your change — check you actually saved the file.
- **`site_renders` shells out to `chromium-browser`** (`/usr/bin/chromium-browser`, headless,
  `--no-sandbox`) and needs a real screenshot > 3KB. If renders fail wholesale, check chromium is
  installed and the box has the libs — not your HTML. The home page's shot becomes the board
  thumbnail (`preview.png`); other pages get throwaway shots.
- **`max_attempts` is 3.** A task retries with feedback up to 3 times, then goes `failed`. A
  permanently-failing verify rule will burn 3 LLM calls per task — make new rules deterministic and
  fast.
- **Stub mode is real mode for tests.** With no `MINIMAX_API_KEY`, `npm run demo`/`run` use
  deterministic stubs. That's how the proof stays reproducible offline. Don't write code that assumes
  a live key is present.
- **`fonts.ts` is generated and huge.** Don't hand-edit it. Regenerate from `assets/*.woff2` if fonts
  change.

---

## 6. How to verify a change is actually real (not self-reported)

Apply zero-trust to your *own* work. "I think it works" is not done. Run the deterministic checks:

```bash
# 0. one-time after clone: vendor the Tailwind binary (~120MB, gitignored)
bash tools/setup.sh

# 1. local Postgres (the board)
docker run -d --name ap-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=agency \
  -p 5439:5432 --restart unless-stopped postgres:16
#   (on this host ap-pg already exists, restart policy = unless-stopped)

npm install

# 2. typecheck — a real check, not a vibe
npm run build

# 3. THE proof: plan -> run 3 steps -> crash -> restart -> finish, with DB assertions.
#    Exits non-zero if any task isn't verified done, or the unblock trigger never fired.
npm run demo

# 4. run a real brief end-to-end and confirm a site exists on disk
npm run run -- "a coffee roastery in Lisbon"
ls sites/*/index.html          # the artifact must physically exist
npm run kpi                    # rigor/completion from real rows, honest by construction
```

For the served UI, start the server and check the **mobile** viewport, then confirm a produced site
renders self-contained:

```bash
npm run serve                  # Relay on 0.0.0.0:8787
curl -s localhost:8787/healthz # -> ok
curl -s localhost:8787/api/kpi | head
# then load http://<host>:8787/ in a NARROW viewport (phone), submit a brief,
# and open the finished /sites/<id>/ — it must render with no network requests.
```

What "real" means, concretely:
- **Engine honest** → `npm run demo` exits 0 (all tasks `done`, trigger fired, DB-task SQL applied).
- **Site shipped** → `sites/<id>/index.html` exists, > 400 bytes, passes `site_renders` (non-blank
  chromium shot, structural HTML, zero external/placeholder assets).
- **Dashboard honest** → a deadlocked project shows `blocked`; rigor counts only real checks.
- **UI shipped** → verified on a phone-width viewport, not just desktop.

If a check can't fail, it isn't a check. Add capability *and* the gate that can say no, then run the
gates above before you call anything done.

---

## 7. Production / durability (one paragraph; details in `docs/OPERATIONS.md`)

Relay's HTTP server currently runs via a bare `npm exec tsx src/server.ts` (parent `init`, **no
supervisor**) — it dies on crash/reboot and must be put under a supervisor to last. Postgres is the
`ap-pg` docker container (`restart=unless-stopped`, survives reboot). Public traffic to
`board.naples.agency` currently flows Cloudflare → a **manually-started** `cloudflared` named tunnel
(`anouf-chat`) → `127.0.0.1:8787`; an **enabled-but-inactive** systemd unit
`anouf-named-tunnel.service` already exists to run that tunnel durably (the manual `nohup` process
duplicates it). Tailscale Funnel also already fronts `:8787` at `anouf.tailbb043c.ts.net`. **Other
people's live services share this box** — `saiid-wp-caddy-1` owns `:80/:443` on the public IP,
`ephemeris` is served by host Caddy, and `dash`/`gab44`/`fleet*` ride the same cloudflared tunnel —
**do not stop, rebind, or "clean up" any of them.** Read `docs/OPERATIONS.md` before changing
anything that listens on a port or proxies traffic.

# AGENTS.md — read this first

You are an AI agent (or a new dev) about to change **Relay**, the autonomous agency pipeline in this
repo. This file is the contract for continuing the work without breaking it. Read it top to bottom
before you touch anything. It is deliberately concrete: real file paths, real commands, real gotchas.

If you only remember one thing: **completion is a deterministic external check, never an agent's
word, never your own claim that "it's done."** That principle is load-bearing in the code and in how
you should work on the code.

---

## 0. Current state (2026-07-02 — read before the map below)

- **ONE pipeline, ONE CMS.** Every brief flows `POST /api/run` → plan → compose (one site model) →
  deterministic render → verify → **Directus** finalize (served_from_cms mutation proof) → QA.
  The CMS is **hardcoded** in the planner; `npm run cms:check` fails the build if a second CMS, a
  selector, or a parallel build endpoint is reintroduced. The old 5-CMS goal, the per-brief
  selector, and the WordPress/WooCommerce `/api/cms-run` generator are **deleted** (see `GOAL.md`).
- **Deleted 2026-07-02 (do not resurrect):** `src/cms.ts` (regex text-overlay), `src/cms/select.ts`
  + rotation, `src/cms/{wordpress,drupal,usecase,pending}*`, `src/mailer.ts`/`mail-cli.ts` (unused —
  email returns with user accounts; the naples.agency SMTP/DNS config remains), `src/evolver.ts`,
  and `src/demo.ts`/`src/run.ts` (dev CLIs that could DROP the live schema).
- **Forward priority (owner, 2026-07-02):** high-converting landing pages → deeper full-stack
  (typed forms, relations, migrations) → **user accounts**. See ROADMAP.md "Where we're moving".

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
| `src/runner.ts` | The whole scheduler (`runLoop`): `reclaim` (lease expiry → resurrect crashed tasks) → `reconcile` (promote ready via the `v_ready_tasks` view, a safety net) → `claim` (`FOR UPDATE SKIP LOCKED`) → `processTask`. `processTask` runs the agent, then for a build task parses its JSON **spec** (`firstSpec` — first brace-balanced object, rejected if <2 sections) → `renderPage` (deterministic vetted components) → `processMedia` (fills `<img data-q>` with real Pexels photos) → write the artifact to disk → verify. On project completion it fires `cmsFinalize` (re-serve through Directus, gated by `served_from_cms`) and `reviewSite` (visual QA) — both fire-and-forget. Retry-with-feedback: on a re-attempt it feeds the last failure reason back to the agent. |
| `src/verify.ts` | The verify rules — **the zero-trust gate.** `nonempty` · `contains:` · `min:N` (weak floors); `json` / `json:keys` · `wcag` (text/bg ≥ 4.5:1 AA) · `sql_applies` (DDL in a rolled-back tx) · `app_db` (provisions the project's **isolated** schema for real via `appdb`, asserts tables exist) · `site_renders` (**static, no browser**: structural HTML + no external/placeholder assets + **no dead CTA `href="#"` / no unwired form**; pages are composed from vetted components so contrast/layout are correct by construction — the board thumbnail is produced off the hot path by `qa.ts`). Exports `firstJson()` and `SITES`. |
| `src/agents.ts` | An agent is *just one API call*: `Ctx {brief, upstream, feedback?, pages?, self?}` in → text/artifact out. `ROLE` holds one system prompt per department; `build` is a strict JSON **spec** contract (brand tokens + an ordered list of 3–6 sections) — it writes no HTML/CSS; a deterministic renderer turns the spec into the page. `content`/`branding` emit a single JSON object. Provider abstraction in `callLLM`: **OpenRouter preferred** (`OPENROUTER_API_KEY`, pinned to a MiniMax reasoning model `OPENROUTER_MODEL`=`minimax/minimax-m2.7`) with **server-side web search** (OpenRouter's `web` plugin) auto-enabled for the `research`/`strategy` departments and the planner — grounding them in live, cited facts within the SAME single call (downstream JSON agents inherit the facts through the DAG; the model's chain-of-thought returns in a separate `reasoning` field so `content` stays clean — no `<think>` leak). Falls back to **MiniMax-direct** (`MINIMAX_API_KEY`, no web), then deterministic **stubs** (no key) so the engine runs offline. `build` gets `max_tokens` 8000, web/reasoning roles 4000, others 3000. Exports `runAgent()` and the generic `llm(system, user, maxTokens, {web})` (used by the planner). |
| `src/render.ts` | The **deterministic renderer**. `renderPage(spec, {pages, slug, title, projectId})` composes the full HTML from vetted components — no LLM touches structure/CSS/nav. It **derives the whole WCAG-safe palette** (text/muted/lines/on-primary/surface) from just `bg`+`primary` via luminance/contrast math, so legibility is guaranteed regardless of which 2 colours the model picked. Stamps the marker `<!--relay:rendered-->` in `<head>` and injects a small `relaySubmit()` script (forms POST to `/api/site/<id>/submit`). |
| `src/components.ts` | The **design system** the renderer composes from. `DS_CSS` = inlined base64 `FONT_FACES` + token-driven CSS (consumes the theme's CSS vars with safe defaults) + a **CSS-only checkbox hamburger nav**; `.nav-inner` uses `var(--container)` so the header aligns with the body in every theme. Exports `esc`, `ctaParts` (normalize a CTA that may be a string OR an object → never `[object Object]`/empty), `navBar`, `footer`, and the `SECTIONS` record (`hero`/`features`/`split`/`gallery`/`cta`/`form`/`feed`/`collection`/`pricing`/`testimonials`/`faq`/`stats`). Every CTA routes by **intent** via `render.ts`'s resolver (model `link` → keyword→page → sensible fallback; never `href="#"`, never "last page"). `feed` reads submissions; `collection` reads a real DB table; `form` writes (contact bucket OR, with `table`, a typed row into the real table). |
| `src/themes.ts` | **Rooted identity (roadmap 09).** 5 deterministic **design languages** (editorial/modern/warm/bold/minimal). `classifyTheme(brief)` (de-accented, closed set) or an LLM-named theme validated by `themeFor`; `themeVars(name)` returns the CSS-var block (type scale, rhythm, shape, font pairing). Structure, not authored — the model never writes CSS. |
| `src/archetype.ts` | **Archetype routing (roadmap 10).** `classifyArchetype(brief)` → `site` / `app` / `store` (closed set, `archetypeFor` validates an LLM value); `needsData()` ⇒ app/store get a real, `app_db`-verified database department, injected by the planner if missing. |
| `src/fonts.ts` | Generated. The base64 `@font-face` WOFF2 blob (`FONT_FACES`) that the design system (`components.ts`, via `DS_CSS`) inlines (Inter / Space Grotesk / Fraunces). Large; do not hand-edit. |
| `src/media.ts` | **Real media (roadmap 06).** The build agent emits `<img data-q="search terms">`; `processMedia` pulls a real licensed photo from **Pexels**, downloads it into `sites/<id>/assets/`, and rewrites the tag to a **local** `src` — so it renders in the `file://` gate AND passes the "no external asset" check. Existing photos only, never generation. No `PEXELS_API_KEY` → placeholders dropped (text-only site). |
| `src/cms/` | **CMS-native layer (ONE CMS: Directus — GOAL.md).** ONE shared Directus instance (`DIRECTUS_URL`/`DIRECTUS_TOKEN`) backed by the existing Postgres; per-project isolation via `project_id` row filtering in shared collections. `types.ts` (CmsTarget contract) · `directus.ts` (provision + content sync + buildAndServe from CMS reads) · `gate.ts` (`served_from_cms` mutation proof) · `finalize.ts` (re-serve a finished site through the CMS, guarded) · `live.ts` (serve pages fresh from the CMS per request) · `check.ts` (`npm run cms:check`, the one-CMS invariant) · `prove-directus.ts` (real e2e proof). Replaces the deleted inline text-editor. |
| `src/schema.ts` | **Database perfection (roadmap 11) — the schema compiler.** `parseModel()` reads the DB department's typed JSON **data model** (entities, fields, relations); `compile()` emits flawless Postgres DDL: serial PK + `created_at timestamptz default now()` on every table, `money → numeric(12,2)`, `ref:<entity> → real FK + index`, required/unique/defaults, dependency-ordered (cycles demoted). The DB analog of the page renderer — the model says *what*, the compiler configures *how*. |
| `src/appdb.ts` | **Live per-project database (roadmap 11).** Each project's tables live in their **own** schema `app_<hex>`, NEVER `public` (`schemaName` throws on anything else). `compileDDL` (model → perfect DDL, else confined raw SQL); `provision()` is idempotent + non-destructive (preserves data on rebuild), `statement_timeout`-bounded; `readRows`/`insertRow` validate identifiers against the schema's own catalog + parameterize + strip sensitive columns; `describeSchema()` introspects it (the system **knows** the DB). |
| `src/kpi.ts` | `computeKpi`: the one source of truth for KPIs (API + CLI). **Honest by construction**: a deadlocked project reports `status: 'blocked'`, not `'running'`; "verification rigor" counts **only** real checks (`sql_applies` / `app_db` / `site_renders` / `wcag` / `json*`), never the weak floors. |
| `src/browser.ts` | **The shared browser** (stack review #1). ONE lazy-launched, long-lived **Playwright** Chromium (Playwright's own build, not snap; `--no-sandbox --disable-dev-shm-usage --disable-gpu`), auto-relaunched on disconnect, with a FIFO concurrency limiter (`BROWSER_CONCURRENCY`, default 2). Exports `withPage(opts, fn)` (context-per-call, always closed), `screenshot(url, opts)`, `closeBrowser()`. Every browser path (dogfood, qa, theme:check) goes through this — no more spawn-per-call chromium or hand-rolled CDP. CLIs must `closeBrowser()` before exit or the process hangs. |
| `src/dogfood.ts` | **Interaction QA (roadmap 12) — the human-experience reviewer.** Drives the shared **Playwright** browser (`page.goto(networkidle)` + `page.evaluate` probes): visits every page at desktop + mobile, measures header alignment + overflow, checks every CTA goes somewhere, **types into + submits** the form (asserts the confirmation AND that the row persisted, then deletes its own QA row), confirms collections render live rows (judged against the data API — rows-in-DB-but-0-rendered = a real bug). `repairPlan()` (pure) re-opens affected page builds with the findings as feedback (capped 1 round). `dogfoodSite()` auto-runs on completion → `dogfood_reviews`; `npm run dogfood -- <id>`. |
| `src/qa.ts` | **Visual QA + board thumbnail.** `reviewSite()` screenshots the **served http url** (so live collections render) mobile + desktop via the shared browser, ALWAYS writes the board `preview.png` first, then (if a vision key is set) scores issues → `qa_reviews`. |
| `src/db.ts` | The `pg` Pool + helpers: `makePool`, `ensureDatabase` (create a scratch DB), `applySchema` (**guarded**: refuses to drop a populated board unless `ALLOW_DB_RESET=1`), `ev`, `counts`, `board`. `DATABASE_URL` resolved lazily; defaults to local docker Postgres `:5439`. |
| `src/kpi-cli.ts` | `npm run kpi -- [projectId]` — the same numbers as `/api/kpi`, in the terminal. |
| `src/worker.ts` | **Standalone build worker (stack review #7), opt-in.** Polls Postgres for projects with unfinished tasks and runs `runLoop` with a unique `runnerId` (`worker-<pid>`); safe to run many alongside the API (`SKIP LOCKED` + leases). To flip the split on: set `RELAY_BUILD=0` on `relay.service` (web then only PLANS, never builds in-process) and start `relay-worker.service` / `npm run worker`. **Default is unchanged** — the web server still builds; the worker is extra capacity until you flip it. |

Other directories:
- `db/schema.sql` — the engine as SQL: `projects`, `tasks`, `task_dependencies`, `task_outputs`, `run_events`, the `task_status` enum, the `v_ready_tasks` view, and the `trg_unblock` trigger that promotes downstream tasks the instant an upstream hits `done`. Re-runnable (drops + recreates).
- `web/` — the frontend. `index.html` (nav: Your sites / Roadmap / About / + New, hamburger on mobile), `app.js` (hash router `#/`, `#/p/:id` tabs, `#/roadmap` visual timeline, in-place reconciling card updates), `styles.css` (design system + responsive).
- `tools/` — `render-*.mjs` (`render-dag.mjs` + `render-mindmap.mjs`, the offline SVG diagram renderers).
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
   CSS and fonts are inlined by the design system (`components.ts` `DS_CSS`), and every image is a
   real photo downloaded locally (or dropped). `site_renders` actively rejects `src=http…`,
   `url(http…)`, external `<link>`, `app.css`, `via.placeholder`, and unfilled `[Placeholder]` copy.
   Do not "optimize" by linking to a CDN — it will (correctly) fail the gate and is also a durability
   liability.

8. **Structure is composed, not authored.** The page is assembled from vetted components in
   `render.ts`/`components.ts`, so nav, spacing, fonts, and contrast are correct **by construction** —
   the model only supplies copy, a section ordering, and 2 brand colours (`bg`+`primary`), and the
   renderer derives the rest of the WCAG-safe palette deterministically. Don't move structure/CSS
   decisions back into the LLM; if a section type is missing, add it to `SECTIONS`, not to a prompt.

---

## 4. How to extend safely

General rule: make the smallest change that adds the capability **plus its deterministic check**,
then prove it with the deterministic checks (`npm run build` · `spec:check` · `cms:check` · `theme:check`) and a real brief through the running server. Don't gold-plate.

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
   will persist `sites/<projectId>/<artifact>`. (For build pages specifically it renders the spec via
   `render.ts`, fills Pexels media, and freezes the snapshot before write; a plain HTML artifact is
   written as-is.) Either way `site_renders` will verify it.

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

- **Never reset the live schema.** `src/demo.ts`/`src/run.ts` (dev CLIs that re-applied
  `db/schema.sql`, which opens with `DROP TABLE … CASCADE`) were **deleted 2026-07-02** for exactly
  this foot-gun; `db.ts` `applySchema()` still **refuses** to drop a DB whose `projects` table is
  non-empty unless `ALLOW_DB_RESET=1`. Do **not** set `ALLOW_DB_RESET=1` just
  to make a test/run pass — that is exactly how a live board got wiped once (recovered from
  `/root/backups/relay-db`). To exercise a real board, set `DATABASE_URL` explicitly **and** `RESET=0`
  (append, never wipe). Production briefs go through `POST /api/run` in `server.ts`, which never resets.
- **Themes are STRUCTURE (deterministic), in `src/themes.ts`.** The brief is classified
  (`classifyTheme`, brief-rooted, de-accented, closed set of 5) into a design language; the renderer
  expands it into fonts + type scale + rhythm + shape, WCAG-safe by construction. The LLM may only
  *name* a theme (validated by `themeFor`, deterministic fallback) — it never authors CSS. Prove theme
  changes with `npm run theme:check` (renders all 5, runs the real `site_renders` gate + AA, mobile+desktop).
- **`firstJson` parses ONE brace-balanced block.** Agents (esp. `content`/`copywriting`) sometimes
  emit two JSON objects back-to-back. `firstJson()` in `verify.ts` walks braces and returns the
  first complete object; the prompts explicitly say "exactly one JSON object, no second block." If
  you change JSON handling, preserve this — naive `JSON.parse` on a two-block reply throws and would
  fail valid work.
- **`firstSpec` parses ONE brace-balanced spec, and rejects thin specs.** `firstSpec()` in
  `runner.ts` walks braces for the first complete object and the build is rejected if it isn't a
  valid spec with ≥2 sections (so a half-emitted reply can't ship). The build prompt says "JSON only,
  no prose, no second block" for the same reason.
- **`processMedia` never ships a broken `<img>`.** `media.ts` fills each `<img data-q="terms">` with a
  real local Pexels photo; if a query can't be filled (or there's no `PEXELS_API_KEY`) the tag is
  dropped entirely rather than left pointing at nothing. `site_renders` is the hard gate that rejects
  any external/placeholder asset that slips through. Keep both layers.
- **Cache-busting is automatic, by mtime.** Served `/sites/*` assets get `max-age=3600`; the Relay
  shell gets `no-cache` and mtime-stamped query strings. If you see "stale UI," it's almost never a
  caching bug in your change — check you actually saved the file.
- **`site_renders` no longer touches a browser** (stack review #1). It is now purely static
  (structural HTML + no external/placeholder assets + no dead CTA / unwired form) — pages are composed
  from vetted components so contrast/layout are correct by construction, making the old screenshot
  gate redundant theatre. The board thumbnail (`preview.png`) is produced off the hot path by
  `qa.ts`. **All real browser work goes through the ONE shared Playwright browser in `src/browser.ts`**
  (dogfood, qa, theme:check) — Playwright bundles its own Chromium (no snap, no system
  `chromium-browser`), so "chromium didn't come up" / CDP startup races are gone. If a browser path
  hangs in a CLI, you forgot `closeBrowser()` before exit. Tune parallelism with `BROWSER_CONCURRENCY`.
- **`max_attempts` is 3.** A task retries with feedback up to 3 times, then goes `failed`. A
  permanently-failing verify rule will burn 3 LLM calls per task — make new rules deterministic and
  fast.
- **Stub mode is real mode for tests.** With no provider key (`OPENROUTER_API_KEY` or `MINIMAX_API_KEY`), the pipeline uses
  deterministic stubs. That's how the proof stays reproducible offline. Don't write code that assumes
  a live key is present.
- **`fonts.ts` is generated and huge.** Don't hand-edit it. Regenerate from `assets/*.woff2` if fonts
  change.

---

## 6. How to verify a change is actually real (not self-reported)

Apply zero-trust to your *own* work. "I think it works" is not done. Run the deterministic checks:

```bash
# 1. local Postgres (the board)
docker run -d --name ap-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=agency \
  -p 5439:5432 --restart unless-stopped postgres:16
#   (on this host ap-pg already exists, restart policy = unless-stopped)

npm install                      # that's it after clone — no binary to vendor

# 2. typecheck — a real check, not a vibe
npm run build

# 3. THE deterministic checks — every one must pass
npm run spec:check && npm run cms:check && npm run theme:check

# 4. run a real brief end-to-end through the RUNNING server (never reset the live DB)
curl -s -X POST localhost:8787/api/run -H 'content-type: application/json' \
  -d '{"brief":"a coffee roastery in Lisbon"}'
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
- **Engine honest** → `spec:check`/`cms:check`/`theme:check` exit 0 and a real brief reaches `done` with `params.cms_built='directus'` (the served_from_cms gate passed).
- **Site shipped** → `sites/<id>/index.html` exists, > 400 bytes, passes `site_renders` (non-blank
  chromium shot, structural HTML, zero external/placeholder assets).
- **Dashboard honest** → a deadlocked project shows `blocked`; rigor counts only real checks.
- **UI shipped** → verified on a phone-width viewport, not just desktop.

If a check can't fail, it isn't a check. Add capability *and* the gate that can say no, then run the
gates above before you call anything done.

---

## 7. Production / durability (one paragraph; details in `docs/OPERATIONS.md`)

Relay's HTTP server runs under **systemd as `relay.service`** (tsx `src/server.ts` on `:8787`,
restart-on-failure, survives reboot) — **deploy a code change with `systemctl restart relay.service`**,
then confirm `curl localhost:8787/healthz` → `ok` (tsx reads source fresh, so the restart picks up the
new code; the runner is stateless and resumes from the DB). Postgres is the `ap-pg` docker container
(`restart=unless-stopped`, survives reboot). Public traffic to `board.naples.agency` flows Cloudflare →
**`relay-tunnel.service`** (`cloudflared`) → `127.0.0.1:8787`. Tailscale Funnel also fronts `:8787` at
`anouf.tailbb043c.ts.net`. **Other
people's live services share this box** — `saiid-wp-caddy-1` owns `:80/:443` on the public IP,
`ephemeris` is served by host Caddy, and `dash`/`gab44`/`fleet*` ride the same cloudflared tunnel —
**do not stop, rebind, or "clean up" any of them.** Read `docs/OPERATIONS.md` before changing
anything that listens on a port or proxies traffic.

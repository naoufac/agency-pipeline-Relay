# Relay — Architecture (how it really works)

This is the authoritative reference for how Relay turns a one-line **brief** into a real,
shippable, multi-page **website**. It is written to be actionable by both a human engineer
and an AI agent. Every statement here is grounded in the actual source under `src/` and
`db/schema.sql`; read those files for the final word.

Relay is an **autonomous agency pipeline**. A brief comes in, an LLM **planner** explodes it
into a **DAG of tasks**, AI **department agents** (one API call each) run them stage-by-stage,
every output must pass a **deterministic verify gate** (zero-trust: never trust an agent's
word), and the result is a self-contained, modern, multi-page site served at `/sites/<id>/`.

---

## 1. The big picture

```
                         ┌──────────────────────────────────────────────┐
   brief (POST /api/run) │                  RELAY ENGINE                 │
        │                │                                              │
        ▼                │   planner.ts        runner.ts                │
  ┌───────────┐  plan()  │  ┌──────────┐  claim ┌─────────────┐         │
  │  Planner  │─────────▶│  │ DAG into │───────▶│  runLoop     │         │
  │ (LLM/MM)  │          │  │ Postgres │        │ (scheduler)  │         │
  └───────────┘          │  └──────────┘        └──────┬──────┘         │
        │                │       ▲                      │ per ready task │
        │ tasks+pages    │       │ unblock trigger      ▼                │
        ▼                │       │ + v_ready_tasks  ┌─────────────┐      │
  ┌───────────┐          │       └──────────────────│ processTask │      │
  │ Postgres  │◀─────────┼──────────────────────────│  1 API call │      │
  │ (truth)   │          │                          │  agents.ts  │      │
  └───────────┘          │                          └──────┬──────┘      │
                         │                                 ▼             │
                         │   verify.ts   ┌──────────────────────────┐    │
                         │   ZERO-TRUST  │ deterministic verify gate│    │
                         │   GATE        │ (wcag/json/sql/renders…) │    │
                         │               └─────────┬────────────────┘    │
                         │                   pass? │ yes                  │
                         │                         ▼                      │
                         │   excellence.ts  ┌──────────────────┐         │
                         │   (build tasks)  │ Tailwind compile │         │
                         │                  │ + inline fonts   │         │
                         │                  └────────┬─────────┘         │
                         │                           ▼                   │
                         │             sites/<project_id>/<slug>.html    │
                         └───────────────────────────┬──────────────────┘
                                                     ▼
                                        server.ts  →  GET /sites/<id>/
                                        (the live, shippable website)
```

**One invariant rules the whole system:** *Postgres is the single source of truth.* The
scheduler holds no graph state in memory — it recomputes everything it needs from the DB on
every iteration. That is what makes Relay **restart-safe**: kill the process at any moment and
it resumes exactly where it left off (see §6).

**One discipline rules quality:** *zero-trust.* An agent's text output is never trusted just
because the agent produced it. A task only reaches `done` when a **deterministic** check —
code that runs SQL, parses JSON, computes WCAG contrast, or screenshots a real headless
browser render — says so (see §5).

---

## 2. End-to-end flow (the happy path)

1. **Brief in.** `POST /api/run {"brief":"..."}` → `server.ts` calls `plan(pool, brief)`.
2. **Plan.** `planner.ts` asks the LLM for `{pages, tasks}`, runs `validate()` (which *forces*
   the structural guarantees in §4), and writes one `projects` row + N `tasks` rows + their
   `task_dependencies` edges. Root tasks (no upstreams) are flipped `blocked → ready`.
3. **Run.** `server.ts` fires `runLoop(pool, id, {cap:4})` (fire-and-forget; the board shows
   progress live).
4. **Claim.** `runLoop` claims up to `cap` `ready` tasks atomically with
   `FOR UPDATE SKIP LOCKED`, marking them `running` with a 240s lease.
5. **Agent call.** For each claimed task, `processTask` builds a context (`brief` + upstream
   outputs + any retry feedback + page set) and makes **one** LLM API call via
   `runAgent(department, ctx)` (`agents.ts`).
6. **Persist output.** The raw text goes to `task_outputs` (the previous current row is
   demoted, the new one is `is_current=true`). If the task has an `artifact` (build pages), the
   output is sanitized, run through the **excellence layer**, and written to
   `sites/<project_id>/<artifact>` on disk.
7. **Verify (the gate).** The task goes `verifying`, then `verify(pool, task, content)` runs the
   task's deterministic rule. **Pass →** `done` (which fires the unblock trigger, promoting
   downstream tasks to `ready`). **Fail →** `ready` again (retry with feedback) until
   `attempts >= max_attempts`, then `failed`.
8. **Repeat** until no task is `ready` or `running`. The project is marked `done` if nothing is
   left unfinished and nothing failed, else `blocked`.
9. **Serve.** `GET /sites/<id>/` serves the finished website (static files on disk). The Home
   page's render screenshot (`preview.png`) becomes the board thumbnail.

---

## 3. Data model (Postgres is the source of truth)

Full DDL: [`db/schema.sql`](../db/schema.sql). It is **re-runnable** — it drops and recreates
everything, so applying it resets the engine. Schema applied via `db.ts → applySchema()`.

```
projects 1───∞ tasks 1───∞ task_outputs
                 │  ▲
                 │  │ (upstream_id / downstream_id)
                 └──┴── task_dependencies   (the DAG edges)
run_events  ∞───  (append-only audit log, references projects/tasks loosely)
```

### `projects`
| column       | type        | meaning |
|--------------|-------------|---------|
| `id`         | uuid PK     | project id; also the `/sites/<id>/` directory name |
| `brief`      | text        | the raw brief the user submitted |
| `params`     | jsonb       | planner metadata; **stores the page set** as `params.pages = [{slug,title}]` and `params.planner = 'llm'|'template'` |
| `status`     | text        | `running` → `done` or `blocked` (set by `runLoop` at the end) |
| `created_at` | timestamptz | used for wall-clock KPIs |

### `tasks`
The unit of work. One LLM call per task.
| column             | type          | meaning |
|--------------------|---------------|---------|
| `id`               | uuid PK       | |
| `project_id`       | uuid FK       | cascade-deletes with the project |
| `seq`              | int           | 1-based order within the project; used for stable ordering and display |
| `title`            | text          | human-readable step title |
| `department`       | text          | selects the agent role (`research`, `branding`, `content`, `build`, `qa`, …) |
| `status`           | enum          | `blocked → ready → running → verifying → done` (or `failed`) |
| `verify`           | text          | the **deterministic rule** that must pass for `→ done` (§5) |
| `artifact`         | text NULL     | if set (e.g. `about.html`), the output is written to `sites/<project_id>/<artifact>` |
| `attempts`         | int           | incremented on each claim; drives retry/feedback |
| `max_attempts`     | int (def 3)   | after this many failed attempts → `failed` |
| `claimed_by`       | text NULL     | runner id holding the lease |
| `lease_expires_at` | timestamptz   | lease deadline; expiry → task reclaimed (§6) |
| `created_at` / `updated_at` | timestamptz | `updated_at` drives KPI wall-clock |

`task_status` enum: `blocked, ready, running, verifying, done, failed`.

### `task_dependencies`
The DAG. `PRIMARY KEY (upstream_id, downstream_id)`. A downstream task cannot become `ready`
until **every** upstream is `done`. This is the only place the graph lives.

### `task_outputs`
Append-only history of every agent attempt for a task.
- `content` — the agent's raw output. **Trusted only after `verify` passes** (the column
  comment says so explicitly).
- `is_current` — exactly one row per task is current, enforced by a **partial unique index**:
  `create unique index task_outputs_current_ux on task_outputs(task_id) where is_current`.
  `processTask` demotes the old current row (`is_current=false`) before inserting the new one,
  so retries keep full history while readers (board/context) always see the latest.

### `run_events`
Append-only audit log (`bigserial` id). Event `type`s emitted by the engine:
`planned`, `task_unblocked`, `task_done`, `verify_failed`, `agent_error`. `detail` carries the
human/AI-readable reason. The **retry-with-feedback** mechanism reads the most recent
`verify_failed`/`agent_error` for a task and feeds it back to the agent on the next attempt.

### The unblock trigger — graph logic lives in SQL, not the scheduler

```sql
-- fn_unblock(), fired AFTER UPDATE ON tasks
-- when a task transitions INTO 'done':
--   promote each downstream task from blocked → ready
--   IFF all of that downstream's upstreams are now 'done'
--   and log a 'task_unblocked' run_event for each.
```

This is the heart of the DAG execution. The instant any task hits `done`, the database itself
unblocks whatever is now runnable. **The scheduler contains no dependency-resolution code** —
it just claims `ready` tasks. This keeps correctness in one declarative place and makes the
engine trivially restart-safe.

### `v_ready_tasks` — the readiness definition + safety net

```sql
-- a task is READY when it is 'blocked' and has zero upstreams that aren't 'done'
create view v_ready_tasks as
select t.* from tasks t
where t.status='blocked'
  and not exists (select 1 from task_dependencies d
                  join tasks u on u.id=d.upstream_id
                  where d.downstream_id=t.id and u.status<>'done');
```

This view is the **canonical definition of readiness**. The trigger is the fast path; the view
is the belt-and-suspenders. On every loop iteration the runner calls `reconcile()`:
`update tasks set status='ready' ... where id in (select id from v_ready_tasks)`. So even if the
trigger ever missed an event (or a task was inserted/edited out of band), the scheduler will
still promote anything that *should* be ready. The view is **load-bearing**, not decorative.

---

## 4. The planner and its `validate()` guarantees

`planner.ts` turns a brief into the DAG. Provider: MiniMax via `agents.ts → llm()`.

**System prompt contract** (`PLANNER_SYS`): output ONLY JSON
`{"pages":[{slug,title}…],"tasks":[{seq,title,department,depends_on}…]}` — 2–5 pages tailored to
the brief (first MUST be Home/`index`), and 4–7 **thinking** steps only (research, strategy,
branding, content/IA, copy, media, design) in dependency order. The LLM is explicitly told NOT
to emit build or QA tasks — those are added deterministically.

`validate(plan)` does not trust the LLM; it **forces** the engine's structural invariants. These
are the guarantees you can rely on regardless of what the model returned:

- **Pages normalized** (`normPages`): slugs lowercased/url-safe/deduped/≤24 chars, ≤5 pages,
  the first page is always `{slug:'index', title:'Home'}`. Empty → a single Home page.
- **Thinking tasks only:** any task whose department is `build` or `qa` is dropped (the LLM
  isn't allowed to define those). If fewer than 2 thinking tasks survive, `validate` returns
  `null` and the planner falls back to a template plan.
- **Seqs renumbered 1..N and dependencies remapped** to the new seqs, with forward-only edges
  enforced (`d < ns`) — guarantees a **valid acyclic** topological order.
- **Exactly one canonical `branding` task → `verify='wcag'`.** It picks the task that looks like
  branding (`/brand/`), else design/visual/style/colour, else the first non-research/strategy
  task, and renames its department to `branding`. This guarantees there is always one
  WCAG-gated brand-token source the build consumes.
- **Verify rules assigned by department:** `branding → wcag`; copy/content/writing → `json`;
  everything else → `min:280` (a length floor). Thinking tasks never ship a file.
- **One render-verified BUILD task per page** (`verify='site_renders'`, `artifact='<slug>.html'`),
  each **fanning in from every thinking task** (so a page is built only after research, brand,
  and copy all exist). Plus **one QA task** (`verify='site_renders'`, depends on the Home build,
  no artifact — it re-renders `index.html`).
- **Fallback path:** if the LLM is unavailable or returns garbage, `plan()` uses
  `FB_THINKING` (4 thinking steps) + `FB_PAGES` (Home/About/Contact) through the same
  build-and-QA machinery. `params.planner` records `'llm'` vs `'template'`.

Net result: **for any brief, the DAG always ends with one render-gated build per page and a QA
render check, and always contains exactly one WCAG-gated brand task.** Those guarantees are
what make the output reliably a real, multi-page, accessible website rather than whatever the
model felt like producing.

After `validate`, `plan()` inserts the project (pages stored in `params`), all tasks, all
dependency edges, then flips root tasks `blocked → ready`, and logs a `planned` event.

---

## 5. The verify model (zero-trust, ungameable)

`verify.ts` is the gate. Each task carries a `verify` rule string; `verify()` runs the matching
deterministic check and returns `{ok, log}`. The agent **cannot** mark its own work done — only
this code can. Rules, weakest to strongest:

| rule | what it checks | why it's hard/impossible to fake |
|------|----------------|----------------------------------|
| `nonempty` | output trimmed length > 0 | trivial floor only |
| `min:N` | output ≥ N chars | length floor (used for research/strategy) |
| `contains:<s>` | output contains substring (case-insensitive) | literal presence |
| `json` | output's **first brace-balanced** block parses as JSON | must be machine-valid structure, not prose |
| `json:k1,k2` | valid JSON **and** has all named keys | required structured shape the build consumes |
| `wcag` | brand tokens declare `palette.text` and `palette.bg` as hex, and **that exact pair** meets WCAG AA contrast ≥ 4.5:1 | computed from the real hex values; no "best pair anywhere" fallback (that was gameable) — the agent must actually choose an accessible palette |
| `sql_applies` | output's SQL runs inside a real `BEGIN … ROLLBACK` transaction | Postgres itself must accept the DDL; syntax/typos fail |
| `site_renders` | the produced HTML file actually renders (see below) | a real headless Chromium screenshot must exist and be non-blank |

**`firstJson` / the JSON parser** parses the *first* brace-balanced object/array, so an agent
that emits two concatenated JSON blocks (a common failure) still gets validated against the
first complete one rather than silently passing on malformed concatenation.

**`site_renders` — the strongest gate.** For a build/QA task it:
1. Confirms the artifact file exists and is ≥ 400 bytes.
2. Confirms it *looks* like HTML: `<html|<!doctype>` near the top **and** a `<body|<div|<section>`.
3. **Quality gate (rejects external/placeholder assets):** fails if the HTML references any
   external/unbundled asset — `src=https?:`, `url(https?:)`, a stylesheet `<link href=https?:>`,
   a bare `app.css`, or `via.placeholder`. A shippable site must be fully self-contained, so
   every CSS/font must be inlined. It also fails on **unfilled copy placeholders** like
   `[Company Name]` (regex `\[[A-Z][a-z]+…\]`).
4. **Real render:** runs `chromium-browser --headless=new --screenshot=…` at 1280×860 with a 7s
   virtual-time budget, then requires the screenshot file to exist and be **> 3000 bytes**
   (a blank/white page compresses to far less). The Home page's shot is `preview.png` (the board
   thumbnail); other pages get a throwaway `_<file>.png`.

This is what "zero-trust, ungameable" means concretely: to pass, the agent's output must be
*actually valid* — parseable JSON, contrast that a formula computes as accessible, SQL Postgres
accepts, HTML a real browser renders into pixels. There is no path where claiming success makes
it so.

**KPI honesty.** `kpi.ts → computeKpi` counts **verification rigor** using only the genuinely
deterministic rules (`sql_applies`, `site_renders`, `wcag`, `json*`) — `nonempty`/`min`/`contains`
do not count as "real checks." And a project where nothing can advance but work remains
(`active===0 && blocked>0`) is reported as **`blocked`**, never a dishonest `running`.

---

## 6. Restart-safe claim / lease design

The scheduler (`runner.ts → runLoop`) is **stateless**: it keeps no in-memory graph or task
list. Everything is recomputed from Postgres each iteration, so a crash/restart loses nothing.

Each loop iteration does four things, in order:

```
runLoop:
  reclaim()    -- resurrect tasks whose lease expired (crash recovery)
  reconcile()  -- promote anything in v_ready_tasks (trigger safety net)
  claim()      -- atomically grab up to `cap` ready tasks
  processTask  -- run each claimed task concurrently (Promise.all)
```

- **Atomic claim (no double-execution):**
  ```sql
  update tasks set status='running', claimed_by=$1,
      lease_expires_at=now()+interval '240 seconds', attempts=attempts+1, updated_at=now()
  where id in (select id from tasks where status='ready'
               order by seq FOR UPDATE SKIP LOCKED limit $2)
  returning *;
  ```
  `FOR UPDATE SKIP LOCKED` means concurrent runners never grab the same row — each skips rows
  another runner has locked. Multiple runners/processes can safely share one project's queue.

- **Lease + reclaim (crash recovery):** every claimed task gets a 240-second lease.
  `reclaim()` resets any task stuck in `running` **or** `verifying` past its lease back to
  `ready` (clearing `claimed_by`/lease). `verifying` is included on purpose — the slow Chromium
  render lives there, and a runner that dies mid-render must not leave a task wedged. So if a
  runner dies, its in-flight work is automatically re-offered after the lease expires.

- **Boot resume:** on startup `server.ts` queries for any project with tasks still in
  `ready/running/verifying/blocked` and calls `runLoop` for each. Combined with the stateless
  loop, **the engine survives process death and reboot** and finishes interrupted projects with
  no manual intervention.

- **Resumability is testable:** `runLoop`'s `maxSteps` option deliberately stops mid-run to
  *simulate a crash*; re-invoking `runLoop` on the same project picks up cleanly, proving the
  property rather than asserting it.

- **Failure handling never crashes the loop:** an agent/API error (e.g. provider down) is caught
  in `processTask`, logged as `agent_error`, and the task is set back to `ready` (retry) or
  `failed` once attempts are exhausted. One bad task can't take down the run.

- **Retry with feedback:** when `attempts > 1`, `buildContext` pulls the latest
  `verify_failed`/`agent_error` detail and prepends it to the agent prompt
  ("your previous attempt FAILED an automated check: …"), so retries are informed, not blind.

Loop termination: when a claim returns nothing, the runner checks counts; if `running===0 &&
ready===0` it stops (complete, or deadlocked with `blocked>0`), otherwise it sleeps 25ms and
re-checks. At the end it sets `projects.status` to `done` (nothing unfinished, nothing failed)
or `blocked`.

---

## 7. The agents (one API call each)

`agents.ts`: an agent is *just an API call* — context in, text out. The live provider is
**MiniMax** (OpenAI-compatible `/chat/completions`, base `https://api.minimax.io/v1`, model
`MiniMax-Text-01` by default; configurable via `MINIMAX_*` env). If `MINIMAX_API_KEY` is unset,
deterministic **stubs** keep the whole engine runnable end-to-end offline.

- The only thing that differs between departments is a **one-line role** (`ROLE[department]`).
  `branding` must emit a JSON token object with WCAG-passing `text`/`bg`; `content`/`copywriting`
  must emit a single JSON object; `database` emits runnable Postgres DDL; etc.
- The **`build` role is a full Tailwind design contract**: output one complete self-contained
  HTML document for *this* page, with a shared sticky nav linking all pages, styled with
  **Tailwind utility classes only** (no `<style>` block — the excellence layer compiles the CSS),
  brand palette applied as Tailwind arbitrary values (`bg-[#0B6E4F]`), a high-2024-bar layout
  (glass nav, large display headings, gradient accents, generous rhythm, real footer), and
  **no external `<img>`** (visuals via CSS gradients/inline SVG).
- `buildContext` (`runner.ts`) assembles the `Ctx`: the brief, each upstream task's current
  output, optional retry feedback, the page set (from `params.pages`), and — for a build task —
  `self = {title, slug}` so the agent knows which page it's producing.

---

## 8. The excellence layer (real design system, self-contained output)

Only **build** tasks (those with an artifact) go through it. `processTask` first sanitizes the
raw HTML, then calls `applyExcellence(body)` (`excellence.ts`), then writes the file.

**Sanitizer (deterministic safety net, in `runner.ts`)** — a website must never ship broken
external/placeholder images, so before excellence runs it:
- strips Markdown code fences and slices to the first `<!doctype/<html`,
- removes `<img src=http(s)…>` and any `<img …placeholder…>`,
- replaces `url(http(s)…)` and `url(…placeholder…)` with a tasteful local gradient.

This means even if the agent ignores instructions, the artifact handed to the verify gate is
already free of the asset references `site_renders` would reject.

**`applyExcellence(html)`** turns the page into one modern, self-contained file:
1. Writes the page to a temp dir and compiles **Tailwind v4** with the **vendored standalone
   binary** at `tools/tailwindcss` (GITIGNORED, ~120MB).
2. Critically scopes the compile: the input CSS is
   `@import "tailwindcss" source(none);  @source "<abs path to this page>";`. `source(none)`
   disables Tailwind's broad auto-scan (which would crawl the whole tree, ~1 min); `@source`
   limits scanning to **just this page**, so the compile is ~150ms and emits only the utilities
   the page actually uses.
3. Appends a base layer: **real base64 WOFF2 fonts** from `src/fonts.ts` (`FONT_FACES`),
   smooth scroll, antialiasing, and display/serif-display heading families.
4. Strips the license comment (it contains a URL that would trip the quality gate), drops any
   stylesheet `<link>`/`app.css` the agent added, and **inlines the compiled `<style>` before
   `</head>`** (falling back to before `<body>`/prepend).

It **never throws** — on any failure it returns the input unchanged, so the excellence step can
never break a build. The output is a single HTML file with no external dependencies, which is
exactly what `site_renders` demands.

---

## 9. Serving the result (`server.ts`)

A bare Node `http` server (no framework) on `0.0.0.0:${PORT||8787}`. It serves:

- **The Relay web app** (`web/index.html`, `app.js`, `styles.css`) — submit a brief, watch the
  build live, browse projects, view the roadmap. `index.html` is served with **mtime
  cache-busting**: `app.js`/`styles.css` are stamped `?v=<max mtime>` so any change invalidates
  the cache; the app shell itself is `no-cache`.
- **The produced websites** at `GET /sites/<projectId>/[file]` from disk. Directory or
  extensionless paths resolve to `index.html`; `..` traversal is stripped. Files are served with
  the right MIME type and `cache-control: public, max-age=3600`.
- **JSON API:**
  - `GET /api/board[?id=]` — project + tasks + DAG edges + whether a site exists.
  - `GET /api/projects` — recent projects with rollups (done/failed/active, first-pass,
    real-check count, wall-clock).
  - `GET /api/kpi[?id=]` — the KPIs from `kpi.ts`.
  - `GET /api/output?id=&seq=` — a single task's current output.
  - `POST /api/run {"brief":…}` — plan + fire-and-forget run; returns `{id}`.
  - `GET /healthz` → `ok`. `GET /roadmap` → 302 to in-app `/#/roadmap`.
- **Boot-resume** of unfinished projects (see §6).

---

## 10. Configuration & where things live

| concern | source of truth |
|---------|-----------------|
| Postgres connection | `DATABASE_URL` env, default `postgresql://postgres:postgres@127.0.0.1:5439/agency` (`src/db.ts`) |
| LLM provider | `MINIMAX_API_KEY` / `MINIMAX_BASE_URL` / `MINIMAX_MODEL` (`src/agents.ts`); unset key → offline stubs |
| HTTP port | `PORT` env, default `8787` (`src/server.ts`) |
| Schema / DDL | `db/schema.sql` (re-runnable; applied via `db.ts → applySchema`) |
| Produced sites | `sites/<projectId>/` on disk (GITIGNORED) |
| Tailwind binary | `tools/tailwindcss` (vendored, GITIGNORED, ~120MB) |
| Inline fonts | `src/fonts.ts` (base64 WOFF2 `FONT_FACES`) |
| Web app | `web/` (`index.html`, `app.js` hash-router, `styles.css`) |

Run targets (`package.json`): `npm run serve` (the live app), `npm run run -- "<brief>"`
(plan+run a brief to completion in the terminal; `RESET=0` to skip re-applying the schema),
`npm run kpi -- [projectId]` (terminal KPI report), `npm run demo`.

---

## 11. Operational notes (deployment durability)

The application engine documented above is **restart-safe by design** (§6): stateless scheduler,
DB-as-truth, lease/reclaim, and boot-resume mean it correctly survives process death and reboot
*once it is running again*. What it does **not** do by itself is **restart the OS process** — the
HTTP server is currently launched as a bare `npm exec tsx src/server.ts` with no supervision, so
a crash or reboot leaves it down until something starts it. Making the process itself durable
(supervision) and choosing a durable public ingress are deliberately **out of scope for this
file** — see [`docs/RELAY-STACK-DECISION.md`](./RELAY-STACK-DECISION.md) for the
infrastructure/durability plan (process supervision, proxy, and reboot survival), and treat that
document as the companion to this one.

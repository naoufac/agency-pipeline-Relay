# Relay

Relay is an autonomous **agency pipeline**: you hand it a one-line brief, an LLM planner explodes it into a dependency DAG of tasks, AI "department agents" (research → branding → content → build → QA) run them stage-by-stage — parallel where independent, sequential where one feeds the next — every output passes a **deterministic verify gate** before it counts as done, and the result is a real, shippable, multi-page website served live at `/sites/<id>/`. The website *is* the product: submit a brief on the board and watch the agency build it in front of you.

## Locked principles (non-negotiable)

These are the invariants. Change anything else, but not these.

1. **Autonomous — brief in, result out.** No human in the loop. The operator's only touchpoints are the brief and the finished site.
2. **An agent is just one API call.** Context in (brief + the upstream outputs it depends on) → text/artifact out. No hidden internal structure, no multi-step agent frameworks. One department = one prompt = one call.
3. **Zero-trust, deterministic verify.** A task is `done` only when an automated check passes — the SQL applies, the JSON parses, the contrast hits WCAG AA, the page actually renders in headless Chromium. Never an agent's word, never a human gate.
4. **Real artifacts, verified against the file on disk.** Agents return text or JSON; the runner turns it into a real file and runs the check against that file. For a build, the agent returns a JSON **spec** (structure + copy + brand tokens) and a deterministic renderer composes the actual HTML page on disk — the render gate then runs against that file, never against the spec.
5. **Generic.** Nothing is hardcoded to one brand or vertical. The same pipeline ships a restaurant, a SaaS, or a portfolio — the planner adapts the page set and tasks to the brief.
6. **The dashboard never lies.** State lives in Postgres and is reported honestly: a deadlocked project shows `blocked`, not "running"; only genuinely deterministic checks count toward "verification rigor". The runner is a thin, disposable, restart-safe loop over the database.

## 60-second quickstart

**Prerequisites:** Node 22+, Docker (for Postgres), `chromium-browser` on `PATH` (the render gate uses it).

```bash
# 1. clone + install
git clone <this-repo> agency-pipeline && cd agency-pipeline
npm install

# 2. configure env (copy the template, then fill in the MiniMax key)
cp .env.example .env
#   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5439/agency
#   MINIMAX_API_KEY=<your key>          # leave blank to run with offline deterministic stubs
#   MINIMAX_BASE_URL=https://api.minimax.io/v1
#   MINIMAX_MODEL=MiniMax-Text-01

# 3. start Postgres (the board / single source of truth)
docker run -d --name ap-pg --restart unless-stopped \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=agency -p 5439:5432 postgres:16

# 4. load the schema (DDL + unblock trigger + v_ready_tasks view)
docker exec -i ap-pg psql -U postgres -d agency < db/schema.sql

# 5. start Relay (web app + JSON API + the runner, on 0.0.0.0:8787)
set -a && . ./.env && set +a        # load env into the shell
npm exec tsx src/server.ts
```

Then open the board:

- **Live:** https://board.naples.agency
- **Local:** http://localhost:8787

Type a brief (e.g. *"a specialty coffee roaster in Lisbon"*), submit, and the board fills in: the task DAG runs stage-by-stage, KPIs update live, and a real multi-page site appears under **Your sites** → its workspace → the live `/sites/<id>/` iframe.

> **No MiniMax key?** Leave `MINIMAX_API_KEY` blank — the agents fall back to deterministic stubs so the whole engine (plan → run → verify → restart-safe resume) still works offline. Set the key for real, on-brief output.

## How it runs

```
brief
  │  plan() — one LLM call
  ▼
planner ──► board (Postgres) ──► runLoop: claim ready → run agent → write artifact → verify → unblock → repeat ──► done
            tasks · deps · outputs        (FOR UPDATE SKIP LOCKED, lease + reclaim = restart-safe)
```

A task is **ready** when all its upstream dependencies are `done`. Finishing a task fires the SQL `trg_unblock` trigger, which promotes any successor whose upstreams are now all done. The scheduler holds no graph logic — readiness is recomputed from the rows, so you can kill the server mid-run and the boot-resume picks up exactly where it left off.

**The model decides, the system builds.** The build agent never writes HTML or CSS — it only *decides* structure, copy, and two brand colours, emitting a small JSON spec. A deterministic renderer (`src/render.ts`) then *builds* the page from hand-built, vetted components (`src/components.ts`): nav, spacing, fonts, and WCAG-safe contrast are correct by construction and can't drift. One engine serves a stack of layers — a multi-page **website**, an **editable CMS**, a **full-stack form-to-database** backend, and **visual QA** — and the brief decides which apply, with no discrimination between them.

## Repo layout

```
README.md            you are here — what it is + quickstart
MISSION.md           the north-star statement of the locked principles
ROADMAP.md           history + forward plan (also live in-app at /#/roadmap)

db/schema.sql        the engine: projects, tasks, task_dependencies, task_outputs,
                     run_events + the unblock trigger + the v_ready_tasks view

src/
  server.ts          HTTP server: serves web/, the JSON API (/api/board|projects|kpi|output|run),
                     the produced sites (/sites/<id>/*), boot-resumes unfinished projects, cache-busts assets
  planner.ts         LLM planner: brief → {pages, tasks}; forces one render-verified build task per page
                     and one canonical WCAG-checked branding task; falls back to a template if the LLM is down
  runner.ts          runLoop: claim (SKIP LOCKED) + lease/reclaim, run the agent, render the spec via
                     components, fill in real Pexels media, freeze the editable snapshot, verify, retry-with-feedback
  agents.ts          the agent contract: a department role prompt + context → one MiniMax call → text/JSON (build ⇒ a page spec)
  render.ts          the deterministic renderer: a JSON spec → perfect HTML, with the WCAG-safe palette derived from bg + primary
  components.ts      the design system: token-driven CSS, the section components (hero/features/split/gallery/cta/form),
                     and a CSS-only responsive hamburger nav that's correct by construction
  media.ts           processMedia: swaps the build's image search-terms for real, locally-served Pexels photos
  cms.ts             the editable CMS: freeze each rendered page's snapshot + blocks; edits are pure string overlays
                     (no LLM); republish runs the IDENTICAL render gate against a .tmp, atomic-renames on pass
  qa.ts / vision.ts  visual QA: screenshot each page (mobile + desktop), a vision model scores it, upsert qa_reviews
  verify.ts          the zero-trust gates: nonempty · contains · min:N · json[:keys] · wcag · sql_applies · site_renders
  fonts.ts           the base64 @font-face blocks inlined by the design system (components.ts)
  kpi.ts             computeKpi: honest KPIs (real checks only; deadlock ⇒ 'blocked', never 'running')
  db.ts              pg Pool + small DB helpers
  demo.ts / run.ts / kpi-cli.ts   CLI entry points (demo proves crash + restart resumability)

web/                 the dashboard: index.html (nav), app.js (hash router #/ , #/p/:id, #/roadmap), styles.css
tools/               the offline SVG diagram renderers (render-dag.mjs, render-mindmap.mjs)
assets/              the WOFF2 source fonts
sites/               the produced websites (gitignored) — one dir per project id
docs/                the deep docs (architecture, spec, infra decisions, diagrams)
```

## Where to go next

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit: the data model, the scheduler loop, the agent contract, every verify rule, and the deterministic render engine, with a worked example.
- **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — running it for real: the Postgres container, starting/supervising the server, the proxy/tunnel that fronts `board.naples.agency`, surviving reboots, and what *not* to touch on the host.
- **[AGENTS.md](AGENTS.md)** — the guide for an AI agent working *on* this repo: the invariants, the verify-or-it-isn't-done rule, and where each concern lives.
- **[MISSION.md](MISSION.md)** / **[ROADMAP.md](ROADMAP.md)** — the principles and the plan. `docs/SPEC.md` is the original full spec; `docs/*.svg` are the architecture diagrams.

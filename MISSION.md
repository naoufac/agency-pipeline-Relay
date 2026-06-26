# Mission

Build an **autonomous agency pipeline**: a chain of AI calls, one after another, that makes sense the way a real agency does.

## What it is

A brief comes in. A **planner** explodes it into tasks with dependencies. The tasks fire **stage-by-stage** — parallel where independent, sequential where one feeds the next — mimicking how an agency hands a project between departments (research → branding → build → integrate → QA). Output of one task is the input of the next.

## Locked principles (non-negotiable)

1. **Autonomous.** Brief in → result out. No human in the loop. The operator's only touchpoints are the brief and an end-of-run report.
2. **A working agent is just one API call.** Text in (brief + the upstream outputs it depends on) → text/artifact out. No internal structure, no schemas.
3. **Zero trust in AI self-reporting.** A task is `done` only when a **deterministic automated check passes** (build exits 0, tests pass, schema applies, URL 200). Never the agent's word, never a human gate.
4. **Real artifacts, not specs.** The agent returns code as text; the runner writes the file and runs the check.
5. **The board is a database.** Tasks, dependencies, outputs and status live in **Supabase (Postgres)** — the source of truth, restart-safe by construction. The scheduler is a thin, disposable loop.
6. **Generic.** Not tied to any specific project.

## How it runs

`planner (1 call) → board (DB) → scheduler loop (find ready → run → store → verify → unblock → repeat) → done`

A task becomes **ready** when all its upstream dependencies are `done`. Completing a task unblocks its successors. Kill the runner at any point and restart — readiness is recomputed from the rows.

## Status

- [x] Plan locked — see [`docs/SPEC.md`](docs/SPEC.md)
- [x] MVP engine: DDL + unblock trigger + `v_ready_tasks` + runner loop + planner + zero-trust verifier
- [x] First end-to-end run, kill+restart to prove resumability — **11/11 tasks verified done, trigger unblocked 10×, resumed cleanly after a simulated crash** (`npm run demo`)
- [ ] Swap stub agents for live Claude API calls (set `ANTHROPIC_API_KEY`)
- [ ] LLM planner (brief → graph) replacing the deterministic template
- [ ] Point at real Supabase instead of local Postgres

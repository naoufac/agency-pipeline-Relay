# agency-pipeline

An autonomous **agency pipeline**: a brief comes in, a planner explodes it into a dependency graph of tasks, and a chain of AI calls fires stage-by-stage — parallel where independent, sequential where one feeds the next — like a real agency moving work between departments. Fully autonomous, zero-trust verification, real artifacts.

➡️ **[MISSION.md](MISSION.md)** — what we're building and the locked principles.

## Docs

- **[docs/SPEC.md](docs/SPEC.md)** — the full architecture spec (data model, scheduler, agent contract, verification, worked example).
- **[docs/board-supabase-vs-clickup.md](docs/board-supabase-vs-clickup.md)** — why Supabase is the engine.
- **Visuals** (`docs/*.svg` / `*.png`): `mm-concept` (the idea), `mm-tech` (how it runs), `mm-architecture` (system), `dag-delivery` (dependency layers, worked example).

## How it runs

```
planner (1 call) ─► board (Supabase) ─► scheduler loop ─► done
                                         find ready → run agent → store → verify → unblock → repeat
```

A task is **ready** when all upstream dependencies are `done`; finishing a task unblocks its successors. Completion = an automated check passing, never an agent's claim. State lives in Postgres, so the runner is disposable and restart-safe.

## Layout

```
MISSION.md            north star
docs/SPEC.md          the plan
docs/                 visuals + board comparison
tools/                offline SVG renderers for the diagrams
```

## Status

Plan locked. Building the MVP engine next (DDL + unblock trigger + runner loop + planner).

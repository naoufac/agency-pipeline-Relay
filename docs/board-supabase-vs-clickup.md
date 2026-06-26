# The board: Supabase vs ClickUp

The "board" is where tasks, dependencies, outputs and status live, and what the scheduler queries every tick to find ready tasks. So the real question is: which is a better **engine** for a dependency graph that a program drives.

| Dimension | Supabase (Postgres) | ClickUp |
|---|---|---|
| What it is | A database — a real engine | A PM/SaaS tool with an API |
| Dependency graph + "unblock" logic | Native: edges table + a SQL trigger/view computes "ready" instantly | Has task dependencies, but no programmable readiness compute; you reimplement it client-side |
| Query "which tasks are ready now" | One indexed SQL query, sub-ms | Multiple REST calls + client filtering |
| Store agent outputs / artifacts | Columns + Storage, unlimited, structured | Task fields/attachments; awkward and size-limited |
| Triggers / automation | Postgres triggers fire the moment a task is done | Automations are UI-oriented, not a tight control loop |
| Speed / rate limits | Direct DB, no rate limit you'll hit | REST API rate-limited (~100 req/min) — a scheduler loop will choke |
| Restart-safe / source of truth | Yes — state is rows; kill & resume exactly | State split between your code and their cloud |
| Cost at scale | Cheap, predictable | Per-seat SaaS pricing |
| Human board view (nice-to-have) | Build a small view, or none | **This is where ClickUp wins** — polished UI out of the box |

**Verdict.** Use **Supabase as the engine** — it's the only one of the two actually built to drive a dependency graph fast, programmatically, and restart-safe. ClickUp is a human project-management UI, not a control loop; its rate limits and lack of programmable readiness make it the wrong core.

**If a human view is wanted later:** keep Supabase as the source of truth and optionally *mirror* tasks into ClickUp one-way for visibility. Never make ClickUp the source of truth.

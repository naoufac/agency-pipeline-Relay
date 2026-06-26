# > **C. Zero trust in AI self-reporting.** An agent saying "done" is meaningless. A task reaches `done` ONLY when a **deterministic external check passes** (build exits 0, schema applies, tests pass, URL 200). The unblock trigger fires on **`verified`**, not on the agent producing output. Taste work (branding/copy) is checked by **automated** proxies (valid tokens, WCAG AA contrast, downstream build applies) + an **independent** critic call — never by a human; the old QA *agent verdict* is deleted in favour of a real test/build/deploy harness. New task statuses: `produced → verifying → verified | rejected`. See the rewritten **§6.4**.
>
> **D. Fully autonomous — no human in the loop.** The system runs brief → done on its own. There is **no `needs_review`/approval gate**, and the operator is never asked mid-run; any "human sign-off" language in earlier sections is **superseded**. Completion and quality are decided by **automated** checks only. The operator touches the system exactly twice — the **brief in** and an **end-of-run notification** — both outside the loop. Locked decisions in **§12**.
>
Automated Agency Pipeline — Authoritative Architecture Specification

*Version 1.0 — Lead Architect's build specification. Database-driven state machine for routing a creative brief across specialized departments, in human-like order, in parallel where independent and sequential where dependent, fully resumable.*

---

> ## ⚠️ v1.1 Amendments (read first — supersede the original text where they conflict)
>
> **A. Working agents are just API calls.** A department agent has **no internal structure** — one LLM call: text in, text out, stored verbatim. The JSON-Schema / `output_schema` / `payload_keys` / output-validation machinery described in §2 and the old §6 is **deferred hardening, not v1**. `task_outputs` is just a **`content text`** column. See the rewritten **§6**.
>
> **B. Dependency layers are the point.** Tasks are arranged in **layers (waves)**: every task in a layer is independent and runs in parallel; a task becomes `ready` only when **all** its upstream arrows are `done`. Finishing a task **unblocks** its successors (e.g. #4 unblocks #8/#9/#11). See the layered DAG diagram (`dag-delivery.svg/png`) and the wave table in §10.3.

## 0. Vision, Glossary, and Mental Model

### 0.1 One-paragraph vision

A free-text **brief** ("build a WordPress website for Nike," "build a delivery app for Lebanon") arrives. A **Planner agent** decomposes it into a **DAG** of discrete **tasks with dependencies**, written as rows into a Supabase (Postgres) **task board**. A thin, stateless **scheduler loop** asks the database which tasks are *ready*, claims them safely, and dispatches each to a **specialized department agent** (branding, research, database design, frontend, auth, integration, QA…). Agents run **in parallel where independent and sequentially where one feeds the next**. Departments execute in the order a real agency would: research informs branding; branding's output (palette, typography, logo direction, layout format) becomes **input context** for every downstream build task. Completing a task **unblocks** its successors — the work "routes between departments" the way a job moves desk-to-desk in a real shop. Because **all state lives in Postgres** (never in the runner's memory), the entire pipeline is **restart-safe and resumable**: kill the orchestrator at any instant, restart it, and it recomputes the exact same frontier and continues.

### 0.2 Glossary — the user's words → system concepts

| User's word | System concept | Where it lives |
|---|---|---|
| **"The brief"** | `projects.brief` (raw free text) + `projects.params` (clarified facts) | `projects` table |
| **"The table" / "the board"** (ClickUp-style) | `tasks` rows + the `v_board` view | `tasks` + views |
| **"A task"** | One row in `tasks` — a node in the DAG owned by one department | `tasks` table |
| **"Departments" / "universes"** | The `department` enum; one specialized agent per department, defined in the `agents` registry | `agents` table, `department` enum |
| **"Routes work between universes"** | An **edge** in `task_dependencies` (upstream → downstream). Completing a task flips its successors from `blocked → ready` | `task_dependencies` + the unblock trigger |
| **"Unblocks #8/#9/#10"** | The **readiness rule**: a task is `ready` iff every upstream task is `done` | `fn_unblock_successors` trigger + `v_ready_tasks` view |
| **"Stage by stage"** | A **stage** = a topological layer; all tasks in a layer are mutually independent and may run in parallel | `tasks.stage` (display) + edge-driven gating (execution) |
| **"Passes the project across departments"** | Context propagation: a downstream agent receives the upstream outputs it depends on, plus the pinned **brand kit** | `task_outputs` + `projects.brand_kit` |
| **"Specialized agent"** | A department subagent with a fixed I/O contract (role prompt, input schema, output schema) | `agents` registry rows |
| **"Systematic, resumable"** | Stateless scheduler + all state in Postgres + leases + idempotency | scheduler loop §5, §8 |

### 0.3 The mental model (one sentence)

**Tasks are nodes, dependencies are edges, departments are universes, stages are topological layers, the database is the engine, and the scheduler is a disposable crank that turns it.**

---

## 1. Architecture Overview

```
   free-text brief                    ┌───────────────── HUMAN / API ─────────────────┐
   "delivery app for X"               │ gives the brief in  ·  gets an end-of-run report│
          │                           └───────▲───────────────────────────┬───────────┘
          ▼                                   │ (no mid-run involvement)   │ reads board
 ┌──────────────────────┐                     │                            │
 │  PLANNER AGENT        │                     │                            │
 │  clarify → decompose  │                     │                            │
 │  → validate → emit DAG│                     │                            │
 └─────────┬────────────┘                      │                            │
           │ one transactional write           │                            │
           ▼                                    │                            │
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │                          SUPABASE (Postgres)  ── THE ENGINE & SOURCE OF TRUTH          │
 │  projects · agents · tasks · task_dependencies · task_outputs · agent_runs · run_events│
 │  side_effects · budget_ledger                                                          │
 │  TRIGGERS (unblock, brand-kit sync) + VIEWS (v_ready_tasks, v_board, v_project_health) │
 └───────▲───────────────────────────────────────────────────────────────┬──────────────┘
         │ SELECT v_ready_tasks · claim (FOR UPDATE SKIP LOCKED)           │ write outputs,
         │ renew lease · reclaim stale · validate · persist               │ status, events
 ┌───────┴───────────────────────────────────────────────────────────────▼──────────────┐
 │  SCHEDULER / RUNNER LOOP   (stateless · idempotent · restart-safe)                     │
 │  reclaim → reconcile readiness → check budget → claim (caps) → dispatch → persist      │
 └───────┬────────────────────────────────────────────────────────────────────────────-─┘
         │ spawns subagents, concurrency-capped (global · per-project · per-department)
   ┌─────┼───────────────┬───────────────┬───────────────┬───────────────┬──────────────┐
   ▼     ▼               ▼               ▼               ▼               ▼              ▼
 RESEARCH  BRANDING   CMS/STACK   DATABASE     AUTH       FRONTEND   INTEGRATION   QA
 agent     agent      agent       agent        agent      agent      agent         agent
   └──────────── each reads upstream outputs from the board, writes its result back ──────┘
```

### 1.1 Component list & single responsibility

| Component | Responsibility | Stateful? |
|---|---|---|
| **Planner agent** | Free-text brief → clarifying questions → validated DAG of `tasks` + `task_dependencies`. Runs once per project (and per re-plan). Emits JSON; never writes SQL directly. | No — output lives in DB |
| **Validator** (harness, not LLM) | Cross-checks the planner's JSON: JSON-Schema shape, acyclicity, structural lints (branding-ancestor rule, dangling refs, context-reference vs edge). Rewrites local refs → UUIDs. Writes all rows in one transaction. | No |
| **Task board** | `tasks` + `task_dependencies` + `task_outputs`. The canonical, only durable project state. | **The state** |
| **The engine** | Postgres triggers (unblock, brand-kit sync) + views (`v_ready_tasks`, `v_board`, `v_project_health`). All graph mechanics are declarative SQL. | In DB |
| **Scheduler / runner loop** | Reclaim stale leases → reconcile readiness → enforce budget + concurrency caps → claim ready tasks (`SKIP LOCKED`) → dispatch agents → validate + persist results. Holds **no business logic and no truth**. | **None** (disposable) |
| **Agents registry** | `agents` table: per-department role prompt, concurrency cap, model + cost policy — **no output schema; agents are plain API calls**. Scheduler resolves `assignee_agent` from `department`. | In DB |
| **Department agents** | Specialized subagents differing by role prompt only — a **plain API call** (text in → text out). The runner writes the artifact and verifies it. | None; idempotent |
| **Context store** | `task_outputs.content` (plain text / artifact) + Supabase Storage (binaries) + `projects.brand_kit` (pinned global brand). | In DB / Storage |
| **Governance** | `budget_ledger` (cost ceiling), `side_effects` (idempotency for real-world actions), `run_events` (audit). **No `approvals`/human gates — completion is automated.** | In DB |

**The hard rule:** agents never talk to each other directly. The **board is the message bus**. Work physically moves desk-to-desk (like an agency), and because nothing important lives in the runner, the system is restart-safe by construction.

**The design principle:** the scheduler never *decides* what is ready — it *asks* (`SELECT * FROM v_ready_tasks`). Graph logic is SQL (views + triggers). This makes the system durable: kill the runner mid-flight, restart, and the identical ready-set is recomputed.

---

## 2. Supabase Data Model (DDL)

```sql
-- ============================================================
-- EXTENSIONS
-- ============================================================
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ============================================================
-- ENUMS
-- ============================================================
create type task_status as enum (
  'blocked',        -- has ≥1 unfinished upstream dependency
  'ready',          -- all upstreams done; eligible to dispatch
  'running',        -- claimed by a runner, agent in flight
  'done',           -- VERIFIED: an automated check passed (never the agent's word)
  'failed',         -- exhausted retries (or non-retryable error)
  'verifying',      -- output produced; automated check running (no human gate)
  'cancelled'       -- pruned by a re-plan or project cancellation
);

create type department as enum (
  'planning',
  'research',         -- market / country / competitor research
  'branding',         -- palette, typography, logo direction, layout format
  'cms_choice',       -- platform/stack decision (WordPress vs custom vs Shopify…)
  'database_design',  -- schema / entities
  'auth',             -- accounts, passwords, sessions
  'media',            -- images, asset sourcing/generation
  'content',          -- copy, microcopy
  'frontend',         -- screens / pages / design system
  'integration',      -- social, payments, maps, 3rd-party APIs, deploy
  'qa'                -- automated acceptance: build/test/deploy harness
);

create type project_status as enum (
  'intake',           -- brief received; planner assuming sensible defaults
  'planning',         -- planner building the DAG
  'running',
  'blocked',          -- nothing ready, nothing running (deadlock)
  'paused',           -- budget ceiling hit or operator pause
  'done',
  'failed',
  'cancelled'
);

create type event_type as enum (
  'project_created','assumptions_recorded',
  'planned','replanned','task_created','dep_added','dep_removed',
  'task_ready','task_claimed','task_started','lease_renewed','lease_reclaimed',
  'output_written','task_done','task_failed','task_retry','task_unblocked',
  'verify_started','verify_passed','verify_failed',
  'validation_failed','side_effect_committed','budget_warning','budget_exceeded',
  'subtree_cancelled','project_done','project_blocked'
);

-- ============================================================
-- PROJECTS
-- ============================================================
create table projects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  brief         text not null,                       -- raw free-text brief
  params        jsonb not null default '{}'::jsonb,  -- assumed/derived facts {country, positioning, ...}
  status        project_status not null default 'intake',
  brand_kit     jsonb,                               -- pinned branding payload (see §7)

  -- governance config — autonomous: planner always assumes sensible defaults and
  -- records them in params; the system never asks the operator and is never human-gated
  global_concurrency int not null default 6,         -- per-project cap
  budget_usd    numeric(10,4) not null default 25.0, -- hard spend ceiling
  config        jsonb not null default '{}'::jsonb,  -- model prefs, poll interval, etc.

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- AGENTS REGISTRY  (department contracts live in the DB)
-- ============================================================
create table agents (
  id             text primary key,                   -- 'branding-agent', 'db-agent', ...
  department     department not null,
  display_name   text not null,
  role_prompt    text not null,                      -- system prompt for the subagent
  -- no input/output schema, no payload_keys: agents are plain API calls (text in -> text out);
  -- the per-task automated check lives in tasks.verify (§6.4)
  max_parallel   int  not null default 4,            -- per-department concurrency cap
  model          text not null default 'claude-sonnet',
  lease_seconds  int  not null default 600,          -- per-department lease TTL (tuned, §8.1)
  cost_per_run_estimate numeric(8,4) not null default 0.10,
  enabled        boolean not null default true,
  unique (department)                                -- one enabled agent per department (v1)
);

-- ============================================================
-- TASKS  (the board — DAG nodes)
-- ============================================================
create table tasks (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  seq             int  not null,                     -- human-facing #1..#N within a project
  title           text not null,
  description     text not null,                     -- the instruction for the agent
  department      department not null,
  assignee_agent  text not null references agents(id),
  status          task_status not null default 'blocked',
  priority        int  not null default 100,         -- lower = sooner within a ready batch
  stage           int  not null default 0,           -- topological layer (DISPLAY/ordering only)

  -- execution bookkeeping (all in DB → restart-safe)
  attempts        int  not null default 0,
  max_attempts    int  not null default 3,
  claimed_by      text,                              -- runner instance id holding the lease
  claimed_at      timestamptz,
  lease_expires_at timestamptz,                       -- crash recovery; renewed by heartbeat (§8.1)
  started_at      timestamptz,
  finished_at     timestamptz,
  last_error      text,

  -- I/O
  input_spec      jsonb not null default '{}'::jsonb,-- static params the planner attached
  verify          text,                              -- automated check that must pass for status -> done (§6.4)
  has_side_effects boolean not null default false,   -- agent performs external mutations (§6.5)

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, seq)
);

create index tasks_ready_idx   on tasks (project_id, status, priority) where status = 'ready';
create index tasks_running_idx on tasks (status, lease_expires_at)     where status = 'running';
create index tasks_project_idx on tasks (project_id, status);

-- ============================================================
-- TASK DEPENDENCIES  (DAG edges — canonical, edge-table not array)
-- ============================================================
-- edge meaning: upstream_id must be 'done' before downstream_id may become 'ready'.
create table task_dependencies (
  project_id      uuid not null references projects(id) on delete cascade,
  upstream_id     uuid not null references tasks(id) on delete cascade,
  downstream_id   uuid not null references tasks(id) on delete cascade,
  -- data edge (downstream consumes upstream's output) vs pure ordering edge:
  consumes_output boolean not null default true,
  kind            text not null default 'finish_to_start',
  created_at      timestamptz not null default now(),
  primary key (upstream_id, downstream_id),
  check (upstream_id <> downstream_id)
);

create index deps_downstream_idx on task_dependencies (downstream_id);
create index deps_upstream_idx   on task_dependencies (upstream_id);

-- ============================================================
-- TASK OUTPUTS  (the context store — append-only, versioned)
-- ============================================================
create table task_outputs (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references tasks(id) on delete cascade,
  project_id    uuid not null references projects(id) on delete cascade,
  department    department not null,
  attempt       int  not null,                       -- which run produced this
  is_current    boolean not null default true,       -- false once superseded by a retry
  kind          text not null,                        -- 'brand_system'|'db_schema'|'screen_set'...
  content       text not null,                       -- raw agent output / artifact text (trusted only after verify)
  summary       text,                                 -- short digest for context packing
  artifact_urls jsonb not null default '[]'::jsonb,   -- Supabase Storage refs (logos, SQL, mocks)
  created_at    timestamptz not null default now()
);

-- exactly one live output per task (full history retained for audit/replay)
create unique index task_outputs_current_ux on task_outputs (task_id) where is_current;
create index task_outputs_proj_kind_idx on task_outputs (project_id, kind);

-- ============================================================
-- AGENT RUNS  (one row per dispatch attempt — idempotency anchor + cost)
-- ============================================================
create table agent_runs (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references tasks(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  attempt         int  not null,
  idempotency_key text not null,                      -- = task_id::attempt
  agent           text not null,
  status          text not null default 'running',    -- running|succeeded|failed
  request         jsonb not null,                      -- exact context packet sent to the agent
  response        jsonb,                               -- raw agent return
  input_tokens    int  not null default 0,
  output_tokens   int  not null default 0,
  cost_usd        numeric(10,6) not null default 0,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  unique (task_id, attempt)
);

-- ============================================================
-- SIDE EFFECTS  (idempotency ledger for real-world mutations — deploy/email/etc.)
-- ============================================================
create table side_effects (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references tasks(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  effect_key      text not null,                      -- e.g. 'task_<id>::attempt_1::deploy'
  kind            text not null,                      -- 'deploy'|'email'|'external_write'|...
  status          text not null default 'pending',    -- pending|committed|failed
  external_ref    text,                               -- provider id (deployment id, message id…)
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  committed_at    timestamptz,
  unique (effect_key)                                  -- enforces exactly-once per (task,attempt,effect)
);

-- ============================================================
-- (No APPROVALS table — the system is autonomous. Completion is decided by the
--  tasks.verify check, never by a human review gate. There is nothing to approve.)
-- ============================================================

-- ============================================================
-- BUDGET LEDGER  (per-project spend tracking + ceiling)
-- ============================================================
create table budget_ledger (
  id          bigserial primary key,
  project_id  uuid not null references projects(id) on delete cascade,
  task_id     uuid references tasks(id) on delete set null,
  cost_usd    numeric(10,6) not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index budget_ledger_proj_idx on budget_ledger (project_id);

-- ============================================================
-- RUN EVENTS  (observability + audit, append-only)
-- ============================================================
create table run_events (
  id          bigserial primary key,
  project_id  uuid references projects(id) on delete cascade,
  task_id     uuid references tasks(id) on delete cascade,
  type        event_type not null,
  actor       text,                                    -- 'scheduler'|'<agent>'|'human'|'db'
  runner_id   text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index run_events_project_idx on run_events (project_id, id desc);
```

**Why an explicit edge table (`task_dependencies`) and not `depends_on uuid[]`:** readiness becomes a pure indexable `NOT EXISTS` query; fan-in/fan-out are symmetric and indexable both directions; adding/removing one edge is a single race-free row op (critical for re-plan, §8.5); and `consumes_output` cleanly separates **data edges** (inject the payload) from **ordering edges** (gate timing only) for tight token discipline.

---

## 3. Task Lifecycle, Dependency Model & the Unblock Rule

### 3.1 Status lifecycle

```
                    ┌──────────────── retry (attempts < max) ───────────────┐
                    ▼                                                        │
  blocked ──► ready ──► running ──► done ──────────────────────────────► (unblocks successors)
     ▲          ▲          │   │
     │          │          │   ├─► verifying ─(check passes)─► done
     │          │          │   │              └(check fails)─► retry ─► running   (after N ─► failed)
     │          │          │   └─► failed ──────────────────► (successors stay blocked forever)
     │          └── reclaim (lease expired) ◄── running
     └── re-plan adds a new blocked node / cancel ─► cancelled
```

- `blocked → ready`: by the **unblock trigger** the instant the last upstream hits `done` (or `ready` at insert if in-degree 0).
- `ready → running`: by an **atomic claim** (`FOR UPDATE SKIP LOCKED`) that also stamps a lease.
- `running → verifying`: the runner stores the raw output, then runs the **automated check** in a sandbox.
- `running → ready`: by **stale-lease reclaim** (crash) or **retry**.
- `verifying → done | failed`: **`done` only if the automated check passes**; otherwise retry, then `failed`. No human, no AI verdict.
- `* → cancelled`: by a **re-plan** subtree prune.

### 3.2 Edge semantics & readiness

An edge `(upstream_id → downstream_id)` means *downstream may not become `ready` until upstream is `done`.* Branding/research are sources (in-degree 0); QA is the sink. The **readiness rule** is the heart of the engine:

> A task is **ready** iff it is currently `blocked` (or `ready`) **and** it has **zero** upstream edges whose upstream task is not yet `done`.

This is expressed as a view (the canonical, project-wide reconciliation query — also the restart/safety net):

```sql
create view v_ready_tasks as
select t.*
from tasks t
where t.status in ('blocked','ready')
  and not exists (
    select 1
    from task_dependencies e
    join tasks up on up.id = e.upstream_id
    where e.downstream_id = t.id
      and up.status <> 'done'
  );
```

### 3.3 The unblock rule — scoped trigger (primary) + view (safety net)

The grafted optimization (from `dag-executor`): instead of a project-wide rescan on every completion, the trigger re-evaluates **only the direct successors** of the task that just finished, via the `deps_upstream_idx`. The project-wide `v_ready_tasks` view is kept purely as the **restart/reconciliation** mechanism.

```sql
-- PRIMARY: scoped unblock — fires when a task reaches 'done'.
create or replace function fn_unblock_successors() returns trigger as $$
begin
  if new.status = 'done' and old.status <> 'done' then
    -- flip only THIS task's direct successors whose deps are now all done
    update tasks d
    set status = 'ready', updated_at = now()
    where d.status = 'blocked'
      and exists (select 1 from task_dependencies e
                  where e.upstream_id = new.id and e.downstream_id = d.id)
      and not exists (
        select 1 from task_dependencies e2
        join tasks up on up.id = e2.upstream_id
        where e2.downstream_id = d.id and up.status <> 'done');

    insert into run_events(project_id, task_id, type, actor, detail)
    select new.project_id, d.id, 'task_unblocked', 'db',
           jsonb_build_object('unblocked_by', new.id, 'by_seq', new.seq)
    from tasks d
    where d.project_id = new.project_id and d.status = 'ready' and d.updated_at = now();
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_unblock
  after update of status on tasks
  for each row execute function fn_unblock_successors();

-- SEED: tasks with no upstream edge start 'ready' at insert.
create or replace function fn_seed_ready() returns trigger as $$
begin
  if not exists (select 1 from task_dependencies e where e.downstream_id = new.id) then
    new.status := 'ready';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_seed_ready
  before insert on tasks
  for each row execute function fn_seed_ready();
```

> **Edge-insertion order (planner write):** insert all task rows first (no edges → all seed to `ready` via `trg_seed_ready`), then insert edges, then run one normalization pass `UPDATE tasks SET status='blocked' WHERE status='ready' AND EXISTS(edge with undone upstream)`. Wrap the whole planner write in **one transaction** so a half-wired graph never goes live.

**Concrete unblock semantics (the user's example):** completing **#4** flips its direct successors **#8/#9/#10** to `ready` (those whose *other* upstreams are also done); when **#8/#9/#10** finish, the same scoped query promotes **#11/#12**. The graph fans out and re-converges at QA — "routing between universes."

### 3.4 The canonical cycle check (used on EVERY structural mutation)

Acyclicity must hold not just at first plan, but on every dynamic insert and every re-plan edge add. One routine, invoked everywhere:

```sql
-- Returns true if adding edge (p_up → p_down) would create a cycle,
-- i.e. p_down can already reach p_up. Also usable to validate a whole batch
-- by inserting candidate edges in a SAVEPOINT and re-running per edge.
create or replace function fn_would_create_cycle(p_up uuid, p_down uuid)
returns boolean as $$
declare reachable boolean;
begin
  with recursive reach(id) as (
    select downstream_id from task_dependencies where upstream_id = p_down
    union
    select e.downstream_id from task_dependencies e join reach r on e.upstream_id = r.id
  )
  select exists(select 1 from reach where id = p_up) into reachable;
  return reachable;          -- true => edge is illegal
end;
$$ language plpgsql;
```

**Failure mode:** any mutation (plan insert, dynamic task growth §8.6, edge redirect §8.5) that would make `fn_would_create_cycle` true is **rejected**; the offending edge is dropped and a `validation_failed` event is logged with the cycle path. For a fresh plan, a full topological sort (Kahn's algorithm in the validator) must succeed before the transaction commits.

---

## 4. Planner Specification

The planner is a one-shot agent run with three phases — **clarify → decompose → emit DAG** — followed by a **deterministic validator** (harness code, not an LLM) that checks and inserts.

### 4.1 Phase A — Clarifying-questions intake loop (fully specified round-trip)

Project starts at `status='intake'`. The planner inspects the brief for required slots per archetype:

- **Delivery app:** `country`, `positioning`, `vertical` (required); `platform`, `auth_model` (optional).
- **WordPress site:** `brand_exists`, `page_count`, `positioning` (required).

**Autonomous intake (no questions asked):** the planner derives the required slots from the brief; any it cannot derive it **fills with conservative, archetype-aware defaults and records them in `params.assumptions[]`** (event `assumptions_recorded`), then proceeds straight to planning. The operator is **never** prompted mid-flight. A wrong assumption is surfaced in the end-of-run report (§9) but never blocks the run.

Example for a thin brief ("build a delivery app"): `country` → operator locale or global; `positioning` → "mass-market"; `vertical` → "food"; `platform` → "web". All recorded, none asked.

*(No `clarify` phase exists — the planner assumes and records, then plans. See autonomous intake above.)*

### 4.2 Phase B/C — Plan output schema (what the planner MUST return)

The planner emits **edges by stable local refs** (`ref` strings) — it cannot know UUIDs — and the validator rewrites refs → UUIDs in a two-pass transactional insert.

```json
{
  "phase": "plan",
  "project": { "name": "QuickDeliver LB" },
  "tasks": [
    {
      "ref": "t1",
      "seq": 1,
      "title": "Market & positioning research (Lebanon)",
      "department": "research",
      "stage": 0,
      "priority": 10,
      "verify": "facts file parses; required fields present; links resolve",
      "has_side_effects": false,
      "description": "Research delivery market in {country}; competitors, pricing norms, cultural color/imagery conventions, payment habits (cash-on-delivery prevalence), languages.",
      "input_spec": {"country": "{country}", "positioning": "{positioning}"}
    }
    // ... more tasks
  ],
  "edges": [
    {"upstream": "t1", "downstream": "t2", "consumes_output": true},  // research → branding
    {"upstream": "t2", "downstream": "t6", "consumes_output": true}   // branding → frontend
  ]
}
```

Note: the planner does **not** choose `assignee_agent` — the validator resolves it from `department` via the `agents` registry. The planner does **not** choose `model`/lease — those are deployment concerns in `agents`.

### 4.3 Planner rules (encoded in its system prompt)

1. **Department ordering mirrors a real agency.** Enforce precedence: `research → branding → (cms_choice ∥ database_design ∥ auth ∥ media) → frontend/content → integration → qa`. Branding always depends on research; every build/content/media task gets an edge from branding.
2. **Seed stage 0 with research** (and context-free setup). Branding sits at stage 1 with an edge from research — guaranteeing brand output exists before any build task starts.
3. **Parallelize within a department where independent.** Tasks at the same stage must NOT depend on each other.
4. **Mark `consumes_output=true`** on any edge where the downstream uses the upstream's payload; `false` for pure ordering.
5. **Insert a `qa` task** after assembly whose `verify` is the real acceptance check (assembled app builds + smoke tests pass + deploys 200) — an automated harness, not a human gate.
6. **Target 8–15 tasks** per project (legible graph; rich enough to parallelize).
7. Output **only** the JSON schema above. Every `edge` ref must exist in `tasks`. The graph must be acyclic.

### 4.4 The validator (deterministic harness step — runs before any insert)

The validator is the structural guardrail layer. It runs, in order:

1. **JSON-Schema check** of the planner output shape.
2. **Ref integrity:** every edge `upstream`/`downstream` matches a task `ref`; no dangling/duplicate refs.
3. **Acyclicity:** Kahn topological sort must consume all nodes; otherwise reject with the cycle path. (Per-edge dynamic checks use `fn_would_create_cycle`, §3.4.)
4. **Branding-ancestor lint (structural guardrail):** *every `frontend`, `media`, and `content` task MUST have a `branding` task as a transitive ancestor.* Reject otherwise. (Grafted from `mvp-pragmatic`.)
5. **Context-reference cross-check:** scan each task's `description`/`input_spec` for references to upstream artifacts (e.g. "the palette," "the schema," "the brand"). If a task references a concept owned by a department it has **no upstream edge to**, reject (e.g. a frontend task that mentions "the palette" with no branding ancestor). (Grafted from `dag-executor`.)
6. **Department/agent resolution:** map each `department` → enabled `agents.id`; fail if a department has no enabled agent.
7. **Compute `stage`** via topological layering (display only).

On any failure, the validator returns the specific error to the planner for **one revision attempt**; a second failure escalates the project to `blocked` with the validator report in `run_events`. On success, it writes everything in **one transaction** (two-pass: insert tasks capturing `ref→uuid`, insert edges, normalize statuses, set `projects.status='running'`, log `planned`).

---

## 5. Scheduler / Execution Loop

**Polling primary, `LISTEN/NOTIFY` optional accelerator.** Polling is trivially restart-safe, has no missed-event failure mode, and `FOR UPDATE SKIP LOCKED` gives safe multi-runner concurrency with zero extra infra. An optional `LISTEN` on `task_unblocked` shortens wave latency; polling remains the source of truth.

```python
RUNNER_ID   = f"runner-{uuid4()}"
POLL_SEC    = 3

def run_loop(project_id):
    while True:
        reclaim_stale_tasks(project_id)          # 0. crash recovery (expired leases)
        reconcile_readiness(project_id)          # 1. project-wide safety-net reconcile (idempotent)

        proj = load_project(project_id)
        if budget_exceeded(project_id, proj):    # 2. spend ceiling — pause, don't kill
            set_project_status(project_id, 'paused'); log('budget_exceeded'); break
        if is_terminal(project_id):              # done / failed / blocked (deadlock)
            finalize(project_id); break

        # 3. enforce GLOBAL + per-project caps
        slots = available_slots(project_id, proj.global_concurrency)
        if slots > 0:
            # 4. claim respecting per-DEPARTMENT caps (agents.max_parallel)
            claimed = claim_ready_tasks(project_id, slots)
            for task in claimed:
                spawn_async(dispatch, task)      # independent tasks run in parallel

        sleep(POLL_SEC)

# ---- atomic claim: concurrency primitive (per-department cap enforced in the CTE) ----
def claim_ready_tasks(project_id, slots):
    return db.execute("""
      with dept_load as (   -- current running count per department for this project
        select department, count(*) as running
        from tasks where project_id = %(pid)s and status = 'running'
        group by department
      ),
      candidates as (
        select r.*,
               a.max_parallel,
               coalesce(dl.running, 0) as dept_running,
               row_number() over (partition by r.department
                                  order by r.priority asc, r.seq asc) as dept_rank
        from v_ready_tasks r
        join agents a on a.id = r.assignee_agent
        left join dept_load dl on dl.department = r.department
        where r.project_id = %(pid)s
      ),
      picked as (
        select id from candidates
        where dept_running + dept_rank <= max_parallel   -- respect per-department cap
        order by priority asc, seq asc
        limit %(slots)s
        for update skip locked                           -- two runners never grab the same task
      )
      update tasks t
      set status='running', claimed_by=%(runner)s, claimed_at=now(),
          lease_expires_at = now() + (select lease_seconds from agents where id = t.assignee_agent) * interval '1 second',
          started_at = coalesce(started_at, now()),
          attempts = attempts + 1, updated_at = now()
      from picked
      where t.id = picked.id
      returning t.*;
    """, {"pid": project_id, "slots": slots, "runner": RUNNER_ID})

def dispatch(task):
    ctx = build_context_packet(task)             # §6.1, §7 — token-budgeted
    if not reserve_budget(task, ctx):            # pre-flight cost guard (§5.2)
        return release_to_ready(task, reason="budget")
    run = create_agent_run(task, ctx)            # idempotency anchor (task_id::attempt)
    hb  = start_heartbeat(task, run)             # lease renewal thread (§8.1)
    try:
        result = spawn_subagent(task.assignee_agent, ctx, idem=run.idempotency_key)
        persist_result(task, run, result)        # validate → write outputs → flip status (§6.3)
    except Exception as e:
        handle_failure(task, run, e)             # retry / fail (§8.2)
    finally:
        hb.stop()

# ---- crash recovery: reclaim tasks whose runner died mid-flight ----
def reclaim_stale_tasks(project_id):
    db.execute("""
      update tasks
      set status='ready', claimed_by=null, claimed_at=null, lease_expires_at=null, updated_at=now()
      where project_id=%s and status='running' and lease_expires_at < now()
      returning id;""", [project_id])
    # log 'lease_reclaimed' per row
```

### 5.1 Parallel vs sequential — why it falls out for free

Every task returned by `claim_ready_tasks` has **all** upstreams `done`, so none in a batch depends on another → safe to run **concurrently** (up to caps). A dependent task is simply still `blocked` and not in the set; it enters only after its feeder finishes → necessarily **sequential** after it. No "stage barrier" code is needed — edges enforce ordering, caps enforce parallelism width.

### 5.2 Concurrency governance — three composing caps

For an agency running many briefs at once, three caps compose (most restrictive wins):

1. **Global / per-account cap** — a `worker_slots` row table acts as a cluster-wide semaphore:
   ```sql
   create table worker_slots (
     account_id text primary key,
     max_in_flight int not null default 24,
     in_flight     int not null default 0
   );
   ```
   The runner increments `in_flight` inside the claim transaction (`update ... set in_flight = in_flight + n where in_flight + n <= max_in_flight`) and decrements on completion. Claims that would exceed the global cap simply claim fewer rows this tick.
2. **Per-project cap** — `projects.global_concurrency`, enforced by `available_slots`.
3. **Per-department cap** — `agents.max_parallel`, enforced in the claim CTE (above).

This makes multi-runner, multi-project execution correct *and* bounded: `SKIP LOCKED` prevents double-dispatch; the semaphore bounds total spend/load.

---

## 6. Department-Agent Contract — *just an API call, never trusted on its word*

> **Design decisions (v1.1):**
> **(a)** A working agent has **no internal structure** — it is **one LLM/API call**: text in, text out, stored verbatim. No JSON Schemas, no `payload_keys`, no `output_schema`.
> **(b)** **Zero trust in AI self-reporting.** An agent saying "done" means nothing. A task is only `done` when an **external, deterministic check passes** — `build` exits 0, schema applies, file exists, URL returns 200, tests pass. The model's claims are never the completion signal and never gate downstream work.

### 6.1 The entire agent contract

```
result_text = call_agent(role_prompt, context_text)
```

- **`role_prompt`** — one line naming the department's job (stored in `agents.role_prompt` or hard-coded in v1).
- **`context_text`** — brief + clarified params + the **plain-text outputs of upstream tasks**, concatenated.
- **`result_text`** — whatever the agent writes (markdown / plain text / a fenced ```code block``` artifact). Stored **verbatim** in `task_outputs.content`. The runner does **not** parse or believe it.

### 6.2 The input an agent receives (plain text)

```
BRIEF:   build a delivery app for Lebanon
PARAMS:  country=Lebanon; positioning=premium; auth=phone+password
BRAND KIT (from #2 Branding):  <branding agent's full output, pasted in>
UPSTREAM RESULTS:
  [#4 Database] <db agent's output>
  [#3 Stack]    <stack agent's output>
YOUR JOB: <role_prompt for this department>
```

Built by walking `task_dependencies` backward and pasting each upstream's `task_outputs.content`. Branding is always pasted in (the "brand kit"). Deep fan-in is bounded by one number, `max_context_chars` (paste the head of the largest upstreams when over). No tiering machinery.

### 6.3 The output — stored, then distrusted

The agent returns a blob of text; the runner stores it as `task_outputs.content` and **ignores any status the agent claims**. There is no `STATUS: done` self-report — completion is decided in §6.4 by a check the agent cannot influence.

### 6.4 Zero-trust completion — verification, not self-report  ⟵ *the load-bearing change*

Every task carries a **`verify`** rule (a column on `tasks`, set by the planner). The lifecycle is:

```
ready → running → verifying → done   (✓ automated check passed → the ONLY way to reach done)
                           ↘ retry  (✗ check failed → re-run; after N tries → failed)
```

**The unblock trigger fires on `done` (the check passed), NOT when the agent merely produces output.** A downstream task never sees upstream work until it has *objectively passed*.

Three verification tiers, in order of trust:

| Tier | Used for | The check (runs in a sandbox, deterministic) |
|---|---|---|
| **1. Code-checked (preferred)** | database, frontend, integration, stack, auth | `psql -f schema.sql` applies on a scratch DB · `npm run build` / `tsc --noEmit` exit 0 · unit/e2e tests pass · `curl -sf URL` returns 200 · artifact exists & non-empty · linter/typecheck clean |
| **2. Asserted facts** | research, content, media | machine-checkable assertions: required files present, link-checker passes, image count ≥ N & dimensions valid, word count in range, JSON parses — **facts, not opinions** |
| **3. Automated acceptance (taste)** | branding, copy | **no human** — taste is pinned to objective proxies: tokens parse & are valid, WCAG AA contrast passes, required fields present, and the **downstream build that consumes them succeeds**. An independent critic call may *fail* a task but is never the sole reason to *pass*. |

The old idea of a **QA *agent* that returns a pass/fail verdict is deleted** — that's just more untrusted AI reporting. "QA" becomes the **verification harness itself** — the build/test/deploy checks above. **No human sign-off**: the final task passes when the assembled app builds, its smoke tests pass, and it deploys to a reachable URL.

### 6.5 Write-back & retry (runner — deterministic, agent never sets its own status)

```python
result = call_agent(role_prompt(task.department), build_context(task))
db.upsert("task_outputs", task_id=task.id, content=result, attempt=task.attempts)  # store raw, believe nothing
db.update("tasks", id=task.id, status="verifying")

ok, log = run_verifier(task.verify, result, task)        # REAL automated check in a sandbox — not an LLM, not a human
if ok:
    db.update("tasks", status="done")                     # the ONLY path to done -> unblock trigger fires
else:
    db.insert("run_events", type="verify_failed", detail=log)
    retry_or_fail(task)                                   # bump attempts; after N -> failed (never silently 'done', never escalated to a human)
```

- **Retry** feeds the failure log back into the agent's next context ("your build failed with: …, fix it").
- **Idempotency:** one current row per task (`UNIQUE(task_id)` upsert). Side-effecting tasks (deploy/email) additionally use a stable idempotency key (§8) so a retry can't double-fire.
- **No silent success, no human escape hatch:** every task MUST carry an automated `verify` rule; a task without one is a **planner error rejected at plan time** — never auto-`done`, never routed to a person.

### 6.6 Role prompts — the only per-department difference

One line each; swap the line, get a new department:
- **branding** — "From the research, output brand **tokens** (palette, type scale, radii, spacing) as JSON/CSS variables + a short guide." *(verified: tokens valid + WCAG AA + first component that uses them builds)*
- **database** — "From the brief + stack, design the schema. Output a runnable `CREATE TABLE` block." *(verified: applies on scratch DB)*
- **frontend** — "Using the brand kit + schema, build the screens/components, applying branding's exact colours/fonts." *(verified: `build` + `tsc` pass)*

---

## 7. Context Propagation — Branding → Build (worked concretely)

This is the core of the vision, enforced **two ways, redundantly on purpose**: edges drive *scheduling and per-task data injection*; the pinned `brand_kit` guarantees *universal propagation*.

**Step 1 — Branding (task #2) produces a `brand_system` output:**

```json
{
  "kind": "brand_system",
  "summary": "Premium Beirut-modern: deep green + warm sand, generous whitespace.",
  "payload": {
    "palette": {"primary":"#0B6E4F","secondary":"#E9C46A","bg":"#0E1411","text":"#F4F1EA"},
    "typography": {"display":"Söhne","body":"Inter","scale":"1.25 modular"},
    "logo_direction": "wordmark, lowercase, leaf glyph in the 'd'",
    "layout_format": "card-based, 12-col, 16px gutters, 12px radius, soft shadows",
    "tone": "confident, concise, locally proud",
    "imagery": "real Lebanese food photography, warm light"
  }
}
```

**Step 2 — Pin it globally.** A trigger copies the branding payload into `projects.brand_kit` the moment branding's output lands, so *every* downstream agent receives it (even tasks the planner forgot to wire an edge to):

```sql
create or replace function fn_sync_brand_kit() returns trigger as $$
begin
  if new.department = 'branding' and new.is_current then
    update projects set brand_kit = new.payload, updated_at = now()
    where id = new.project_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_sync_brand_kit
  after insert on task_outputs
  for each row execute function fn_sync_brand_kit();
```

**Step 3 — The graph routes scheduling.** The planner created data-edges `#2 → #6 (frontend)`, `#2 → #5 (cms/stack)`, `#2 → #9 (media)`. When #2 hits `done`, `trg_unblock` flips those successors to `ready` (once their other upstreams are done too).

**Step 4 — The runner injects branding into each build agent.** When dispatching the frontend agent (#6), `build_context_packet` (a) includes #2's full `brand_system` payload in `upstream_outputs` (direct data edge), and (b) always includes `projects.brand_kit`. The frontend agent's prompt instructs: *"Apply `brand_kit.palette`, `typography`, and `layout_format` as the design system. Echo what you applied in `payload.applied_brand`."* The agent **cannot start before branding exists** (the edge gated readiness) and **cannot ignore it** (it's pinned in context with an explicit instruction).

**The elegant property:** if a build task needs branding, there is an edge — and that single edge simultaneously (a) *orders* the task after branding and (b) *delivers* branding's payload to it. Edges carry context. The `brand_kit` is the agency's "brand guidelines doc" every desk references.

---

## 8. Failure Handling, Governance & Resumability

### 8.1 Lease heartbeat / renewal (gap fixed — concrete mechanics)

Long agent runs must not be falsely reclaimed and double-dispatched. Each department has a **tuned lease TTL** in `agents.lease_seconds` (e.g. `research:300`, `branding:600`, `database_design:600`, `frontend:900`, `integration:1200` for deploys). On dispatch, the runner starts a **heartbeat** that renews the lease at **TTL/3** intervals while the agent is in flight:

```python
def start_heartbeat(task, run):
    interval = lease_seconds_for(task.assignee_agent) / 3
    def beat():
        while not stopped:
            db.execute("""
              update tasks
              set lease_expires_at = now() + %(ttl)s * interval '1 second', updated_at = now()
              where id = %(id)s and status='running' and claimed_by = %(runner)s
              returning id;""",
              {"ttl": lease_seconds_for(task.assignee_agent), "id": task.id, "runner": RUNNER_ID})
            log_event(task, 'lease_renewed')
            sleep(interval)
    return spawn_thread(beat)   # .stop() in dispatch's finally
```

Renewal is **owner-scoped** (`claimed_by = RUNNER_ID`): a runner that lost its claim (because its lease already expired and another runner reclaimed) cannot renew, preventing two runners from believing they own the task. Genuinely long runs stay alive; truly dead runners stop beating → lease expires → `reclaim_stale_tasks` recovers the task.

### 8.2 Failure & retry matrix

| Scenario | Mechanism |
|---|---|
| **Transient agent error / timeout** | `attempts` already incremented at claim. If `attempts < max_attempts`: set `status='ready'`, clear lease, log `task_retry`, optional backoff via temporary `priority` bump. Re-claimed on a later tick. |
| **Verification fails** | Output is stored but the task does not advance: `verify_failed` event, then retry with the failure log injected into the agent's next context. Never reaches `done`. |
| **Exhausted retries / non-retryable** | `status='failed'`, write `last_error`. Successors stay `blocked` (correct — can't build on a failed dependency). |
| **Runner process crash** | Lease expires → `reclaim_stale_tasks` flips `running→ready`. Another runner (or the restarted one) picks it up. Heartbeat (§8.1) prevents false reclaim of live work. |
| **Crash after output written, before status flip** | `agent_runs.status='succeeded'` exists for the latest attempt → re-dispatch short-circuits to `persist_result`; no duplicate agent call, no duplicate side effect (§6.5). |
| **Side-effecting task retried** | `side_effects` ledger + stable `effect_key` + provider idempotency key → effect happens exactly once (§6.5). |
| **Taste / acceptance check** | Pinned to objective proxies (valid tokens, WCAG AA, the consuming build passes) + an independent critic that may only *fail* a task — no human gate, no `approvals` row. |
| **Budget ceiling hit** | Project → `paused`; no new claims. Operator raises `budget_usd` or cancels (§8.4). |
| **Deadlock** (nothing ready/running, blocked>0) | `v_project_health` derives `blocked`; runner writes `projects.status='blocked'` and exits; surfaced in the end-of-run report. |
| **Full restart from scratch** | Runner boots, finds `projects` in `running`/`paused`, runs `reclaim_stale_tasks` + `reconcile_readiness`, resumes the loop. **Zero in-memory recovery** — readiness is a pure function of rows. |

### 8.3 No human gates (removed by design)

There is **no approval surface**. A task reaches `done` **only** when its `tasks.verify` check passes (§6.4); on failure it retries, then `failed`. "Taste" work (branding/copy) is accepted via objective proxies + an independent critic that may only *fail* a task. The operator is never asked to approve anything mid-run — the sole touchpoint after the brief is the end-of-run report (§9).

### 8.4 Graph editing / re-plan on an in-flight project (gap fixed — supported mutations)

A `running` or `blocked` project supports a bounded, validated set of mutations. **Every structural mutation runs inside a transaction that re-invokes `fn_would_create_cycle` (§3.4) and the branding-ancestor lint (§4.4) and aborts on violation.**

| Mutation | Preconditions | Status transitions & rules |
|---|---|---|
| **Add task** | New node's department has an enabled agent | Insert as `blocked`; if it has no upstream edge it seeds `ready`. Cycle-check each new edge. |
| **Add edge** (`up → down`) | `down` not yet `done`/`running`; `fn_would_create_cycle(up,down)=false` | Insert edge. If `up` not `done` and `down` was `ready`, normalize `down → blocked`. |
| **Drop edge** | — | Delete edge; run scoped reconcile on `down` (it may now be `ready`). Used to detach a successor from a `failed` node. |
| **Redirect edge** (recover from failed node) | new upstream not creating a cycle | Drop old edge + add new edge atomically; reconcile `down`. |
| **Cancel subtree** | target not `done` | Recursively set the target and all descendants reachable via `deps_upstream` to `cancelled` (a `running` node is first lease-revoked; its in-flight agent result is ignored). Successors that lose all non-cancelled upstreams are reconciled. Log `subtree_cancelled`. |
| **Re-plan (additive)** | project `blocked`/`running` | Planner re-invoked with current board as context; emits only **new** `tasks`/`edges`; existing `done` rows are untouched; full validator (§4.4) + cycle check before commit; log `replanned`. |

Mutations that would strand the graph (e.g. dropping the only path to QA) are warned-on via `v_project_health` but permitted (the operator may intend it). A node that is `running` cannot have its **incoming** edges changed until it settles (claim lease guards it); its lease is revoked first if it must be cancelled.

### 8.5 Dynamic graph growth from agents (bounded, grafted from dag-executor)

Agents may surface emergent work the planner missed via `proposed_tasks`/`proposed_edges` in their output. The runner, in `persist_result`, inserts them as **`blocked`** after: (a) JSON-Schema validation, (b) department→agent resolution, (c) `fn_would_create_cycle` check on every proposed edge, (d) branding-ancestor lint. Rejected proposals are logged (`validation_failed`) and discarded; the agent's primary output is unaffected. This keeps the graph adaptive while always acyclic and contract-valid.

### 8.6 Cost / budget governance (gap fixed)

Every `agent_runs` row records `input_tokens`, `output_tokens`, `cost_usd`; each completion appends to `budget_ledger`. Before dispatch, `reserve_budget(task, ctx)` estimates cost (`agents.cost_per_run_estimate` + context-size factor); if `spent + estimate > projects.budget_usd`, the task is **not** dispatched and the project transitions to `paused` with a `budget_exceeded` event. A `budget_warning` fires at 80%. Monitoring queries:

```sql
-- spend so far vs ceiling
select p.id, p.budget_usd,
       coalesce(sum(b.cost_usd),0) as spent,
       p.budget_usd - coalesce(sum(b.cost_usd),0) as remaining
from projects p left join budget_ledger b on b.project_id = p.id
where p.id = :pid group by p.id;

-- cost by department (where is the money going?)
select t.department, sum(r.cost_usd) as cost, sum(r.input_tokens+r.output_tokens) as tokens
from agent_runs r join tasks t on t.id = r.task_id
where r.project_id = :pid group by t.department order by cost desc;
```

### 8.7 Resumability invariant

The only durable state is Postgres rows; every transition is a single idempotent SQL statement; every claim is leased and heartbeat-renewed; every side effect is ledgered. You can `kill -9` the orchestrator at any instant and lose nothing but in-flight tokens. On restart the runner recomputes the identical frontier from `tasks + task_dependencies + task_outputs`.

---

## 9. Observability — watching the board

Everything is a SQL query over append-only logs; no separate telemetry system. Expose these via Supabase's auto REST/Realtime API and a thin dashboard subscribes to `tasks` changes for a live ClickUp-style board.

**Live board (the table the user stares at):**
```sql
create view v_board as
select t.project_id, t.seq, t.title, t.department, t.assignee_agent, t.status,
       t.priority, t.stage, t.attempts, t.last_error,
       o.summary as output_summary, t.updated_at
from tasks t
left join task_outputs o on o.task_id = t.id and o.is_current
order by t.stage, t.priority, t.seq;
```

**Project health / progress + derived deadlock detection:**
```sql
create view v_project_health as
select p.id,
  count(*) filter (where t.status='done')         as done,
  count(*) filter (where t.status='running')      as running,
  count(*) filter (where t.status='ready')        as ready,
  count(*) filter (where t.status='blocked')      as blocked,
  count(*) filter (where t.status='failed')       as failed,
  count(*) filter (where t.status='verifying') as verifying,
  count(*) filter (where t.status='cancelled')    as cancelled,
  count(*)                                         as total,
  coalesce((select sum(cost_usd) from budget_ledger b where b.project_id = p.id),0) as spent_usd,
  case
    when count(*) filter (where t.status not in ('done','cancelled')) = 0 then 'done'
    when count(*) filter (where t.status='running')=0
     and count(*) filter (where t.status='ready')=0
     and count(*) filter (where t.status in ('blocked','failed'))>0 then 'blocked'
    else 'running'
  end as derived_status
from projects p join tasks t on t.project_id = p.id
group by p.id;
```
The runner writes `derived_status` back to `projects.status` each tick.

**What's running now / the frontier:**
```sql
select seq, title, department, claimed_by, started_at, lease_expires_at
from tasks where project_id=:pid and status='running' order by started_at;
```

**Activity feed (audit + the "routing between universes"):**
```sql
select created_at, type, task_id, actor, detail
from run_events where project_id=:pid order by id desc limit 50;
-- task_unblocked rows literally read "completing #4 unblocked #8,#9,#10"
```

**Dependency frontier (what unblocks what):**
```sql
create view v_edges_readable as
select e.project_id, e.consumes_output,
       u.seq as upstream, u.status as up_status,
       d.seq as downstream, d.status as down_status
from task_dependencies e
join tasks u on u.id = e.upstream_id
join tasks d on d.id = e.downstream_id;
```

**Stuck-work alert (the only one that matters):** tasks `failed` or `running` past lease; plus projects at `paused`/`blocked`.

---

## 10. Fully-Worked Example — Delivery App ("QuickDeliver," Lebanon)

**Brief:** *"build a delivery app for Lebanon."*
**Clarifications captured into `projects.params`:** `country=Lebanon`, `positioning=premium`, `vertical=food+groceries`, `platform=both`, `auth_model=phone+password`.

### 10.1 The board (actual rows in `tasks`)

| seq | title | department | assignee_agent | depends_on (seq) | stage | initial status | review? | side-fx? |
|----|-------|-----------|----------------|------------------|:--:|------|:--:|:--:|
| 1 | Market & positioning research (Lebanon) | research | research-agent | — | 0 | **ready** | no | no |
| 2 | Brand system (palette, type, logo dir, layout) | branding | branding-agent | 1 | 1 | blocked | **yes** | no |
| 3 | CMS/stack decision (PWA+native, Supabase backend) | cms_choice | stack-agent | 1 | 2 | blocked | no | no |
| 4 | Database schema (users, restaurants, orders, items) | database_design | db-agent | 3 | 3 | blocked | no | no |
| 5 | Auth & accounts (phone+password, OTP, sessions) | auth | auth-agent | 2,4 | 4 | blocked | no | no |
| 6 | Media & imagery (food photography, brand assets) | media | media-agent | 2 | 2 | blocked | no | no |
| 7 | Frontend design system (tokens from brand) | frontend | frontend-agent | 2,3 | 3 | blocked | no | no |
| 8 | Customer screens (browse, cart, checkout, track) | frontend | frontend-agent | 4,5,6,7 | 5 | blocked | no | no |
| 9 | Courier/driver screens (accept, navigate, deliver) | frontend | frontend-agent | 4,5,7 | 5 | blocked | no | no |
| 10 | Copywriting & microcopy (premium tone) | content | content-agent | 2 | 2 | blocked | no | no |
| 11 | Payments + maps integration + deploy | integration | integration-agent | 4,8 | 6 | blocked | no | **yes** |
| 12 | QA review & assembly | qa | qa-agent | 8,9,10,11 | 7 | blocked | **yes** | no |

### 10.2 The edges (`task_dependencies`, upstream → downstream)

```
1 → 2, 1 → 3                       research feeds branding and stack
2 → 5, 2 → 6, 2 → 7, 2 → 10        branding feeds auth-UI, media, design-system, copy   (all consumes_output=true)
3 → 4, 3 → 7                       stack feeds schema and design system
4 → 5, 4 → 8, 4 → 9, 4 → 11        schema feeds auth, both screen sets, payments
5 → 8, 5 → 9                       auth feeds customer + courier screens
6 → 8                              media feeds customer screens
7 → 8, 7 → 9                       design system feeds both screen sets
8 → 11                             checkout screen feeds payments
8 → 12, 9 → 12, 10 → 12, 11 → 12   everything converges into QA
```

### 10.3 Stage-by-stage execution (what the runner does; per-project cap = 4)

| Wave | Ready set claimed | Parallel? | Unblocks on completion |
|---|---|:--:|---|
| **W0** | **#1** research | single | #2, #3 |
| **verify** | #2 branding runs → tokens validated (valid + WCAG AA + sample build) → `done` (→ `brand_kit` pinned) | — | #5*, #6, #7*, #10 (*await other deps) |
| **W1** | **#3, #6, #10** (#3 needs #1; #6,#10 need #2) | yes (3) | #3 → #4, #7 |
| **W2** | **#4, #7** (#4 needs #3; #7 needs #2,#3) | yes (2) | #4 → #5, #8, #9, #11; #7 → #8, #9 |
| **W3** | **#5** (auth, needs #2,#4) | single | #5 → #8, #9 |
| **W4** | **#8, #9** (need #4,#5,#6,#7 / #4,#5,#7) | yes (2) | #8 → #11; #8,#9 → #12 |
| **W5** | **#11** payments+deploy (needs #4,#8) — **side-effecting**, routes deploy through `side_effects` ledger | single | #11 → #12 |
| **verify** | **#12** QA → assembled app builds + smoke tests pass + deploys (200) → `done` | — | project `done` |

This is exactly the "routing between universes": completing **#2 (branding)** unblocks the whole build department and pins the brand kit consumed by #6/#7/#8/#9/#10; completing **#4 (DB)** ripples into auth, both screen sets, and payments; the graph fans out and re-converges at QA. The premium palette physically arrives in every frontend agent's context via the `2 → 7 → 8/9` chain *and* the pinned `brand_kit`. Kill the runner at any wave and restart — it recomputes the identical frontier from `v_ready_tasks` and resumes (e.g. after W2 it resumes at W3 because `done` rows persist).

### 10.4 Board snapshot mid-run (after W2 completes), as the user queries it

| seq | title | dept | status | output_summary |
|----|-------|------|--------|----------------|
| 1 | Research | research | done | "Premium urban Beirut; COD common; FR/AR; rounded-modern conventions" |
| 2 | Brand system | branding | done | "#0B6E4F + #E9C46A; Söhne+Inter; card layout, 12px radius" |
| 3 | Stack choice | cms_choice | done | "Supabase + Next.js PWA + RN; rationale attached" |
| 4 | DB schema | database_design | done | "12 tables; schema.sql artifact" |
| 6 | Media | media | done | "28 food images + brand assets in `assets` bucket" |
| 7 | Design system | frontend | done | "Tokens from brand; 18 components" |
| 10 | Copywriting | content | done | "Premium, locally-proud microcopy set" |
| 5 | Auth | auth | running | — |
| 8 | Customer screens | frontend | blocked | — |
| 9 | Courier screens | frontend | blocked | — |
| 11 | Payments+deploy | integration | blocked | — |
| 12 | QA | qa | blocked | — |

---

## 11. Build Phases (MVP → Full) & Open Questions

### 11.1 Implementation appendix — week-one build order (deferral ledger)

Ship the smallest correct core that runs the full branding→build chain end-to-end this week; everything else is **additive** (no schema rework).

| Phase | Build | Notes |
|---|---|---|
| **0. DDL** | `projects, agents, tasks, task_dependencies, task_outputs, agent_runs, run_events` + the unblock/seed triggers + `v_ready_tasks`/`v_board` views | The engine. Defer `side_effects`, `budget_ledger`, `worker_slots` until their feature lands. (No `approvals` — autonomous.) |
| **1. Runner loop** | reclaim → reconcile → claim (`SKIP LOCKED`) → dispatch → persist; single runner; per-project cap only | ~120 lines. Heartbeat + per-department caps next. |
| **2. Planner + validator** | clarify gate → plan JSON → JSON-Schema + cycle + branding-ancestor lint → two-pass ref→uuid insert | The structural guardrails. |
| **3. Stub agents** | 10 department agents that emit **spec JSON** (palette, schema SQL text, screen lists) not full builds | Proves orchestration; swap prompts for real codegen later. |
| **4. Run the delivery graph** | the §10 example end-to-end; kill+restart mid-run to prove resumability | Acceptance test. |
| **5. Watch `v_board`** | Supabase Studio or a 30-line Realtime table UI | Observability. |
| **6. Harden** | heartbeat/leases → per-department + global caps (`worker_slots`) → side-effect ledger → budget ceiling → dynamic growth + re-plan → `LISTEN/NOTIFY` accelerator | Each lands independently on the same schema. |

**Deferred (safe to skip in v1):** vector/RAG context store (the tiered context budget §6.2 is more precise at 8–15 tasks); cross-project ML scheduling; multi-tenant resource quotas beyond `worker_slots`; full undo/branching of the graph.

### 11.2 Tradeoffs, risks & mitigations

**Strengths.** Maximum durability/resumability (only state is Postgres; runner disposable). Trivially-correct concurrency (`SKIP LOCKED` + three composing caps). Auditability for free (`run_events` + versioned `task_outputs` + `agent_runs` are an append-only ledger). The scheduler is genuinely thin — all graph logic is declarative SQL. Context flow == edges, eliminating the "downstream agent forgot the palette" bug.

| Risk | Mitigation |
|---|---|
| **Planner quality is the ceiling** (bad edges / missing branding dep silently degrade output) | Validator: cycle check + branding-ancestor lint + context-reference cross-check; one revision loop; human-editable graph before `running`; re-plan on `blocked`. |
| **Trigger logic is "invisible" business logic** | Keep triggers tiny (only graph mechanics + brand-kit sync); never put agent decisions in SQL; the `v_ready_tasks` view documents the rule and is the reconcile safety net. |
| **Polling latency between waves** | `LISTEN/NOTIFY` on `task_unblocked` as accelerator; polling remains the safety net. |
| **Context-window bloat at deep fan-in** | Concrete tiered budget §6.2 (full / summary / reference + artifacts by ref + hard token cap). |
| **At-least-once dispatch → duplicate side effects** | `side_effects` ledger + stable `effect_key` + provider idempotency keys + outbox option (§6.5). |
| **False reclaim of long agent runs** | Per-department tuned `lease_seconds` + owner-scoped heartbeat renewal at TTL/3 (§8.1). |
| **Wrong autonomous assumption** | Conservative archetype defaults; every assumption recorded in `params.assumptions[]` and shown in the end-of-run report; re-run with a fuller brief to override. |
| **Cost runaway** | `budget_ledger` + pre-flight `reserve_budget` + `budget_usd` ceiling → `paused`; per-department cost queries (§8.6). |
| **Cycle introduced by dynamic growth / re-plan** | Single canonical `fn_would_create_cycle` invoked on **every** structural mutation; offending edge rejected + logged (§3.4, §8.4–8.5). |
| **Malformed / wrong agent output poisons downstream** | The `tasks.verify` check must pass before a task reaches `done`; failure → retry with the log injected. Downstream never consumes unverified output (§6.4). |
| **Cross-project resource contention** | `worker_slots` global semaphore composing with per-project and per-department caps (§5.2). |
| **Departments can't negotiate** (real agencies push back) | Disagreement surfaces as a **failed `verify` + re-plan**, plus `proposed_tasks` for emergent work; accepted simplification — the board is a conveyor, the verify harness is the reconciliation point. |

### 11.3 Open questions for the team

1. **Reviewer identity model** — exact RLS roles/claims for who may approve which departments (per-project reviewers vs. account-level)?
2. **Cost estimation accuracy** — is `cost_per_run_estimate` + context-size factor enough for `reserve_budget`, or do we need a learned per-department model after N runs?
3. **Artifact storage lifecycle** — retention/GC policy for superseded (`is_current=false`) outputs and orphaned Storage objects on `cancelled` subtrees.
4. **Multi-runner global semaphore** — do we need `worker_slots` in v1 (single runner suffices) or only when horizontal scale is required?
5. **Re-plan UX** — is additive-only re-plan sufficient, or do clients need interactive graph editing (drag an edge, prune a branch) before `running`?
6. **Archetype templates** — how many project archetypes (delivery app, WordPress site, Shopify store…) get hard-coded required-slot lists vs. a generic "ask until you can plan" loop?

---

*End of specification. The buildable core is the DDL (§2) + the unblock/seed/brand-kit triggers and `v_ready_tasks` (§3, §7) + the claim/heartbeat/dispatch loop (§5, §8.1) + the planner-validator (§4). Everything else layers on the same schema without rework.*

---

## 12. Locked Decisions (v2) — finalized, autonomous, generic

These resolve every open item with a decided default. **The system runs a brief to completion on its own — no human in the loop, no project-specific assumptions.**

**D1 · Output = real artifacts, not specs.** Each agent returns a **runnable artifact as text** (a fenced code block / file body). The **runner** — not the agent — writes it into the project workspace and runs the check. Pure-judgment tasks (e.g. stack choice) return a decision, still machine-sanity-checked (parses, names a supported stack). This keeps agents "just an API call" while producing real output and keeping verification deterministic.

**D2 · Granularity = one checkable artifact per task.** A big surface (a frontend) is decomposed by the planner to **one file/screen per task**, each independently verifiable. No multi-file mega-tasks in v1; no tool-using workspace agents yet (that's a later upgrade, behind the same contract).

**D3 · Verifier per department (all automated, run in a sandbox):**
| Dept | Artifact | Check (deterministic) |
|---|---|---|
| research | facts file | parses; required fields present; links resolve |
| branding | brand tokens (JSON/CSS vars) | tokens valid; WCAG AA contrast; the first component using them builds |
| stack | decision | parses; names a supported stack from the archetype registry |
| database | `schema.sql` | applies on a throwaway Postgres; expected tables exist |
| auth | auth module/config | builds; `tsc` clean; auth smoke test passes |
| frontend | component/screen file | `build` + `tsc --noEmit` exit 0; route renders headless |
| media | assets | files exist; count ≥ N; dimensions/format valid |
| content | strings file | parses; key coverage; length/lang assertions |
| integration | wired code | build + smoke (mock keys); env keys declared |
| deploy | live URL | `curl -sf` returns 200; healthcheck route OK |

**D4 · Taste has no human gate.** Subjective quality is pinned to **objective proxies** (valid tokens, contrast, "the build that consumes it passes"). An **independent** critic call may *fail* a task, but can never be the sole reason it *passes*, and is cross-checked against the proxies. No `needs_review`, no approval rows.

**D5 · Planner = autonomous.** Generic decomposition with optional **archetype templates** (each archetype = a registry entry declaring its stack + the per-task verify commands; "delivery app", "marketing site", "store" are data, not code). Missing brief details are **assumed with sensible defaults and recorded in `projects.params`** — the planner never stops to ask. Validator lints: acyclic, branding-ancestor for any visual task, and **every task has an automated `verify` rule** (a task without one is rejected at plan time).

**D6 · Re-planning = autonomous.** An agent may emit `proposed_tasks`; the planner re-validates and inserts them, running the cycle check on every structural mutation. No human review of the new graph.

**D7 · Workspace & storage.** Per-project **git repo** as the artifact workspace; **Supabase Storage** for binaries. `task_outputs.content` holds the artifact text *or* a path/URL to it. Everything else (graph, status, events) stays in Postgres — still the single source of truth, still restart-safe.

**D8 · Operator touchpoints (outside the loop).** Exactly two: the **brief in**, and an **end-of-run notification** with the result and a link to the workspace/board. The operator is never a dependency of the running graph.

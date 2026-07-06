-- Agency pipeline — the engine. Postgres is the single source of truth.
-- Re-runnable: drops and recreates everything.

drop trigger if exists trg_unblock on tasks;
drop function if exists fn_unblock() cascade;
drop view if exists v_ready_tasks;
drop table if exists run_events cascade;
drop table if exists task_outputs cascade;
drop table if exists task_dependencies cascade;
drop table if exists tasks cascade;
drop table if exists projects cascade;
drop type if exists task_status cascade;

create type task_status as enum ('blocked','ready','running','verifying','done','failed');

create table projects (
  id         uuid primary key default gen_random_uuid(),
  brief      text not null,
  params     jsonb not null default '{}'::jsonb,
  status     text not null default 'running',
  created_at timestamptz not null default now()
);

create table tasks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  seq          int  not null,
  title        text not null,
  department   text not null,
  status       task_status not null default 'blocked',
  verify       text not null default 'nonempty',  -- the automated check that must pass for status -> done
  artifact     text,                              -- if set, the agent's output is written to sites/<project>/<artifact>
  attempts     int  not null default 0,
  max_attempts int  not null default 3,
  claimed_by   text,
  lease_expires_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table task_dependencies (
  upstream_id   uuid not null references tasks(id) on delete cascade,
  downstream_id uuid not null references tasks(id) on delete cascade,
  primary key (upstream_id, downstream_id)
);

create table task_outputs (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  attempt    int  not null,
  content    text not null,                 -- the agent's raw output (trusted only after verify)
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index task_outputs_current_ux on task_outputs(task_id) where is_current;

create table run_events (
  id         bigserial primary key,
  project_id uuid,
  task_id    uuid,
  type       text not null,
  detail     text,
  at         timestamptz not null default now()
);

-- A task is READY when it is blocked and has zero upstreams that aren't done.
create view v_ready_tasks as
select t.*
from tasks t
where t.status = 'blocked'
  and not exists (
    select 1 from task_dependencies d
    join tasks u on u.id = d.upstream_id
    where d.downstream_id = t.id and u.status <> 'done'
  );

-- The unblock rule, in SQL: the instant a task hits 'done', promote any downstream
-- whose upstreams are now all 'done' from blocked -> ready. The scheduler holds no graph logic.
create function fn_unblock() returns trigger as $$
begin
  if NEW.status = 'done' and OLD.status is distinct from 'done' then
    update tasks t set status = 'ready', updated_at = now()
    where t.status = 'blocked'
      and exists (select 1 from task_dependencies d
                  where d.downstream_id = t.id and d.upstream_id = NEW.id)
      and not exists (select 1 from task_dependencies d2
                      join tasks u on u.id = d2.upstream_id
                      where d2.downstream_id = t.id and u.status <> 'done');
    insert into run_events(project_id, task_id, type, detail)
    select NEW.project_id, d.downstream_id, 'task_unblocked', 'by #'||NEW.seq
    from task_dependencies d join tasks t on t.id = d.downstream_id
    where d.upstream_id = NEW.id and t.status = 'ready';
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger trg_unblock after update on tasks
for each row execute function fn_unblock();

-- ===== CMS (roadmap 08): per-page editable snapshot + blocks =====
create table if not exists page_snapshots (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  slug        text not null,
  artifact    text not null,
  src_html    text not null,
  state       text not null default 'live',
  log         text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, slug)
);
create table if not exists page_blocks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  slug        text not null,
  block_id    text not null,
  kind        text not null,
  label       text not null default '',
  seq         int  not null default 0,
  published   text not null default '',
  draft       text,
  read_only   boolean not null default false,
  updated_at  timestamptz not null default now(),
  unique (project_id, slug, block_id)
);
create index if not exists page_blocks_page_ix on page_blocks(project_id, slug, seq);
alter table tasks add column if not exists source text;
alter table page_blocks add column if not exists dirty boolean not null default false;
create table if not exists qa_reviews (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  slug        text not null,
  viewport    text not null,
  score       int  not null default 0,
  issues      jsonb not null default '[]',
  shot        text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists qa_reviews_proj_ix on qa_reviews(project_id);
create unique index if not exists qa_reviews_uk on qa_reviews(project_id,slug,viewport);
create table if not exists site_submissions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  form        text not null default 'contact',
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists site_submissions_proj on site_submissions(project_id, created_at desc);

-- interaction review (dogfood): a real browser used the site — structured issues + verdict, per project
create table if not exists dogfood_reviews (
  id          bigserial primary key,
  project_id  uuid,
  passed      boolean not null default false,
  summary     text,
  issues      jsonb not null default '[]'::jsonb,
  checked     jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);
create index if not exists dogfood_reviews_proj on dogfood_reviews(project_id, at desc);

-- spec_findings: dogfood captures for the (inactive) evolver. Pure capture, no automation yet.
create table if not exists spec_findings (
  id bigserial primary key,
  project_id uuid not null references projects(id) on delete cascade,
  finding text not null,
  selector text,
  screenshot_path text,
  created_at timestamptz not null default now()
);
create index if not exists spec_findings_project_idx on spec_findings(project_id, created_at desc);

-- ===== ARC A: billing ledger (prepaid credits / quota) =====
-- APPEND-ONLY: no UPDATE or DELETE may ever run on this table (source-pinned in billing:check).
-- Sign invariant enforced by CHECK: debits negative, grants/adjusts non-negative.
create table if not exists billing_ledger (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references users(id) on delete cascade,
  kind         text        not null check (kind in ('grant','debit','adjust')),
  amount_cents int         not null
                           check ((kind = 'debit'  and amount_cents <  0)
                               or (kind <> 'debit' and amount_cents >= 0)),
  reason       text        not null,
  project_id   uuid,
  created_at   timestamptz not null default now()
);
-- ONE grant per user enforced at the index layer.
create unique index if not exists billing_one_grant
  on billing_ledger(user_id) where kind = 'grant';
-- Fast balance queries and per-user history.
create index if not exists billing_ledger_user_idx on billing_ledger(user_id, created_at desc);

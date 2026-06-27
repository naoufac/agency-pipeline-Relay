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

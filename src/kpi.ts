import pg from 'pg';
import * as appdb from './appdb.ts';

export type Kpi = { key: string; label: string; value: string; sub: string; group: 'quality' | 'efficiency' | 'signal'; tone: 'good' | 'warn' | 'bad' | 'neutral' };

// ─── FUNNEL KPI (ARC E Part 2) ────────────────────────────────────────────────
// Operator-level demand funnel with QA noise filtered OUT.
// The database is full of QA probes and test fixtures — measuring those inflates every
// metric.  Every filter is a deterministic string check, never an LLM judgment.
//
// NOISE FILTERS:
//   users:        skip emails matching /@(example|test)\./ and the RELAY_OPERATOR_EMAIL
//   site_submissions: skip payloads containing 'QA Test', 'Automated QA',
//                 emails under example/test/naples.agency domains
//
// These filters are applied inside Postgres (WHERE clauses) for efficiency.
//
export type Funnel = {
  users_total:        number;   // all user rows
  users_real:         number;   // non-QA users
  leads_total:        number;   // all site_submissions
  leads_real:         number;   // non-QA submissions
  projects_total:     number;   // all project rows
  credits_granted_cents: number; // sum of 'grant' ledger rows
  credits_spent_cents:   number; // sum of 'debit' ledger rows (stored as negative, returned as positive)
  active_paying_users:   number; // users who have at least one debit row in billing_ledger
};

// operatorEmail: the operator address that is excluded from "real" user counts.
// Defaults to the env var or the hard-coded bootstrap value — same logic as billing.ts.
function operatorEmail(): string {
  return (process.env.RELAY_OPERATOR_EMAIL || 'nchobah@gmail.com').toLowerCase().trim();
}

export async function funnel(pool: pg.Pool): Promise<Funnel> {
  const op = operatorEmail();

  // users ----------------------------------------------------------------
  // We guard against missing tables (billing may not be deployed yet) with try/catch.
  let users_total = 0, users_real = 0;
  try {
    const ut = await pool.query(`select count(*)::int n from users`);
    users_total = Number(ut.rows[0].n);
    // "real" = not an example/test email, not the operator
    const ur = await pool.query(`
      select count(*)::int n from users
      where email not ilike '%@example.%'
        and email not ilike '%@test.%'
        and lower(email) <> $1`, [op]);
    users_real = Number(ur.rows[0].n);
  } catch {}  // users table may not exist in a fresh test DB

  // leads / site_submissions --------------------------------------------
  let leads_total = 0, leads_real = 0;
  try {
    const lt = await pool.query(`select count(*)::int n from site_submissions`);
    leads_total = Number(lt.rows[0].n);
    // Filter out QA noise: submissions carrying known QA markers, or from test domains.
    // The column is `data jsonb` (schema.sql — NOT `payload`; that bug made this silently 0).
    // NOTE the parentheses around the email alternatives: without them AND/OR precedence lets
    // any row WITH an email bypass the QA-marker filters entirely.
    const lr = await pool.query(`
      select count(*)::int n from site_submissions
      where data::text not ilike '%QA Test%'
        and data::text not ilike '%Automated QA%'
        and (
              (data->>'email') is null
           or (
                (data->>'email') not ilike '%@example.%'
            and (data->>'email') not ilike '%@test.%'
            and (data->>'email') not ilike '%@naples.agency'
           )
        )`);
    leads_real = Number(lr.rows[0].n);
  } catch {}  // table may not exist

  // projects -------------------------------------------------------------
  let projects_total = 0;
  try {
    const pt = await pool.query(`select count(*)::int n from projects`);
    projects_total = Number(pt.rows[0].n);
  } catch {}

  // billing ledger -------------------------------------------------------
  let credits_granted_cents = 0, credits_spent_cents = 0, active_paying_users = 0;
  try {
    const bg = await pool.query(`select coalesce(sum(amount_cents),0)::int n from billing_ledger where kind='grant'`);
    credits_granted_cents = Number(bg.rows[0].n);
    const bs = await pool.query(`select coalesce(abs(sum(amount_cents)),0)::int n from billing_ledger where kind='debit'`);
    credits_spent_cents = Number(bs.rows[0].n);
    const ap = await pool.query(`select count(distinct user_id)::int n from billing_ledger where kind='debit'`);
    active_paying_users = Number(ap.rows[0].n);
  } catch {}  // billing_ledger may not be deployed yet

  return { users_total, users_real, leads_total, leads_real, projects_total, credits_granted_cents, credits_spent_cents, active_paying_users };
}

// funnelToKpis: convert a Funnel into the standard Kpi[] format for embedding in computeKpi responses.
export function funnelToKpis(f: Funnel): Kpi[] {
  const pct = (n: number, d: number) => d ? Math.round(100 * n / d) + '%' : '—';
  return [
    { group: 'signal', key: 'funnel_users',    label: 'Real users',     value: String(f.users_real),    sub: `${f.users_total} total · ${pct(f.users_real, f.users_total)} non-QA`,                         tone: f.users_real > 0 ? 'good' : 'neutral' },
    { group: 'signal', key: 'funnel_leads',    label: 'Real leads',     value: String(f.leads_real),    sub: `${f.leads_total} total submissions · ${pct(f.leads_real, f.leads_total)} non-QA`,              tone: f.leads_real > 0 ? 'good' : 'neutral' },
    { group: 'signal', key: 'funnel_projects', label: 'Projects',       value: String(f.projects_total), sub: 'all builds ever started',                                                                      tone: 'neutral' },
    { group: 'signal', key: 'funnel_credits',  label: 'Credits ($)',    value: '$' + (f.credits_spent_cents / 100).toFixed(2) + ' spent', sub: `$${(f.credits_granted_cents / 100).toFixed(2)} granted · ${f.active_paying_users} paying user(s)`, tone: f.active_paying_users > 0 ? 'good' : 'neutral' },
  ];
}

// ─── T34 · PERFORMANCE PANEL (operator-only) ──────────────────────────────────
// Deliverable mix (count per deliverable type) + build-time distribution
// (mean build_seconds) across all done projects.
//
// WHY here (not server.ts): kpi.ts owns aggregate reporting; server.ts strips
// the key for non-operators using the same pattern as the funnel key.
//
// Returns null on an empty DB — the UI stays silent rather than showing zeroes.
export type PerfPanel = {
  mix: { deliverable: string; count: number }[];   // sorted descending
  avg_build_seconds: number | null;                 // mean build_seconds where present
  p50_build_seconds: number | null;                 // median
};

export async function perfPanel(pool: pg.Pool): Promise<PerfPanel | null> {
  // deliverable mix: count per deliverable id from params (done or not — shows the full library)
  let mix: { deliverable: string; count: number }[] = [];
  try {
    const mr = await pool.query(`
      select coalesce(params->>'deliverable','unknown') as deliverable,
             count(*)::int as count
      from projects
      where params->>'deliverable' is not null
      group by 1 order by 2 desc`);
    mix = mr.rows.map((r: any) => ({ deliverable: String(r.deliverable), count: Number(r.count) }));
  } catch {}

  // build-time distribution from params.build_seconds (explicit, persisted by planner)
  // or derived from task timestamps (same derivation as boardJSON) — prefer explicit.
  let avg_build_seconds: number | null = null;
  let p50_build_seconds: number | null = null;
  try {
    const tr = await pool.query(`
      select
        round(avg(b))::int as avg_s,
        percentile_cont(0.5) within group (order by b)::int as p50_s
      from (
        select coalesce(
          (params->>'build_seconds')::float,
          extract(epoch from (max(t.updated_at) - p.created_at))::float
        ) as b
        from projects p
        join tasks t on t.project_id = p.id and t.status = 'done'
        where p.status = 'done'
        group by p.id, p.created_at, p.params
        having count(t.id) > 0
      ) secs
      where b > 0`);
    const row = tr.rows[0];
    if (row && row.avg_s != null) avg_build_seconds = Number(row.avg_s);
    if (row && row.p50_s != null) p50_build_seconds = Number(row.p50_s);
  } catch {}

  if (!mix.length && avg_build_seconds == null) return null;
  return { mix, avg_build_seconds, p50_build_seconds };
}

// deliverableMixCounts: a focused helper used by digest.ts to get deliverable counts
// without the full PerfPanel overhead (QA-noise-safe: counts from params, not LLM output).
// Returns a map of deliverable→count for all projects, or empty object on DB error.
export async function deliverableMixCounts(pool: pg.Pool): Promise<Record<string, number>> {
  try {
    const r = await pool.query(`
      select coalesce(params->>'deliverable','unknown') as deliverable,
             count(*)::int as count
      from projects
      where params->>'deliverable' is not null
      group by 1 order by 2 desc`);
    return Object.fromEntries(r.rows.map((row: any) => [String(row.deliverable), Number(row.count)]));
  } catch { return {}; }
}

// avgBuildSeconds: mean build_seconds across all done projects — for digest.
export async function avgBuildSeconds(pool: pg.Pool): Promise<number | null> {
  try {
    const r = await pool.query(`
      select round(avg(b))::int as avg_s from (
        select coalesce(
          (params->>'build_seconds')::float,
          extract(epoch from (max(t.updated_at) - p.created_at))::float
        ) as b
        from projects p
        join tasks t on t.project_id = p.id and t.status = 'done'
        where p.status = 'done'
        group by p.id, p.created_at, p.params
        having count(t.id) > 0
      ) secs where b > 0`);
    const v = r.rows[0]?.avg_s;
    return v != null ? Number(v) : null;
  } catch { return null; }
}

// One source of truth for KPIs — used by the API (/api/kpi) and the CLI.
export async function computeKpi(pool: pg.Pool, projectId?: string) {
  const p = (await pool.query(
    projectId ? 'select * from projects where id=$1' : 'select * from projects order by created_at desc limit 1',
    projectId ? [projectId] : [])).rows[0];
  if (!p) return null;

  const tasks = (await pool.query('select * from tasks where project_id=$1 order by seq', [p.id])).rows;
  const edges = (await pool.query(
    `select us.seq f, ds.seq t from task_dependencies d
     join tasks us on us.id=d.upstream_id join tasks ds on ds.id=d.downstream_id where us.project_id=$1`, [p.id])).rows;
  const ev = (await pool.query('select type, count(*)::int n from run_events where project_id=$1 group by type', [p.id]))
    .rows.reduce((a: any, r: any) => (a[r.type] = r.n, a), {});
  const outs = (await pool.query(
    'select length(content) len from task_outputs o where is_current and exists (select 1 from tasks t where t.id=o.task_id and t.project_id=$1)', [p.id])).rows;

  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const active = tasks.filter(t => ['ready', 'running', 'verifying'].includes(t.status)).length;
  const attempts = tasks.reduce((s, t) => s + t.attempts, 0);
  const firstPass = tasks.filter(t => t.status === 'done' && t.attempts <= 1).length;
  const last = tasks.reduce((m, t) => Math.max(m, +new Date(t.updated_at)), 0);
  const wall = Math.max(0, (last - +new Date(p.created_at)) / 1000);

  const succ: any = {}; tasks.forEach(t => succ[t.seq] = []); edges.forEach((e: any) => succ[e.f].push(e.t));
  const memo: any = {}; const lp = (s: number): number => memo[s] ?? (memo[s] = 1 + (succ[s].length ? Math.max(...succ[s].map(lp)) : 0));
  const critical = total ? Math.max(...tasks.map(t => lp(t.seq))) : 0;
  // honest: only genuinely deterministic checks the agent can't fake count toward rigor
  const realCheck = tasks.filter(t => ['sql_applies', 'app_db', 'site_renders', 'site_consistent', 'wcag'].includes(t.verify) || (t.verify || '').startsWith('json')).length;
  const chars = outs.reduce((s, o) => s + (o.len || 0), 0);
  const errors = ev['agent_error'] || 0, reworks = ev['verify_failed'] || 0;
  const finished = active === 0 && blocked === 0;
  const deadlocked = active === 0 && blocked > 0;   // nothing can move but work remains -> NOT 'running'
  const pct = (n: number, d: number) => d ? Math.round(100 * n / d) : 0;
  const rigor = pct(realCheck, total);

  // A/B instrumentation (Task 10): provider split + latency across ALL projects over the last 7 days, read from
  // the per-call meta the runner writes to run_events (type='llm_call'). detail is TEXT, so cast ::jsonb; the
  // timestamp column is `at` (not created_at). Global (no project filter) — this settles the openrouter A/B.
  const providers = (await pool.query(
    `select detail::jsonb->>'provider' as p, count(*) n,
            round(avg((detail::jsonb->>'latencyMs')::int))::int avg_ms
     from run_events where type='llm_call' and at > now() - interval '7 days'
     group by 1 order by n desc`)).rows;
  const provTotal = providers.reduce((s: number, p: any) => s + Number(p.n), 0) || 1;

  // OWNER-FIRST METRICS (audited 2026-07-02): every number is verifiable against the DB and answers
  // a question a site owner actually has. Engineering telemetry (parallelism, critical-path latency,
  // LLM provider split) left the board — providers stay in the payload for the CLI/ops only.
  const pagesVerified = tasks.filter(t => t.verify === 'site_renders' && t.status === 'done').length;
  const pagesPlanned = tasks.filter(t => t.verify === 'site_renders').length;
  const review = (await pool.query('select passed, checked from dogfood_reviews where project_id=$1 order by id desc limit 1', [p.id])).rows[0];
  const formsChecked = review?.checked?.forms ?? null;
  const cmsBuilt = !!(p.params && p.params.cms_built);
  const leads = Number((await pool.query('select count(*)::int n from site_submissions where project_id=$1', [p.id])).rows[0].n);
  let dataRows = 0;
  try { for (const t of (await appdb.describeSchema(pool, p.id)).tables) dataRows += Number(t.rows || 0); } catch {}
  const rebuilds = Number(p.params?.rebuilds || 0);
  const mins = wall >= 60 ? `${Math.floor(wall / 60)}m ${Math.round(wall % 60)}s` : `${wall.toFixed(0)}s`;

  const kpis: Kpi[] = [
    { group: 'quality', key: 'live', label: 'Site status',
      value: deadlocked ? 'Blocked' : !finished ? 'Building' : failed ? 'Finished (issues)' : 'Live',
      sub: cmsBuilt ? 'served live from the CMS (proven)' : 'static serving',
      tone: deadlocked ? 'bad' : !finished ? 'warn' : failed ? 'warn' : 'good' },
    { group: 'quality', key: 'pages', label: 'Pages verified',
      value: `${pagesVerified}/${pagesPlanned || '—'}`, sub: 'each passed the render + consistency gates',
      tone: pagesPlanned && pagesVerified === pagesPlanned ? 'good' : 'warn' },
    { group: 'quality', key: 'review', label: 'Browser review',
      value: review ? (review.passed ? 'Passed' : 'Issues found') : '—',
      sub: review ? `a real browser clicked every button${formsChecked ? ` · ${formsChecked} form(s) submitted + persisted` : ''}` : 'runs when the build finishes',
      tone: review ? (review.passed ? 'good' : 'bad') : 'neutral' },
    { group: 'signal', key: 'data', label: 'Data collected',
      value: String(leads + dataRows), sub: `${leads} form submission(s) · ${dataRows} database row(s)`,
      tone: 'neutral' },
    { group: 'efficiency', key: 'wall', label: 'Build time',
      value: mins, sub: rebuilds ? `rebuilt ${rebuilds}× — data preserved` : 'brief to live, zero humans',
      tone: 'neutral' },
    { group: 'quality', key: 'firstpass', label: 'Right first try',
      value: pct(firstPass, done || 1) + '%', sub: `${firstPass}/${done} steps passed without a retry`,
      tone: deadlocked ? 'bad' : (firstPass === done ? 'good' : 'warn') },
    { group: 'signal', key: 'rigor', label: 'Independently checked',
      value: rigor + '%', sub: `${realCheck}/${total} steps proven by an external check, not the AI's word`,
      tone: rigor >= 60 ? 'good' : rigor >= 40 ? 'warn' : 'bad' },
  ];

  // ARC E Part 2: include the operator-level demand funnel in every KPI response.
  // This is a pool-wide aggregate (no project filter) — same data regardless of which project is queried.
  const funnelData = await funnel(pool);

  // T34: perf panel — deliverable mix + build-time distribution. Operator-only (stripped
  // in server.ts alongside the funnel key). Pool-wide aggregate like funnel.
  const perfData = await perfPanel(pool);

  return {
    project: { id: p.id, brief: p.brief, created_at: p.created_at },
    status: deadlocked ? 'blocked' : (!finished ? 'running' : (failed ? 'complete_with_failures' : 'complete')),
    totals: { total, done, active, blocked, failed },
    chars,
    kpis,
    funnel: funnelData,    // demand funnel with QA noise filtered — for the operator / CLI
    perf: perfData,         // T34: deliverable mix + build-time distribution — operator-only
    providers,   // ops-only telemetry (CLI); the board does not render this
  };
}

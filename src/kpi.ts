import pg from 'pg';

export type Kpi = { key: string; label: string; value: string; sub: string; group: 'quality' | 'efficiency' | 'signal'; tone: 'good' | 'warn' | 'bad' | 'neutral' };

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

  const kpis: Kpi[] = [
    { group: 'quality',    key: 'completion',  label: 'Completion',        value: pct(done, total) + '%', sub: `${done}/${total} shipped`,             tone: done === total && total ? 'good' : failed ? 'bad' : 'warn' },
    { group: 'quality',    key: 'firstpass',   label: 'First-pass verify', value: pct(firstPass, done || 1) + '%', sub: `${firstPass}/${done} no retry`, tone: deadlocked ? 'bad' : (firstPass === done ? 'good' : 'warn') },
    { group: 'quality',    key: 'rework',      label: 'Rework rate',       value: (reworks / (total || 1)).toFixed(2), sub: `${reworks} verify-fails`,   tone: reworks === 0 ? 'good' : 'warn' },
    { group: 'efficiency', key: 'wall',        label: 'Wall-clock',        value: wall.toFixed(0) + 's', sub: (done / (wall / 60 || 1)).toFixed(1) + ' tasks/min', tone: 'neutral' },
    { group: 'efficiency', key: 'latency',     label: 'Latency / layer',   value: critical ? (wall / critical).toFixed(0) + 's' : '—', sub: `${critical} layers`, tone: 'neutral' },
    { group: 'signal',     key: 'parallel',    label: 'Parallelism',       value: critical ? (total / critical).toFixed(2) + '×' : '—', sub: `${total}→${critical} layers`, tone: 'neutral' },
    { group: 'signal',     key: 'reliability', label: 'Agent reliability', value: pct(attempts - errors, attempts || 1) + '%', sub: `${errors} err / ${attempts} calls`, tone: deadlocked ? 'bad' : (errors === 0 ? 'good' : 'warn') },
    { group: 'signal',     key: 'rigor',       label: 'Verification rigor', value: rigor + '%', sub: `${realCheck}/${total} real checks`,                tone: rigor >= 60 ? 'good' : rigor >= 40 ? 'warn' : 'bad' },
  ];

  return {
    project: { id: p.id, brief: p.brief, created_at: p.created_at },
    status: deadlocked ? 'blocked' : (!finished ? 'running' : (failed ? 'complete_with_failures' : 'complete')),
    totals: { total, done, active, blocked, failed },
    chars,
    kpis,
  };
}

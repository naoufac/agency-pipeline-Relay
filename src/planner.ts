import pg from 'pg';

// MVP planner: a website-producing agency DAG that ends in a REAL, rendered, visitable site.
// (When ANTHROPIC/MINIMAX planning is added, this same {tasks, edges} shape is emitted from the brief.)
type TaskDef = { seq: number; title: string; department: string; verify: string; deps: number[]; artifact?: string };

const WEBSITE_GRAPH: TaskDef[] = [
  { seq: 1, title: 'Audience & positioning research', department: 'research', verify: 'nonempty',     deps: [] },
  { seq: 2, title: 'Brand system (tokens)',           department: 'branding', verify: 'contains:#',   deps: [1] },
  { seq: 3, title: 'Information architecture / sitemap', department: 'content', verify: 'nonempty',   deps: [1] },
  { seq: 4, title: 'Copywriting',                      department: 'content',  verify: 'nonempty',    deps: [2, 3] },
  { seq: 5, title: 'Imagery & art direction',         department: 'media',    verify: 'nonempty',    deps: [2] },
  { seq: 6, title: 'Build the website',               department: 'build',    verify: 'site_renders', deps: [2, 3, 4, 5], artifact: 'index.html' },
  { seq: 7, title: 'QA — acceptance (renders live)',  department: 'qa',       verify: 'site_renders', deps: [6] },
];

export async function plan(pool: pg.Pool, brief: string): Promise<string> {
  const params = { assumptions: ['format=single-page site', 'audience=inferred from brief'] };
  const p = await pool.query('insert into projects(brief, params) values ($1,$2) returning id', [brief, params]);
  const projectId: string = p.rows[0].id;

  const seqToId: Record<number, string> = {};
  for (const t of WEBSITE_GRAPH) {
    const r = await pool.query(
      'insert into tasks(project_id, seq, title, department, verify, artifact) values ($1,$2,$3,$4,$5,$6) returning id',
      [projectId, t.seq, t.title, t.department, t.verify, t.artifact ?? null]);
    seqToId[t.seq] = r.rows[0].id;
  }
  for (const t of WEBSITE_GRAPH) for (const d of t.deps) {
    await pool.query('insert into task_dependencies(upstream_id, downstream_id) values ($1,$2)', [seqToId[d], seqToId[t.seq]]);
  }
  await pool.query(
    `update tasks set status='ready' where project_id=$1 and status='blocked'
       and not exists (select 1 from task_dependencies d where d.downstream_id = tasks.id)`, [projectId]);
  await pool.query("insert into run_events(project_id, type, detail) values ($1,'planned',$2)", [projectId, `${WEBSITE_GRAPH.length} tasks`]);
  return projectId;
}

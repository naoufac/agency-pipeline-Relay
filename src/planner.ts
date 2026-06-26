import pg from 'pg';

// MVP planner: a deterministic, generic agency DAG. (When ANTHROPIC_API_KEY is set this
// is the one call we swap for an LLM that emits the same {tasks, edges} shape from the brief.)
type TaskDef = { seq: number; title: string; department: string; verify: string; deps: number[] };

const GENERIC_AGENCY_GRAPH: TaskDef[] = [
  { seq: 1,  title: 'Market & positioning research', department: 'research',    verify: 'nonempty',        deps: [] },
  { seq: 2,  title: 'Brand system (tokens)',          department: 'branding',    verify: 'contains:#',      deps: [1] },
  { seq: 3,  title: 'Stack / CMS decision',           department: 'stack',       verify: 'nonempty',        deps: [1] },
  { seq: 4,  title: 'Database schema',                department: 'database',    verify: 'sql_applies',     deps: [3] },
  { seq: 5,  title: 'Design system',                  department: 'design',      verify: 'nonempty',        deps: [2, 3] },
  { seq: 6,  title: 'Media & imagery',                department: 'media',       verify: 'nonempty',        deps: [2] },
  { seq: 7,  title: 'Copywriting',                     department: 'content',     verify: 'nonempty',        deps: [2] },
  { seq: 8,  title: 'Auth & accounts',                department: 'auth',        verify: 'nonempty',        deps: [2, 4] },
  { seq: 9,  title: 'Customer screens',               department: 'frontend',    verify: 'contains:screen', deps: [4, 5, 6, 8] },
  { seq: 10, title: 'Payments / maps integration',    department: 'integration', verify: 'nonempty',        deps: [4, 9] },
  { seq: 11, title: 'QA assembly & acceptance',       department: 'qa',          verify: 'contains:pass',   deps: [7, 9, 10] },
];

export async function plan(pool: pg.Pool, brief: string): Promise<string> {
  const params = { assumptions: ['country=global', 'positioning=mass-market', 'platform=web'] };
  const p = await pool.query('insert into projects(brief, params) values ($1,$2) returning id', [brief, params]);
  const projectId: string = p.rows[0].id;

  // two-pass insert: seq -> uuid, then edges
  const seqToId: Record<number, string> = {};
  for (const t of GENERIC_AGENCY_GRAPH) {
    const r = await pool.query(
      'insert into tasks(project_id, seq, title, department, verify) values ($1,$2,$3,$4,$5) returning id',
      [projectId, t.seq, t.title, t.department, t.verify]);
    seqToId[t.seq] = r.rows[0].id;
  }
  for (const t of GENERIC_AGENCY_GRAPH) {
    for (const d of t.deps) {
      await pool.query('insert into task_dependencies(upstream_id, downstream_id) values ($1,$2)', [seqToId[d], seqToId[t.seq]]);
    }
  }
  // seed: tasks with no upstream become ready immediately
  await pool.query(
    `update tasks set status='ready' where project_id=$1 and status='blocked'
       and not exists (select 1 from task_dependencies d where d.downstream_id = tasks.id)`, [projectId]);
  await pool.query("insert into run_events(project_id, type, detail) values ($1,'planned',$2)", [projectId, `${GENERIC_AGENCY_GRAPH.length} tasks`]);
  return projectId;
}

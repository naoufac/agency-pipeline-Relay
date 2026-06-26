import { readFileSync } from 'node:fs';
import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5439/agency';

export function makePool(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
}

// Apply the DDL (db/schema.sql) — drops + recreates the engine.
export async function applySchema(pool: pg.Pool): Promise<void> {
  const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export async function ev(pool: pg.Pool, projectId: string, taskId: string | null, type: string, detail = ''): Promise<void> {
  await pool.query('insert into run_events(project_id, task_id, type, detail) values ($1,$2,$3,$4)', [projectId, taskId, type, detail]);
}

export async function counts(pool: pg.Pool, projectId: string): Promise<Record<string, number>> {
  const r = await pool.query('select status, count(*)::int n from tasks where project_id=$1 group by status', [projectId]);
  const out: Record<string, number> = { blocked: 0, ready: 0, running: 0, verifying: 0, done: 0, failed: 0 };
  for (const row of r.rows) out[row.status] = row.n;
  return out;
}

export async function board(pool: pg.Pool, projectId: string): Promise<any[]> {
  const r = await pool.query(
    `select t.seq, t.title, t.department, t.status, t.verify,
            (select left(o.content,52) from task_outputs o where o.task_id=t.id and o.is_current) as output
     from tasks t where t.project_id=$1 order by t.seq`, [projectId]);
  return r.rows;
}

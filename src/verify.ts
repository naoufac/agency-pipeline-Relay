import pg from 'pg';

// Zero-trust completion: a deterministic check the agent cannot influence decides 'done'.
// Rules (MVP):
//   nonempty        -> output is non-empty
//   contains:<str>  -> output contains <str> (case-insensitive)
//   sql_applies     -> output is SQL that applies cleanly on a real Postgres (run in a tx, rolled back)
export async function verify(pool: pg.Pool, rule: string, content: string): Promise<{ ok: boolean; log: string }> {
  if (rule === 'nonempty') {
    const ok = content.trim().length > 0;
    return { ok, log: ok ? 'non-empty' : 'empty output' };
  }
  if (rule.startsWith('contains:')) {
    const needle = rule.slice('contains:'.length).toLowerCase();
    const ok = content.toLowerCase().includes(needle);
    return { ok, log: ok ? `contains "${needle}"` : `missing "${needle}"` };
  }
  if (rule === 'sql_applies') {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(content);     // really runs the DDL on Postgres...
      await c.query('rollback');  // ...then throws it away. Pass = it applied with no error.
      return { ok: true, log: 'sql applied cleanly (tx rolled back)' };
    } catch (e: any) {
      try { await c.query('rollback'); } catch {}
      return { ok: false, log: 'sql error: ' + (e?.message ?? String(e)) };
    } finally {
      c.release();
    }
  }
  return { ok: false, log: 'unknown verify rule: ' + rule };
}

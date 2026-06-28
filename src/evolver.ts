// STUB: reads spec_findings, logs a count. Wired but inactive.
// Future work: propose spec-schema changes, gate them locally, ship if metrics improve.
import pg from 'pg';
export async function evolverTick(pool: pg.Pool): Promise<void> {
  const r = await pool.query(
    "select count(*)::int n from spec_findings where created_at > now() - interval '7 days'"
  );
  console.log("[evolver] " + r.rows[0].n + " spec findings in last 7 days (inactive stub)");
}

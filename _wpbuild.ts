import { makePool } from './src/db.ts';
import { buildPlan, persistPlan } from './src/planner.ts';
import { runLoop } from './src/runner.ts';
async function main() {
  const pool = makePool();
  const brief = 'A food blog and magazine for a Naples trattoria — multi-author articles, recipes, a newsroom and an editorial section, on WordPress.';
  const built = await buildPlan(brief);
  console.log('DELIVERABLE', (built as any).orchestration?.deliverable, 'builder', (built as any).orchestration?.builder, 'stack', (built as any).orchestration?.stack);
  const { projectId } = await persistPlan(pool, brief, built);
  console.log('PROJECT', projectId);
  const r = await runLoop(pool, projectId, { review: true } as any);
  console.log('RUNLOOP', JSON.stringify(r));
  const p = (await pool.query('select params->>\'deliverable\' d, params->\'wp_provision\' wp, params->>\'slug\' slug from projects where id=$1', [projectId])).rows[0];
  console.log('RESULT deliverable=%s slug=%s wp=%s', p.d, p.slug, JSON.stringify(p.wp));
  await pool.end();
  process.exit(0);
}
main().catch(e => { console.error('ERR', e?.message ?? e); process.exit(1); });

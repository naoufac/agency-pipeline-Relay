// One-shot agency canary. Plans + runLoop ONE project. Does not flip RELAY_BUILD.
// Usage: tsx src/agency-canary.ts
import { makePool } from './db.ts';
import { buildPlan, persistPlan } from './planner.ts';
import { runLoop } from './runner.ts';

const BRIEF = process.env.AGENCY_BRIEF
  || 'A local ceramics studio in Naples. Wheel-throwing classes, weekend workshops, and a small shop of bowls and mugs. People book a class, not a shopping cart. Keep it a website with a real booking link placeholder until research finds the studio calendar. — agency canary 2026-09-05';

async function main() {
  const pool = makePool();
  const t0 = Date.now();
  console.log('agency-canary: planning…');
  const built = await buildPlan(BRIEF);
  const orch = built.orchestration;
  console.log('deliverable=', orch?.deliverable, 'builder=', orch?.builder, 'stack=', orch?.stack);
  console.log('tasks=', built.plan.tasks.length, 'pages=', built.plan.pages?.length);
  const { projectId } = await persistPlan(pool, BRIEF, built);
  console.log('projectId=', projectId);
  console.log('agency-canary: runLoop (this project only, RELAY_BUILD stays 0)…');
  const r = await runLoop(pool, projectId, { cap: 4, review: true, runnerId: 'agency-canary' });
  const secs = Math.round((Date.now() - t0) / 1000);
  const st = (await pool.query('select status, params from projects where id=$1', [projectId])).rows[0];
  const tasks = (await pool.query("select seq, department, status, verify from tasks where project_id=$1 order by seq", [projectId])).rows;
  console.log(JSON.stringify({
    projectId,
    stopped: r.stopped,
    steps: r.steps,
    secs,
    status: st?.status,
    deliverable: st?.params?.deliverable,
    builder: st?.params?.builder,
    cms_built: st?.params?.cms_built,
    astro_built: st?.params?.astro_built,
    app_built: st?.params?.app_built,
    slug: st?.params?.slug,
    tasks: tasks.map((t: any) => `${t.seq}:${t.department}=${t.status}`),
  }, null, 2));
  await pool.end();
  if (r.stopped !== 'complete' && st?.status !== 'done') process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });

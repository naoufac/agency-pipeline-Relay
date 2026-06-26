// Real entrypoint: plan a brief and run it to completion. `npm run run -- "your brief"`
import { makePool, applySchema, board } from './db.ts';
import { plan } from './planner.ts';
import { runLoop } from './runner.ts';

async function main() {
  const pool = makePool();
  if (process.env.RESET !== '0') await applySchema(pool);
  const brief = process.argv[2] || 'build a delivery app';
  const projectId = await plan(pool, brief);
  const res = await runLoop(pool, projectId, { cap: 4 });
  console.log(`project ${projectId}: ${res.stopped}`);
  for (const r of await board(pool, projectId)) {
    console.log(`#${String(r.seq).padStart(2)} ${r.status.padEnd(9)} ${r.department.padEnd(12)} ${r.title}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

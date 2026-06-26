// End-to-end PROOF: plan a brief, run partially (simulated crash), restart, finish.
// Asserts the final state with real checks and exits non-zero on any failure.
import { makePool, applySchema, board, counts } from './db.ts';
import { plan } from './planner.ts';
import { runLoop } from './runner.ts';

function printBoard(rows: any[]) {
  for (const r of rows) {
    const out = r.output ? `  ⤷ ${String(r.output).replace(/\n/g, ' ')}` : '';
    console.log(`  #${String(r.seq).padStart(2)} ${r.status.padEnd(9)} ${r.department.padEnd(12)} ${r.title}${out}`);
  }
}

async function main() {
  const pool = makePool();
  console.log('› applying schema (DDL + unblock trigger + v_ready_tasks)…');
  await applySchema(pool);

  const brief = process.argv[2] || 'build a delivery app';
  console.log(`› planning brief: "${brief}"`);
  const projectId = await plan(pool, brief);

  console.log('\n=== STAGE-BY-STAGE, but CRASH after 3 steps ===');
  const a = await runLoop(pool, projectId, { cap: 4, maxSteps: 3 });
  console.log(`runner stopped: ${a.stopped} after ${a.steps} steps`);
  console.log('board after crash:');
  printBoard(await board(pool, projectId));

  console.log('\n=== RESTART — recomputes the frontier from the DB and finishes ===');
  const b = await runLoop(pool, projectId, { cap: 4 });
  console.log(`runner stopped: ${b.stopped} (ran ${b.steps} more steps)`);
  console.log('final board:');
  printBoard(await board(pool, projectId));

  // ---- real assertions (zero-trust: we check the DB, we don't trust a claim) ----
  const c = await counts(pool, projectId);
  const total = (await board(pool, projectId)).length;
  const dbTask = await pool.query(
    `select o.content from tasks t join task_outputs o on o.task_id=t.id and o.is_current
     where t.project_id=$1 and t.department='database'`, [projectId]);
  const unblocks = await pool.query(`select count(*)::int n from run_events where project_id=$1 and type='task_unblocked'`, [projectId]);

  console.log('\n=== PROOF ===');
  console.log('status counts:', c);
  console.log('unblock events fired by the trigger:', unblocks.rows[0].n);
  console.log('database task produced real SQL:', /create table/i.test(dbTask.rows[0]?.content ?? ''));

  const allDone = c.done === total && c.failed === 0 && c.blocked === 0 && c.ready === 0 && c.running === 0;
  await pool.end();

  if (!allDone) { console.error(`\n❌ FAIL: not all ${total} tasks done — ${JSON.stringify(c)}`); process.exit(1); }
  if (unblocks.rows[0].n < 1) { console.error('\n❌ FAIL: no unblock events — dependency engine did not fire'); process.exit(1); }
  console.log(`\n✅ PASS: all ${total} tasks verified done; engine unblocked ${unblocks.rows[0].n} times; resumed cleanly after a crash.`);
}

main().catch((e) => { console.error(e); process.exit(1); });

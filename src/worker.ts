// src/worker.ts — standalone BUILD WORKER (the runner split, for scale). Claims unfinished projects from
// Postgres and runs the scheduler with a UNIQUE runnerId. Safe to run as several workers and/or alongside
// the API (FOR UPDATE SKIP LOCKED + leases prevent double-dispatch). Decouples build throughput from the
// web process — the 100→1000-user move.
//
// To flip the split on: set RELAY_BUILD=0 on the web server (it then only PLANS, never builds in-process)
// and run one or more workers (`npm run worker` / relay-worker.service). Default (no flag) is unchanged:
// the web server still builds, and the worker is simply extra capacity if you also start it.
import { makePool } from './db.ts';
import { runLoop } from './runner.ts';

const pool = makePool();
const RUNNER_ID = 'worker-' + process.pid;
const POLL_MS = Math.max(1000, Number(process.env.WORKER_POLL_MS || 3000));
const active = new Set<string>();   // projects this worker is already looping (don't double-spawn locally)

async function tick() {
  try {
    const r = await pool.query("select distinct project_id from tasks where status in ('ready','running','verifying','blocked')");
    for (const row of r.rows) {
      const id = row.project_id as string;
      if (active.has(id)) continue;
      active.add(id);
      runLoop(pool, id, { runnerId: RUNNER_ID, cap: 4, review: true })
        .catch(() => {})
        .finally(() => active.delete(id));
    }
  } catch (e: any) { console.error('worker tick error:', e?.message ?? e); }
}

console.log('relay build worker', RUNNER_ID, 'started (poll', POLL_MS + 'ms)');
tick();
setInterval(tick, POLL_MS).unref?.();
process.on('unhandledRejection', (e: any) => console.error('unhandledRejection', e?.message ?? e));

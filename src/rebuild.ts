// rebuild.ts — the ONE safe way to rebuild a project in place. Three surfaces trigger it (the
// dashboard Rebuild button, the Telegram door, and project chat); before this helper each did its
// own PLAN + HTML sweep + runLoop in a slightly different order, and two of them swept the live
// pages BEFORE planning. Two failure classes killed here (adversarial audit 2026-07-05):
//   • DESTRUCTION: sweeping HTML before the build is guaranteed to run — if planning throws or
//     builds are paused (RELAY_BUILD=0), the site is deleted with nothing to replace it.
//   • DOUBLE-SWEEP RACE: two concurrent triggers on one project both passed the busy-check and both
//     deleted pages, corrupting the in-flight build.
// The fix: a per-project in-memory lock serializes triggers; PLAN happens first and only a SUCCESSFUL
// plan earns the sweep; a paused build never sweeps. The lock releases when the build settles.
import pg from 'pg';
import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { replan } from './planner.ts';
import { runLoop } from './runner.ts';
import { SITES } from './verify.ts';

const REBUILDING = new Set<string>();
export const isRebuilding = (projectId: string): boolean => REBUILDING.has(projectId);

function sweepHtml(projectId: string): void {
  try {
    const dir = fileURLToPath(new URL(projectId + '/', SITES));
    for (const f of readdirSync(dir)) if (f.endsWith('.html')) rmSync(dir + '/' + f);
  } catch { /* no site dir yet — nothing to sweep */ }
}

// Rebuild the SAME project against `brief`. Returns started:false with a client-facing reason when it
// declines (locked, still building, or paused) — the caller decides how to surface that. The site's
// DATABASE and web address always survive; only the generated HTML is regenerated.
export async function startRebuild(pool: pg.Pool, projectId: string, brief: string): Promise<{ started: boolean; reason?: string }> {
  if (REBUILDING.has(projectId)) return { started: false, reason: 'a rebuild is already running' };
  const busy = Number((await pool.query(
    "select count(*)::int n from tasks where project_id=$1 and status in ('ready','running','verifying')", [projectId])).rows[0].n);
  if (busy) return { started: false, reason: 'the site is still building' };
  // builds paused — do NOT sweep; a swept-but-unbuilt project is a destroyed site
  if (process.env.RELAY_BUILD === '0') return { started: false, reason: 'builds are paused right now' };
  REBUILDING.add(projectId);
  try {
    await replan(pool, projectId, brief);
  } catch (e: any) {
    REBUILDING.delete(projectId);
    console.error('startRebuild plan failed', projectId, e?.message ?? e);
    return { started: false, reason: 'could not plan that change' };
  }
  // plan succeeded — NOW the stale pages can go; the build will regenerate them
  sweepHtml(projectId);
  runLoop(pool, projectId, { cap: 4, review: true }).catch(() => {}).finally(() => REBUILDING.delete(projectId));
  return { started: true };
}

import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ev, counts } from './db.ts';
import { runAgent, type Ctx } from './agents.ts';
import { verify, SITES } from './verify.ts';
import * as cms from './cms.ts';
import { reviewSite } from './qa.ts';
import { renderPage } from './render.ts';
import { processMedia } from './media.ts';

// parse the FIRST brace-balanced JSON object from the build agent's spec output
function firstSpec(s: string): any {
  const t = s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const a = t.indexOf('{'); if (a < 0) return null;
  let d = 0;
  for (let i = a; i < t.length; i++) {
    if (t[i] === '{') d++;
    else if (t[i] === '}') { if (--d === 0) { try { return JSON.parse(t.slice(a, i + 1)); } catch { return null; } } }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reclaim(pool: pg.Pool): Promise<number> {
  // resurrect crashed tasks in BOTH running and verifying (the slow render check lives in verifying)
  const r = await pool.query(
    `update tasks set status='ready', claimed_by=null, lease_expires_at=null, updated_at=now()
     where status in ('running','verifying') and lease_expires_at < now() returning id`);
  return r.rowCount ?? 0;
}

// safety-net reconcile using the documented readiness VIEW (makes v_ready_tasks load-bearing):
// promote any task whose upstreams are all done -> ready, even if the trigger ever missed it.
async function reconcile(pool: pg.Pool): Promise<void> {
  await pool.query("update tasks set status='ready', updated_at=now() where id in (select id from v_ready_tasks)");
}

async function claim(pool: pg.Pool, runnerId: string, cap: number): Promise<any[]> {
  const r = await pool.query(
    `update tasks set status='running', claimed_by=$1,
        lease_expires_at=now()+interval '240 seconds', attempts=attempts+1, updated_at=now()
     where id in (select id from tasks where status='ready' order by seq for update skip locked limit $2)
     returning *`, [runnerId, cap]);
  return r.rows;
}

async function buildContext(pool: pg.Pool, task: any): Promise<Ctx> {
  const proj = await pool.query('select brief, params from projects where id=$1', [task.project_id]);
  const ups = await pool.query(
    `select u.seq, u.department, coalesce(o.content,'') as content
     from task_dependencies d join tasks u on u.id=d.upstream_id
     left join task_outputs o on o.task_id=u.id and o.is_current
     where d.downstream_id=$1 order by u.seq`, [task.id]);
  // retry-with-feedback: on a re-attempt, tell the agent why its last try failed
  let feedback = '';
  if (task.attempts > 1) {
    const fb = await pool.query("select detail from run_events where task_id=$1 and type in ('verify_failed','agent_error') order by id desc limit 1", [task.id]);
    if (fb.rows[0]) feedback = fb.rows[0].detail;
  }
  const pages = (proj.rows[0].params && proj.rows[0].params.pages) || [];
  const self = task.artifact ? { title: task.title, slug: task.artifact.replace(/\.html$/, '') } : undefined;
  return { brief: proj.rows[0].brief, upstream: ups.rows, feedback, pages, self };
}

async function processTask(pool: pg.Pool, task: any, runnerId: string): Promise<void> {
  try {
    const ctx = await buildContext(pool, task);
    const content = await runAgent(task.department, ctx);     // the agent: text in -> text out (MiniMax or stub)

    await pool.query('update task_outputs set is_current=false where task_id=$1 and is_current', [task.id]);
    await pool.query('insert into task_outputs(task_id, attempt, content) values ($1,$2,$3)', [task.id, task.attempts, content]);

    // REAL ARTIFACT: write the page AND freeze its editable snapshot (post-media, with edit ids for the CMS)
    let snapshot: string | null = null;
    if (task.artifact) {
      const dir = new URL(task.project_id + '/', SITES);
      mkdirSync(fileURLToPath(dir), { recursive: true });
      // NEW ENGINE: the agent returns a SPEC; a deterministic renderer (vetted components) builds the page.
      const spec = firstSpec(content);
      if (!spec || !Array.isArray(spec.sections) || spec.sections.length < 2)
        throw new Error('build did not return a valid spec (need brand + >=2 sections)');
      const slug = task.artifact.replace(/\.html$/, '');
      const rendered = renderPage(spec, { pages: ctx.pages || [], slug, title: task.title, projectId: task.project_id });
      snapshot = cms.instrument(await processMedia(rendered, dir));      // real photos -> stamp edit ids for the CMS
      writeFileSync(fileURLToPath(new URL(task.artifact, dir)), cms.shipHtml(snapshot));  // shipHtml = strip edit ids; page is already complete
    }

    await pool.query("update tasks set status='verifying', updated_at=now() where id=$1", [task.id]);
    const { ok, log } = await verify(pool, task, content);   // deterministic check — not the agent's word
    if (ok) {
      await pool.query("update tasks set status='done', claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1", [task.id]);
      await ev(pool, task.project_id, task.id, 'task_done', `#${task.seq} ${task.department} [${task.verify}]`);
      // freeze the editable snapshot + blocks for the CMS (normal builds only, never a republish)
      if (snapshot && task.artifact && !task.source) {
        try { await cms.syncBlocks(pool, task.project_id, task.artifact.replace(/\.html$/, ''), task.artifact, snapshot); }
        catch (e: any) { console.error('cms syncBlocks', e?.message ?? e); }
      }
    } else {
      await ev(pool, task.project_id, task.id, 'verify_failed', `#${task.seq}: ${log}`);
      const next = task.attempts >= task.max_attempts ? 'failed' : 'ready';
      await pool.query(`update tasks set status=$2, claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1`, [task.id, next]);
    }
  } catch (e: any) {
    // agent/API error (e.g. MiniMax down): never crash the loop; retry, then fail.
    await ev(pool, task.project_id, task.id, 'agent_error', `#${task.seq}: ${(e?.message ?? String(e)).slice(0, 280)}`);
    const next = task.attempts >= task.max_attempts ? 'failed' : 'ready';
    await pool.query(`update tasks set status=$2, claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1`, [task.id, next]);
  }
}

// The whole scheduler: find ready -> run -> store -> verify -> unblock -> repeat.
// Stateless: everything it needs is recomputed from the DB, so it is restart-safe.
// maxSteps lets us simulate a crash mid-run to prove resumability.
export async function runLoop(
  pool: pg.Pool, projectId: string,
  opts: { runnerId?: string; cap?: number; maxSteps?: number } = {}
): Promise<{ stopped: string; steps: number }> {
  const runnerId = opts.runnerId ?? 'runner-1';
  const cap = opts.cap ?? 4;
  const maxSteps = opts.maxSteps ?? Infinity;
  let steps = 0;

  while (true) {
    await reclaim(pool);
    await reconcile(pool);
    const claimed = await claim(pool, runnerId, cap);
    if (claimed.length === 0) {
      const c = await counts(pool, projectId);
      if (c.running === 0 && c.ready === 0) break;  // complete, or deadlocked (blocked>0)
      await sleep(25);
      continue;
    }
    await Promise.all(claimed.map((t) => processTask(pool, t, runnerId)));
    steps += claimed.length;
    if (steps >= maxSteps) return { stopped: 'maxSteps', steps };
  }

  const c = await counts(pool, projectId);
  const done = (c.blocked + c.ready + c.running) === 0 && c.failed === 0;
  await pool.query('update projects set status=$2 where id=$1', [projectId, done ? 'done' : 'blocked']);
  if (done) reviewSite(pool, projectId).catch(() => {});   // auto visual-QA on completion (fire-and-forget)
  return { stopped: done ? 'complete' : 'blocked', steps };
}

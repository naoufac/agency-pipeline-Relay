import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ev, counts } from './db.ts';
import { runAgentTracked, type Ctx } from './agents.ts';
import { verify, SITES } from './verify.ts';
import * as cms from './cms.ts';
import { reviewSite } from './qa.ts';
import { dogfoodSite } from './dogfood.ts';
import { renderPage } from './render.ts';
import { normalizeSpec, normalizeContent, extractFirstJson, brandIdentity, applyBrand, resolveBrand } from './spec.ts';
import { processMedia } from './media.ts';
import * as appdb from './appdb.ts';

const stripFences = (s: string) => s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
// a real .sql deliverable: drop any prose preamble, keep from the first CREATE TABLE (mirrors sql_applies)
function sqlArtifact(content: string): string { const s = stripFences(content); const at = s.search(/create\s+table/i); return at >= 0 ? s.slice(at) : s; }

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
  const params = proj.rows[0].params || {};
  const pages = params.pages || [];
  const theme = params.theme;   // deterministic design language chosen by the planner (rooted in the brief)
  // SINGLE SOURCE OF TRUTH: the canonical site identity is locked into params.brand the moment Branding
  // passes (see processTask). For a build, read it. If it's somehow not set yet, derive it DETERMINISTICALLY
  // from the upstream branding output — resolveBrand() always returns a complete palette. NEVER the page spec.
  let brand = params.brand;
  if (!brand && task.department === 'build') {
    const bj = ups.rows.find((u: any) => u.department === 'branding');
    if (bj) brand = resolveBrand(bj.content, undefined, params.archetype);
  }
  const self = (task.department === 'build' && task.artifact) ? { title: task.title, slug: task.artifact.replace(/\.html$/, '') } : undefined;
  // the app's REAL provisioned tables + typed form-columns per table + the PRIMARY catalog table
  // (the main public list — products/listings/menu — so a collection reliably shows real data)
  let tables: string[] = []; const forms: Record<string, any[]> = {}; let primaryTable = '';
  if (task.department === 'build') {
    try {
      const desc = await appdb.describeSchema(pool, task.project_id);
      tables = desc.tables.map((t: any) => t.table);
      for (const t of tables) forms[t] = await appdb.formColumns(pool, task.project_id, t);
      const lookup = /contact|setting|config|admin|^users?$|account|auth|session|^tags?$|meta|_info$|^info$/i;
      const named = /product|listing|item|menu|post|article|service|event|propert|vehicle|\bcar\b|recipe|course|\bjob|maker|plant|book|dish|room|catalog|portfolio|gallery|review|member|deal|offer|spot|class|trip|tour/i;
      const cand = desc.tables.filter((t: any) => !lookup.test(t.table) && t.rows > 0).sort((a: any, b: any) => b.rows - a.rows);
      primaryTable = (cand.find((t: any) => named.test(t.table)) || cand[0] || desc.tables.filter((t: any) => t.rows > 0).sort((a: any, b: any) => b.rows - a.rows)[0] || { table: '' }).table;
    } catch {}
  }
  return { brief: proj.rows[0].brief, upstream: ups.rows, feedback, pages, self, theme, tables, forms, primaryTable, brand };
}

async function processTask(pool: pg.Pool, task: any, runnerId: string): Promise<void> {
  try {
    const ctx = await buildContext(pool, task);
    const result = await runAgentTracked(task.department, ctx);  // the agent: text in -> text + per-call meta out
    // A/B instrumentation (Task 10): record which provider/model served this call + latency, BEFORE anything else,
    // so even a failed call is captured. Then preserve the existing agent_error retry path by re-throwing on failure.
    await ev(pool, task.project_id, task.id, 'llm_call', JSON.stringify(result.meta));
    if (!result.meta.ok) throw new Error(result.meta.error || 'llm call failed');
    let content = result.text;

    // CONTENT-dept reliability gate (R3): the content role serves two shapes and the model sometimes emits
    // two concatenated blocks / braces-in-strings that the naive json verifier can't parse -> retries. Normalize
    // to ONE clean object BEFORE we store it (so downstream gets clean JSON) and before verify (so the json gate
    // sees a single re-serialized object), or REJECT the unfixable into the existing retry-with-feedback loop.
    if (task.department === 'content') {
      const r = normalizeContent(content);
      if (r.ok === false) throw new Error('content rejected: ' + r.errors.join('; '));
      for (const rep of r.repairs) console.error(`[content] ${task.project_id}: ${rep}`);
      content = JSON.stringify(r.spec);  // feed normalized JSON to next stage
    }

    await pool.query('update task_outputs set is_current=false where task_id=$1 and is_current', [task.id]);
    await pool.query('insert into task_outputs(task_id, attempt, content) values ($1,$2,$3)', [task.id, task.attempts, content]);

    // REAL ARTIFACT: write the page AND freeze its editable snapshot (post-media, with edit ids for the CMS)
    let snapshot: string | null = null;
    if (task.artifact) {
      const dir = new URL(task.project_id + '/', SITES);
      mkdirSync(fileURLToPath(dir), { recursive: true });
      if (task.artifact.endsWith('.html')) {
        // PAGE: the agent returns a SPEC; the BUILD-SPEC CONTRACT (src/spec.ts) validates/normalizes/repairs
        // it (or REJECTS the unfixable back into retry-with-feedback), then a deterministic renderer builds the page.
        const raw = extractFirstJson(content);
        const slug = task.artifact.replace(/\.html$/, '');
        const { spec, repairs, errors } = normalizeSpec(raw, { slug, tables: (ctx as any).tables, forms: (ctx as any).forms, primaryTable: (ctx as any).primaryTable });
        if (errors.length) throw new Error('build spec rejected: ' + errors.join('; '));
        if (repairs.length) console.error(`[spec] ${task.project_id}/${slug}: ${repairs.join(' · ')}`);
        // BRAND LOCK (deterministic, not a request to the model): the ONE site identity is already locked
        // into params.brand at branding-completion (and re-derived in buildContext as a backstop). FORCE it
        // onto this page — name, nav button AND palette — so the renderer can NEVER use the model's per-page
        // brand or colours. brandIdentity(spec) is only an absolute last resort if no canonical brand exists.
        const canon = (ctx as any).brand || brandIdentity(spec);
        await pool.query("update projects set params = jsonb_set(params, '{brand}', $2::jsonb, true) where id=$1 and (params->'brand') is null", [task.project_id, JSON.stringify(canon)]);
        applyBrand(spec, canon);
        // clean page <title>: the page's nav title (e.g. "Our Story"), NOT the internal task name ("Build the … page")
        const pageTitle = (((ctx.pages || []) as any[]).find((p) => p.slug === slug) || {}).title || task.title.replace(/^Build the\s+/i, '').replace(/\s+page$/i, '');
        const rendered = renderPage(spec, { pages: ctx.pages || [], slug, title: pageTitle, projectId: task.project_id, theme: ctx.theme, forms: (ctx as any).forms, primaryTable: (ctx as any).primaryTable });
        snapshot = cms.instrument(await processMedia(rendered, dir));      // real photos -> stamp edit ids for the CMS
        writeFileSync(fileURLToPath(new URL(task.artifact, dir)), cms.shipHtml(snapshot));  // shipHtml = strip edit ids; page is already complete
      } else {
        // REAL NON-HTML DELIVERABLE. schema.sql = the COMPILED, perfect DDL (from the data model);
        // other artifacts = the agent's text as-is.
        let body = stripFences(content);
        if (task.artifact.endsWith('.sql')) { try { body = appdb.compileDDL(content).ddl; } catch { body = sqlArtifact(content); } }
        writeFileSync(fileURLToPath(new URL(task.artifact, dir)), body);
      }
    }

    await pool.query("update tasks set status='verifying', updated_at=now() where id=$1", [task.id]);
    const { ok, log } = await verify(pool, task, content);   // deterministic check — not the agent's word
    if (ok) {
      // LOCK the ONE site identity the moment Branding passes — deterministically, BEFORE any page build can
      // be claimed (every build depends on branding). resolveBrand() always yields a complete palette, so the
      // build path can FORCE it onto every page. This is the single source of truth; no page can ever drift.
      if (task.department === 'branding') {
        try {
          const ar = await pool.query("select params->>'archetype' as a from projects where id=$1", [task.project_id]);
          const b = resolveBrand(content, (ctx as any)?.brand?.name, ar.rows[0]?.a);
          await pool.query("update projects set params = jsonb_set(params, '{brand}', $2::jsonb, true) where id=$1 and (params->'brand') is null", [task.project_id, JSON.stringify(b)]);
        } catch (e: any) { console.error('brand lock', e?.message ?? e); }
      }
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
  opts: { runnerId?: string; cap?: number; maxSteps?: number; review?: boolean } = {}
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
  // auto-review only in the SERVER context (opts.review). CLI/demo/scratch runs don't launch a browser
  // (it would keep a short-lived process alive and isn't wanted for offline tests).
  if (done && opts.review) {
    reviewSite(pool, projectId).catch(() => {});            // visual QA + board thumbnail
    dogfoodSite(pool, projectId).catch(() => {});           // interaction QA: a real browser uses the site
  }
  return { stopped: done ? 'complete' : 'blocked', steps };
}

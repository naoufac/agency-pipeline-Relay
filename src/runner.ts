import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ev, counts } from './db.ts';
import { alertStuck } from './alert.ts';
import { runAgentTracked, type Ctx } from './agents.ts';
import { verify, SITES } from './verify.ts';
import { reviewSite } from './qa.ts';
import { dogfoodSite } from './dogfood.ts';
import { cmsFinalize } from './cms/finalize.ts';
import { renderPage, formPageSlug, receiptsEnabled } from './render.ts';
import { normalizeSpec, normalizeSite, normalizeContent, normalizeDataModel, modelHasCore, extractFirstJson, brandIdentity, applyBrand, resolveBrand } from './spec.ts';
import { processMedia } from './media.ts';
import { ensurePwaAssets } from './pwa.ts';
import * as appdb from './appdb.ts';
import { PRIVATE_READ } from './schema.ts';

const stripFences = (s: string) => s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
// a real .sql deliverable: drop any prose preamble, keep from the first CREATE TABLE (mirrors sql_applies)
function sqlArtifact(content: string): string { const s = stripFences(content); const at = s.search(/create\s+table/i); return at >= 0 ? s.slice(at) : s; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// AUTONOMOUS RECOVERY (0-human): a build must never sit dead waiting for a person. Two layers:
//  1) a TRANSIENT infra error (LLM timeout / 429 / 5xx / network) does NOT consume the defect budget — it
//     backs off and retries, so a flaky provider can't brick a build.
//  2) a project that still has 'failed' tasks after its in-round retries is RESURRECTED for a fresh full
//     round, BOUNDED; once the budget is spent it emits 'project_stuck' (for alerting) instead of dying silent.
const MAX_PROJECT_RETRIES = Number(process.env.RELAY_MAX_PROJECT_RETRIES || 2);
const MAX_TRANSIENT_RETRIES = Number(process.env.RELAY_MAX_TRANSIENT_RETRIES || 6);
function isTransient(msg: any): boolean {
  const s = String(msg ?? '').toLowerCase();
  return /timeout|abort|429|too many requests|rate.?limit|\b50[0-9]\b|bad gateway|gateway|temporarily|econn|etimedout|enotfound|socket hang|network|fetch failed|empty response|truncated/.test(s);
}
const evCount = async (pool: pg.Pool, col: 'task_id' | 'project_id', id: string, type: string): Promise<number> =>
  (await pool.query(`select count(*)::int n from run_events where ${col}=$1 and type=$2`, [id, type])).rows[0]?.n ?? 0;
// resurrect: reset every 'failed' task to 'ready' for a fresh full round (attempts reset). The unblock trigger
// + reconcile re-open their downstreams as they complete. Returns true if anything was revived.
async function resurrect(pool: pg.Pool, projectId: string): Promise<boolean> {
  const r = await pool.query(
    "update tasks set status='ready', attempts=0, claimed_by=null, lease_expires_at=null, updated_at=now() where project_id=$1 and status='failed' returning id",
    [projectId]);
  if (!r.rowCount) return false;
  await pool.query("update projects set status='running' where id=$1", [projectId]);
  await ev(pool, projectId, null, 'project_retry', `resurrected ${r.rowCount} failed task(s) for a fresh round`);
  return true;
}

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

// The homepage catalog table. Machine/scheduling tables are FURNITURE, never content — a law build
// once rendered a homepage catalog of time_slots. If only machine tables have rows, there is NO
// primary catalog ('' → nothing is injected); no catalog is better than machine furniture.
const MACHINE_TABLE = /^(time_?slots?|slots?|availabilit(y|ies)|schedules?|calendars?|shifts?|opening_?hours?|hours|blackout_dates?|holidays?)$/i;
export function choosePrimaryTable(tables: { table: string; rows: number }[]): string {
  const lookup = /contact|setting|config|admin|^users?$|account|auth|session|^tags?$|meta|_info$|^info$/i;
  const named = /product|listing|item|menu|post|article|service|event|propert|vehicle|\bcar\b|recipe|course|\bjob|maker|plant|book|dish|room|catalog|portfolio|gallery|review|member|deal|offer|spot|class|trip|tour/i;
  const cand = tables.filter((t) => !lookup.test(t.table) && !MACHINE_TABLE.test(t.table) && t.rows > 0).sort((a, b) => b.rows - a.rows);
  return (cand.find((t) => named.test(t.table)) || cand[0] || { table: '' }).table;
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
  const layout = params.layout; // deterministic STRUCTURE (hero/nav/band), chosen once per project
  // SINGLE SOURCE OF TRUTH: the canonical site identity is locked into params.brand the moment Branding
  // passes (see processTask). For a build, read it. If it's somehow not set yet, derive it DETERMINISTICALLY
  // from the upstream branding output — resolveBrand() always returns a complete palette. NEVER the page spec.
  let brand = params.brand;
  if (!brand && (task.department === 'build' || task.department === 'compose')) {
    const bj = ups.rows.find((u: any) => u.department === 'branding');
    if (bj) brand = resolveBrand(bj.content, undefined, params.archetype, params.theme, proj.rows[0].brief);
  }
  const self = (task.department === 'build' && task.artifact) ? { title: task.title, slug: task.artifact.replace(/\.html$/, '') } : undefined;
  const site = params.site;   // the composed CMS (set by the compose task); a render projects its page from it
  // the app's REAL provisioned tables + typed form-columns per table + the PRIMARY catalog table
  // (the main public list — products/listings/menu — so a collection reliably shows real data)
  let tables: string[] = []; const forms: Record<string, any[]> = {}; let primaryTable = ''; let actionTable = '';
  const snap = params.schema_forms;
  if (task.department === 'render' && snap && Array.isArray(snap.tables)) {
    // M2: renders read the schema SNAPSHOT taken at compose (params.schema_forms) — never re-introspect.
    // Parallel renders once starved the pool; the silent catch downgraded typed forms to contact fallbacks.
    tables = snap.tables; Object.assign(forms, snap.forms || {}); primaryTable = snap.primaryTable || ''; actionTable = snap.actionTable || '';
  } else if (['build', 'compose', 'render'].includes(task.department)) {
    try {
      const desc = await appdb.describeSchema(pool, task.project_id);
      tables = desc.tables.map((t: any) => t.table);
      for (const t of tables) forms[t] = await appdb.formColumns(pool, task.project_id, t);
      primaryTable = choosePrimaryTable(desc.tables);
      // FS1 — the ACTION table: the private visitor-record table the core form must WRITE (a booking
      // app's core action creates an appointment, never a catalog row). Deterministic: private tables
      // with fillable columns, action-named first; system/identity tables never qualify.
      const ACTION_NAME = /book|appoint|reserv|rsvp|request|enquir|inquir|message|signup|sign_up|application|registration|waitlist|submission|lead|order(?!_items)/i;
      const priv = desc.tables.filter((t: any) => PRIVATE_READ.test(t.table) && !/^(order_items|users?|accounts?|sessions?|tokens?|customers?|clients?|payments?)$/i.test(t.table) && (forms[t.table] || []).length >= 2);
      actionTable = (priv.find((t: any) => ACTION_NAME.test(t.table)) || priv[0] || { table: '' }).table;
    } catch (e: any) {
      // NEVER silent: a failed introspection means typed forms would degrade — record it on the board.
      await ev(pool, task.project_id, task.id, 'ctx_schema_failed', String(e?.message ?? e).slice(0, 200)).catch(() => {});
    }
  }
  return { brief: proj.rows[0].brief, upstream: ups.rows, feedback, pages, self, theme, layout, shape: params.shape, archetype: params.archetype, tables, forms, primaryTable, actionTable, brand, site } as any;
}

async function processTask(pool: pg.Pool, task: any, runnerId: string): Promise<void> {
  try {
    const ctx = await buildContext(pool, task);
    let content = '';
    const dir = new URL(task.project_id + '/', SITES);

    if (task.department === 'render') {
      // DETERMINISTIC PROJECTION (no LLM call): a render reads its page from the composed site model (the ONE
      // CMS in params.site) and renders it with the LOCKED brand. Every page is a view of the SAME source, so
      // brand/nav/theme/palette cannot drift — the page is, by construction, consistent with the whole site.
      const slug = String(task.artifact || 'index.html').replace(/\.html$/, '');
      const siteModel = (ctx as any).site;
      const page = (siteModel && Array.isArray(siteModel.pages)) ? siteModel.pages.find((p: any) => p.slug === slug) : null;
      if (!page) throw new Error(`render: page "${slug}" missing from the composed site model`);
      const spec: any = { brand: {}, sections: page.sections };
      const canon = (ctx as any).brand || brandIdentity(spec);
      applyBrand(spec, canon);                                          // FORCE the one identity onto the projection
      mkdirSync(fileURLToPath(dir), { recursive: true });
      const pageTitle = page.title || (((ctx.pages || []) as any[]).find((p) => p.slug === slug) || {}).title || slug;
      const rendered = renderPage(spec, { pages: ctx.pages || [], slug, title: pageTitle, projectId: task.project_id, theme: ctx.theme, layout: (ctx as any).layout, forms: (ctx as any).forms, primaryTable: (ctx as any).primaryTable, formSlug: formPageSlug((ctx as any).site), accountLinks: receiptsEnabled((ctx as any).site) });
      writeFileSync(fileURLToPath(new URL(task.artifact, dir)), await processMedia(rendered, dir));   // rendered page -> served file (CMS-native serving replaces the old edit-overlay; src/cms.ts removed)
      // PWA: every produced site ships manifest + offline shell + brand icons (compiled from the
      // locked brand; icons painted once). A failure here must not fail the page render itself.
      try { await ensurePwaAssets(dir, canon, task.project_id); } catch (e: any) { await ev(pool, task.project_id, task.id, 'pwa_assets_failed', String(e?.message ?? e).slice(0, 200)).catch(() => {}); }
      content = JSON.stringify(page);
      await pool.query('update task_outputs set is_current=false where task_id=$1 and is_current', [task.id]);
      await pool.query('insert into task_outputs(task_id, attempt, content) values ($1,$2,$3)', [task.id, task.attempts, content]);
    } else {
      const result = await runAgentTracked(task.department, ctx);  // the agent: text in -> text + per-call meta out
      // A/B instrumentation (Task 10): record provider/model + latency BEFORE anything else (even a failed call),
      // then preserve the existing agent_error retry path by re-throwing on failure.
      await ev(pool, task.project_id, task.id, 'llm_call', JSON.stringify(result.meta));
      if (!result.meta.ok) throw new Error(result.meta.error || 'llm call failed');
      content = result.text;

      // CONTENT-dept reliability gate (R3): normalize the two-shape content output to ONE clean object, or REJECT.
      if (task.department === 'content') {
        const r = normalizeContent(content);
        if (r.ok === false) throw new Error('content rejected: ' + r.errors.join('; '));
        for (const rep of r.repairs) console.error(`[content] ${task.project_id}: ${rep}`);
        content = JSON.stringify(r.spec);  // feed normalized JSON to next stage
      }

      // DATABASE-dept reliability gate (R7): recover + CLAMP the data model into ONE clean object, or REJECT.
      if (task.department === 'database') {
        const r = normalizeDataModel(content);
        if (r.ok === false) throw new Error('database rejected: ' + r.errors.join('; ') + ' — the output began: ' + JSON.stringify(String(content || '').trim().slice(0, 160)) + ' — emit ONE JSON object {"entities":[...]} and nothing else');
        // FS4: a model of identity tables only (users/clients) is a GUTTED app — the core entity was
        // truncated or forgotten. Reject into retry with exact ordering instructions.
        if (['app', 'store'].includes(String((ctx as any).archetype)) && !modelHasCore(r.model))
          throw new Error('database rejected: the model contains only identity tables — the app\'s REAL entities (the thing a visitor DOES: deliveries/bookings/orders/listings, plus its catalog) are missing. Emit the core ACTION entity FIRST with all its fields, catalog entities next, identity tables LAST, seeds small (≤6 rows) — compact JSON on one line.');
        for (const rep of r.repairs) console.error(`[datamodel] ${task.project_id}: ${rep}`);
        content = JSON.stringify(r.model);
      }

      // COMPOSE-dept: the WHOLE site as ONE model (the CMS). Validate EVERY planned page is present + renderable
      // against the spec contract, then store it in params.site — the single source every render projects from —
      // or REJECT the unfixable into retry-with-feedback. No page renders until this passes the site_model gate.
      if (task.department === 'compose') {
        const raw = extractFirstJson(content);
        const { site, repairs, errors } = normalizeSite(raw, ctx.pages || [], { tables: (ctx as any).tables, forms: (ctx as any).forms, primaryTable: (ctx as any).primaryTable, actionTable: (ctx as any).actionTable, archetype: (ctx as any).archetype });
        if (errors.length) throw new Error('site compose rejected: ' + errors.join('; '));
        if (repairs.length) console.error(`[compose] ${task.project_id}: ${repairs.join(' · ')}`);
        await pool.query("update projects set params = jsonb_set(params, '{site}', $2::jsonb, true) where id=$1", [task.project_id, JSON.stringify(site)]);
        // SCHEMA MAP — computed ONCE here, stored with the model (M2). Renders MUST NOT re-introspect
        // the DB (4 parallel renders × N queries starved the pool once; the catch{} silently downgraded
        // every typed form to the contact fallback). One compose = one schema snapshot = every
        // projection sees the same forms. The schema can't change after compose (database dept is upstream).
        await pool.query("update projects set params = jsonb_set(params, '{schema_forms}', $2::jsonb, true) where id=$1",
          [task.project_id, JSON.stringify({ tables: (ctx as any).tables || [], forms: (ctx as any).forms || {}, primaryTable: (ctx as any).primaryTable || '', actionTable: (ctx as any).actionTable || '' })]);
        content = JSON.stringify(site);
      }

      await pool.query('update task_outputs set is_current=false where task_id=$1 and is_current', [task.id]);
      await pool.query('insert into task_outputs(task_id, attempt, content) values ($1,$2,$3)', [task.id, task.attempts, content]);

      // NON-RENDER ARTIFACTS: a non-html deliverable (schema.sql etc.), or the LEGACY single-page build (.html,
      // still used by the eval harness). The CMS pipeline writes pages via the 'render' branch above.
      if (task.artifact) {
        mkdirSync(fileURLToPath(dir), { recursive: true });
        if (task.artifact.endsWith('.html')) {
          const raw = extractFirstJson(content);
          const slug = task.artifact.replace(/\.html$/, '');
          const { spec, repairs, errors } = normalizeSpec(raw, { slug, tables: (ctx as any).tables, forms: (ctx as any).forms, primaryTable: (ctx as any).primaryTable });
          if (errors.length) throw new Error('build spec rejected: ' + errors.join('; '));
          if (repairs.length) console.error(`[spec] ${task.project_id}/${slug}: ${repairs.join(' · ')}`);
          const canon = (ctx as any).brand || brandIdentity(spec);
          await pool.query("update projects set params = jsonb_set(params, '{brand}', $2::jsonb, true) where id=$1 and (params->'brand') is null", [task.project_id, JSON.stringify(canon)]);
          applyBrand(spec, canon);
          const pageTitle = (((ctx.pages || []) as any[]).find((p) => p.slug === slug) || {}).title || task.title.replace(/^Build the\s+/i, '').replace(/\s+page$/i, '');
          const rendered = renderPage(spec, { pages: ctx.pages || [], slug, title: pageTitle, projectId: task.project_id, theme: ctx.theme, layout: (ctx as any).layout, forms: (ctx as any).forms, primaryTable: (ctx as any).primaryTable, formSlug: formPageSlug((ctx as any).site), accountLinks: receiptsEnabled((ctx as any).site) });
          writeFileSync(fileURLToPath(new URL(task.artifact, dir)), await processMedia(rendered, dir));
        } else {
          let body = stripFences(content);
          if (task.artifact.endsWith('.sql')) { try { body = appdb.compileDDL(content).ddl; } catch { body = sqlArtifact(content); } }
          writeFileSync(fileURLToPath(new URL(task.artifact, dir)), body);
        }
      }
    }

    await pool.query("update tasks set status='verifying', updated_at=now() where id=$1", [task.id]);
    const { ok, log } = await verify(pool, task, content);   // deterministic check — not the agent's word
    if (ok) {
      // LOCK the ONE site identity the moment Branding passes — deterministically, BEFORE compose/render run
      // (both depend on branding). resolveBrand() always yields a complete palette, so render can FORCE it onto
      // every page. This is the single source of truth; no page can ever drift.
      if (task.department === 'branding') {
        try {
          const ar = await pool.query("select params->>'archetype' as a, params->>'theme' as t, brief from projects where id=$1", [task.project_id]);
          const b = resolveBrand(content, (ctx as any)?.brand?.name, ar.rows[0]?.a, ar.rows[0]?.t, ar.rows[0]?.brief);
          await pool.query("update projects set params = jsonb_set(params, '{brand}', $2::jsonb, true) where id=$1 and (params->'brand') is null", [task.project_id, JSON.stringify(b)]);
        } catch (e: any) { console.error('brand lock', e?.message ?? e); }
      }
      await pool.query("update tasks set status='done', claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1", [task.id]);
      await ev(pool, task.project_id, task.id, 'task_done', `#${task.seq} ${task.department} [${task.verify}]`);
    } else {
      await ev(pool, task.project_id, task.id, 'verify_failed', `#${task.seq}: ${log}`);
      const next = task.attempts >= task.max_attempts ? 'failed' : 'ready';
      await pool.query(`update tasks set status=$2, claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1`, [task.id, next]);
    }
  } catch (e: any) {
    // agent/API error (e.g. provider down): never crash the loop.
    await ev(pool, task.project_id, task.id, 'agent_error', `#${task.seq}: ${(e?.message ?? String(e)).slice(0, 280)}`);
    const errs = await evCount(pool, 'task_id', task.id, 'agent_error');   // includes the one just logged
    // TRANSIENT infra blip → back off + retry WITHOUT burning the defect budget (a flaky provider must not
    // brick a build). Park as 'running' with a future lease; reclaim() revives it to 'ready' after the backoff
    // (no busy-wait, no held slot). attempts is refunded so transient never counts toward 'failed'.
    if (isTransient(e?.message) && errs < MAX_TRANSIENT_RETRIES) {
      const backoff = Math.min(5 * Math.pow(2, errs), 180);   // seconds, capped at 3 min
      await pool.query("update tasks set status='running', claimed_by=null, lease_expires_at=now() + make_interval(secs => $2), attempts=greatest(attempts-1,0), updated_at=now() where id=$1", [task.id, backoff]);
      return;
    }
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
      if (c.running === 0 && c.ready === 0 && c.verifying === 0) {
        // quiescent. If 'failed' tasks remain and resurrect budget is left, retry the WHOLE round (0-human
        // recovery) — a transient blip or an unlucky exhausted retry gets a fresh chance instead of bricking.
        if (c.failed > 0 && (await evCount(pool, 'project_id', projectId, 'project_retry')) < MAX_PROJECT_RETRIES && (await resurrect(pool, projectId))) {
          await sleep(300); continue;
        }
        break;  // truly complete, or genuinely stuck (budget exhausted)
      }
      await sleep(25);
      continue;
    }
    await Promise.all(claimed.map((t) => processTask(pool, t, runnerId)));
    steps += claimed.length;
    if (steps >= maxSteps) return { stopped: 'maxSteps', steps };
  }

  const c = await counts(pool, projectId);
  const done = (c.blocked + c.ready + c.running + c.verifying) === 0 && c.failed === 0;
  // genuinely stuck after exhausting recovery → alert the OPERATOR (Telegram, once per project) —
  // a stuck build must interrupt a human, never wait to be noticed on a dashboard (M5).
  if (!done && c.failed > 0) {
    const detail = `${c.failed} task(s) failed after ${await evCount(pool, 'project_id', projectId, 'project_retry')} resurrect round(s) — needs attention`;
    await ev(pool, projectId, null, 'project_stuck', detail);
    alertStuck(pool, projectId, detail).catch(() => {});
  }
  await pool.query('update projects set status=$2 where id=$1', [projectId, done ? 'done' : 'blocked']);
  // auto-review only in the SERVER context (opts.review). CLI/demo/scratch runs don't launch a browser
  // (it would keep a short-lived process alive and isn't wanted for offline tests).
  if (done && opts.review) {
    // CMS-NATIVE: re-serve every finished site THROUGH its selected CMS (params.cms → adapter), gated
    // by served_from_cms. Guarded + additive: if the CMS is down it logs cms_build_failed and the
    // static build stands (never breaks a build). Runs BEFORE QA so QA judges the CMS-served pages.
    (async () => {
      try { await cmsFinalize(pool, projectId); } catch (e: any) { console.error('cmsFinalize', projectId, e?.message ?? e); }
      reviewSite(pool, projectId).catch(() => {});          // visual QA + board thumbnail
      dogfoodSite(pool, projectId).catch(() => {});         // interaction QA: a real browser uses the site
    })();
  }
  return { stopped: done ? 'complete' : 'blocked', steps };
}

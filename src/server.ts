// Relay — the live web app. One cohesive frontend (web/) served here, plus the JSON API.
// The website IS the product: submit a brief, watch the agency build it live.
import http from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makePool } from './db.ts';
import { plan, replan } from './planner.ts';
import { runLoop } from './runner.ts';
import { computeKpi } from './kpi.ts';
import { SITES } from './verify.ts';
import { renderLiveFromCms } from './cms/live.ts';
import { reviewSite, qaRunning } from './qa.ts';
import * as appdb from './appdb.ts';

const pool = makePool();
const PORT = Number(process.env.PORT || 8787);
if (!process.env.MINIMAX_API_KEY) console.error('⚠️  MINIMAX_API_KEY not set — Relay will ship STUB sites, not real work. Set it in .env before serving production traffic.');

// crash handlers: log + exit so systemd (Restart=always) brings us back clean instead of half-dead
process.on('unhandledRejection', (e: any) => console.error('unhandledRejection', e?.message ?? e));
process.on('uncaughtException', (e: any) => { console.error('uncaughtException', e?.message ?? e); process.exit(1); });

// /api/run spends real LLM tokens — guard it. Per-IP sliding window + a global concurrent-project cap
// (the cap also protects the pg pool from the runner's pool-exhaustion failure mode).
const RUN_HITS = new Map<string, number[]>(), PUB_HITS = new Map<string, number[]>();
const RATE_WINDOW_MS = 15 * 60 * 1000, RUN_MAX_PER_IP = 5, PUB_MAX_PER_IP = Number(process.env.PUB_MAX || 40), MAX_ACTIVE_PROJECTS = 6;
function limited(map: Map<string, number[]>, max: number, ip: string): boolean {
  const now = Date.now();
  const arr = (map.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= max) { map.set(ip, arr); return true; }
  arr.push(now); map.set(ip, arr); return false;
}
const QA_HITS = new Map<string, number[]>(), FORM_HITS = new Map<string, number[]>(), READ_HITS = new Map<string, number[]>();
const rateLimited = (ip: string) => limited(RUN_HITS, RUN_MAX_PER_IP, ip);   // /api/run: full builds spend LLM tokens, tight
const qaLimited = (ip: string) => limited(QA_HITS, 20, ip);                   // /api/qa/run: vision calls + chromium, own budget
const formLimited = (ip: string) => limited(FORM_HITS, 30, ip);               // produced-site form submissions, anti-spam
const readLimited = (ip: string) => limited(READ_HITS, Number(process.env.READ_MAX || 240), ip); // public content reads (feed/collection) — generous; just caps bulk harvesting
const clientIp = (req: http.IncomingMessage) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
const WEB = new URL('../web/', import.meta.url);

const STATIC: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html',
  '/styles.css': 'styles.css', '/app.js': 'app.js',
};
const MIME: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript',
  png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon', json: 'application/json', webp: 'image/webp' };

async function boardJSON(projectId?: string) {
  const p = projectId
    ? await pool.query('select id, brief, status, params, created_at from projects where id=$1', [projectId])
    : await pool.query('select id, brief, status, params, created_at from projects order by created_at desc limit 1');
  if (!p.rows.length) return { project: null, tasks: [], edges: [] };
  const proj = p.rows[0];
  const tasks = (await pool.query('select seq, title, department, status from tasks where project_id=$1 order by seq', [proj.id])).rows;
  const edges = (await pool.query(
    `select us.seq as "from", ds.seq as "to" from task_dependencies d
     join tasks us on us.id=d.upstream_id join tasks ds on ds.id=d.downstream_id
     where us.project_id=$1`, [proj.id])).rows;
  const hasSite = existsSync(fileURLToPath(new URL(proj.id + '/index.html', SITES)));
  return { project: proj, tasks, edges, site: hasSite ? '/sites/' + proj.id + '/' : null };
}

async function projectsJSON() {
  const r = await pool.query(`
    select p.id, p.brief, p.status, p.created_at,
      count(t.*)::int as total,
      count(t.*) filter (where t.status='done')::int as done,
      count(t.*) filter (where t.status='failed')::int as failed,
      count(t.*) filter (where t.status in ('running','verifying'))::int as active,
      count(t.*) filter (where t.status='done' and t.attempts<=1)::int as firstpass,
      count(t.*) filter (where t.verify <> 'nonempty')::int as realchecks,
      coalesce(round(extract(epoch from (max(t.updated_at) - p.created_at)))::int,0) as wall,
      (select d.passed from dogfood_reviews d where d.project_id=p.id order by d.id desc limit 1) as review_passed,
      (select coalesce(jsonb_array_length(d.issues),0) from dogfood_reviews d where d.project_id=p.id order by d.id desc limit 1) as review_issues
    from projects p left join tasks t on t.project_id=p.id
    group by p.id order by p.created_at desc limit 50`);
  for (const row of r.rows)
    row.site = existsSync(fileURLToPath(new URL(row.id + '/index.html', SITES))) ? '/sites/' + row.id + '/' : null;
  return r.rows;
}

function send(res: http.ServerResponse, code: number, type: string, body: string | Buffer) {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    const path = url.pathname;

    if (path === '/healthz') return send(res, 200, 'text/plain', 'ok');

    if (path === '/roadmap') { res.writeHead(302, { location: '/#/roadmap' }); res.end(); return; }

    // serve the produced website(s): /sites/<projectId>/[file]
    if (path.startsWith('/sites/')) {
      let rel = decodeURIComponent(path.slice('/sites/'.length)).replace(/\.\.+/g, '');
      if (/\.tmp$/i.test(rel)) return send(res, 404, 'text/plain', 'not found');   // never serve an unverified republish candidate
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      else if (!/\.[a-z0-9]+$/i.test(rel)) rel += '/index.html';
      // LIVE CMS: render an HTML page fresh from its CMS so content edits show with no rebuild.
      const live = rel.match(/^([0-9a-f-]{36})\/(.+)\.html$/i);
      if (live) {
        try {
          const html = await renderLiveFromCms(pool, live[1], live[2]);
          if (html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' }); res.end(html); return; }
        } catch (e: any) { console.error('live-cms', live[1], live[2], e?.message ?? e); }   // fall through to static
      }
      const f = fileURLToPath(new URL(rel, SITES));
      if (existsSync(f) && statSync(f).isFile()) {
        const ext = (f.split('.').pop() || '').toLowerCase();
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
        res.end(readFileSync(f));
        return;
      }
      return send(res, 404, 'text/plain', 'site not found');
    }
    if (path === '/api/board') return send(res, 200, 'application/json', JSON.stringify(await boardJSON(url.searchParams.get('id') || undefined)));
    if (path === '/api/projects') return send(res, 200, 'application/json', JSON.stringify(await projectsJSON()));
    if (path === '/api/kpi') return send(res, 200, 'application/json', JSON.stringify(await computeKpi(pool, url.searchParams.get('id') || undefined)));
    if (path === '/api/output') {
      const r = await pool.query(
        `select t.seq, t.title, t.department, t.status, t.verify, coalesce(o.content,'') as content
         from tasks t left join task_outputs o on o.task_id=t.id and o.is_current
         where t.project_id=$1 and t.seq=$2`, [url.searchParams.get('id'), Number(url.searchParams.get('seq'))]);
      return send(res, 200, 'application/json', JSON.stringify(r.rows[0] || {}));
    }


    // ---- Full-stack: a produced site's form posts here -> Postgres ----
    const submitM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/submit$/i);
    if (submitM && req.method === 'POST') {
      const sid = submitM[1];
      const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
      if (formLimited(ip)) return send(res, 429, 'application/json', '{"error":"too many submissions — try again shortly"}');
      let raw = ''; for await (const c of req) raw += c;
      let b: any = {}; try { b = JSON.parse(raw || '{}'); } catch {}
      const form = String(b.form || 'contact').slice(0, 60);
      const data = (b.data && typeof b.data === 'object') ? b.data : {};
      if (!(await pool.query('select 1 from projects where id=$1', [sid])).rows[0]) return send(res, 404, 'application/json', '{"error":"unknown site"}');
      await pool.query('insert into site_submissions(project_id,form,data) values($1,$2,$3)', [sid, form, JSON.stringify(data)]);
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    // ---- Live per-project DB: read/insert rows from the produced app's OWN isolated schema ----
    const dataM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/data\/([a-zA-Z_][a-zA-Z0-9_]{0,62})$/);
    if (dataM && req.method === 'GET') {
      if (readLimited(clientIp(req))) return send(res, 429, 'application/json', '{"rows":[],"error":"rate limited"}');
      try { return send(res, 200, 'application/json', JSON.stringify({ rows: await appdb.readRows(pool, dataM[1], dataM[2], Number(url.searchParams.get('limit') || 50)) })); }
      catch { return send(res, 200, 'application/json', '{"rows":[]}'); }
    }
    if (dataM && req.method === 'POST') {
      const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
      if (formLimited(ip)) return send(res, 429, 'application/json', '{"error":"too many submissions — try again shortly"}');
      let raw = ''; for await (const c of req) raw += c;
      let b: any = {}; try { b = JSON.parse(raw || '{}'); } catch {}
      const data = (b.data && typeof b.data === 'object') ? b.data : {};
      try { const ok = await appdb.insertRow(pool, dataM[1], dataM[2], data); return send(res, ok ? 200 : 400, 'application/json', JSON.stringify({ ok })); }
      catch (e: any) { return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 120) })); }
    }
    if (path === '/api/submissions') {
      const id = url.searchParams.get('id'); if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      if (readLimited(clientIp(req))) return send(res, 429, 'application/json', '{"submissions":[],"error":"rate limited"}');
      const form = url.searchParams.get('form');   // public feeds pass a form name; the operator's Data tab omits it (all forms)
      const r = form
        ? await pool.query('select form, data, created_at from site_submissions where project_id=$1 and form=$2 order by created_at desc limit 200', [id, form.slice(0, 60)])
        : await pool.query('select form, data, created_at from site_submissions where project_id=$1 order by created_at desc limit 200', [id]);
      return send(res, 200, 'application/json', JSON.stringify({ submissions: r.rows }));
    }

    // ---- Interaction QA (dogfood): a real browser used the site; latest verdict ----
    if (path === '/api/dogfood') {
      const id = url.searchParams.get('id'); if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      try {
        const r = await pool.query('select passed, summary, issues, checked, at from dogfood_reviews where project_id=$1 order by id desc limit 1', [id]);
        return send(res, 200, 'application/json', JSON.stringify(r.rows[0] || { summary: null, issues: [], checked: {} }));
      } catch { return send(res, 200, 'application/json', '{"summary":null,"issues":[],"checked":{}}'); }
    }
    // ---- The data model the agency designed for this project (live introspection) ----
    if (path === '/api/schema') {
      const id = url.searchParams.get('id'); if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      try { return send(res, 200, 'application/json', JSON.stringify(await appdb.describeSchema(pool, id))); }
      catch (e: any) { return send(res, 200, 'application/json', JSON.stringify({ schema: null, tables: [], error: String(e?.message ?? e).slice(0, 120) })); }
    }
    // ---- Visual QA: a vision model reads the produced pages + reports issues ----
    if (path === '/api/qa') {
      const id = url.searchParams.get('id'); if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      const r = await pool.query('select slug, viewport, score, issues, shot from qa_reviews where project_id=$1 order by slug, viewport', [id]);
      const scores = r.rows.map((x: any) => x.score);
      const overall = scores.length ? Math.min(...scores) : null;
      return send(res, 200, 'application/json', JSON.stringify({ overall, running: qaRunning(id), reviews: r.rows }));
    }
    if (path === '/api/qa/run' && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      let id = ''; try { id = (JSON.parse(raw || '{}').id || '').trim(); } catch {}
      if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?').split(',')[0].trim();
      if (qaLimited(ip)) return send(res, 429, 'application/json', '{"error":"slow down"}');
      const pr = (await pool.query('select status from projects where id=$1', [id])).rows[0];
      if (!pr) return send(res, 404, 'application/json', '{"error":"project not found"}');
      if (pr.status !== 'done') return send(res, 409, 'application/json', '{"error":"site is still building"}');
      if (qaRunning(id)) return send(res, 200, 'application/json', '{"ok":true,"state":"running"}');   // already reviewing
      reviewSite(pool, id).catch((e) => console.error('qa run', id, e?.message));   // fire-and-forget; polled via /api/qa
      return send(res, 202, 'application/json', '{"ok":true}');
    }

    if (path === '/api/run' && req.method === 'POST') {
      const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
      if (rateLimited(ip)) return send(res, 429, 'application/json', JSON.stringify({ error: 'Too many briefs — max 5 per 15 min. Try again shortly.' }));
      const active = (await pool.query("select count(distinct project_id)::int n from tasks where status in ('ready','running','verifying')")).rows[0].n;
      if (active >= MAX_ACTIVE_PROJECTS) return send(res, 429, 'application/json', JSON.stringify({ error: 'Relay is at capacity right now — a few sites are still building. Try again in a moment.' }));
      let raw = ''; for await (const c of req) raw += c;
      let brief = ''; try { brief = (JSON.parse(raw || '{}').brief || '').trim(); } catch {}
      if (!brief) return send(res, 400, 'application/json', JSON.stringify({ error: 'brief required' }));
      const id = await plan(pool, brief);
      // build in-process by default; with RELAY_BUILD=0 the web server only PLANS and a worker builds it
      if (process.env.RELAY_BUILD !== '0') runLoop(pool, id, { cap: 4, review: true }).catch((e) => console.error('run', id, e?.message));
      return send(res, 200, 'application/json', JSON.stringify({ id }));
    }

    // M3 — REBUILD IN PLACE: update the brief, replan the SAME project. Brand + theme + the app's
    // DATABASE survive (the schema is migrated, never dropped — rows are guarded by a rollback).
    if (path === '/api/rebuild' && req.method === 'POST') {
      const ip = clientIp(req);
      if (rateLimited(ip)) return send(res, 429, 'application/json', JSON.stringify({ error: 'Too many builds — try again shortly.' }));
      let raw = ''; for await (const c of req) raw += c;
      let id = '', brief = ''; try { const b = JSON.parse(raw || '{}'); id = (b.id || '').trim(); brief = (b.brief || '').trim(); } catch {}
      if (!/^[0-9a-f-]{36}$/i.test(id)) return send(res, 400, 'application/json', '{"error":"id required"}');
      const pr = (await pool.query('select brief, status from projects where id=$1', [id])).rows[0];
      if (!pr) return send(res, 404, 'application/json', '{"error":"project not found"}');
      const active = (await pool.query("select count(*)::int n from tasks where project_id=$1 and status in ('ready','running','verifying')", [id])).rows[0].n;
      if (active) return send(res, 409, 'application/json', '{"error":"this project is still building"}');
      await replan(pool, id, brief || pr.brief);
      // sweep the previous generation's pages — stale slugs would mix two navigations and (rightly)
      // fail the site_consistent gate. Assets stay (renders re-download what the new pages need).
      try { const dir = fileURLToPath(new URL(id + '/', SITES)); for (const f of readdirSync(dir)) if (f.endsWith('.html')) rmSync(dir + '/' + f); } catch {}
      if (process.env.RELAY_BUILD !== '0') runLoop(pool, id, { cap: 4, review: true }).catch((e) => console.error('rebuild', id, e?.message));
      return send(res, 200, 'application/json', JSON.stringify({ id }));
    }

    // ONE pipeline, ONE CMS. The old /api/cms-run (a parallel WordPress generator that bypassed the
    // planner/verify/QA pipeline entirely) is retired — every brief flows through /api/run. Existing
    // WP-built projects keep serving from their container; the board still renders them read-only.
    if (path === '/api/cms-run' && req.method === 'POST')
      return send(res, 410, 'application/json', JSON.stringify({ error: 'retired — use /api/run (one pipeline, one CMS)' }));

    const file = STATIC[path];
    if (file) {
      const ext = file.split('.').pop()!;
      let body: Buffer | string = readFileSync(new URL(file, WEB));
      // auto cache-bust: stamp app.js/styles.css with their mtime so a change always invalidates
      if (file === 'index.html') {
        const v = Math.floor(Math.max(statSync(new URL('app.js', WEB)).mtimeMs, statSync(new URL('styles.css', WEB)).mtimeMs));
        body = body.toString().replace('/styles.css', '/styles.css?v=' + v).replace('/app.js', '/app.js?v=' + v);
      }
      res.writeHead(200, { 'content-type': MIME[ext] || 'text/plain', 'cache-control': 'no-cache, must-revalidate', 'access-control-allow-origin': '*' });
      res.end(body);
      return;
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e: any) {
    send(res, 500, 'text/plain', 'err: ' + (e?.message ?? e));
  }
});
server.listen(PORT, '0.0.0.0', () => console.log('Relay on http://0.0.0.0:' + PORT));

// restart-safe: on boot, resume any project that still has unfinished tasks
(async () => {
  try {
    const r = await pool.query("select distinct project_id from tasks where status in ('ready','running','verifying','blocked')");
    if (process.env.RELAY_BUILD !== '0') for (const row of r.rows) runLoop(pool, row.project_id, { cap: 4, review: true }).catch(() => {});
    if (r.rows.length) console.log('resuming', r.rows.length, 'unfinished project(s)');
  } catch (e: any) { console.error('resume failed', e?.message); }
})();

// CMS restart-safety: a publish interrupted by a crash/restart is stuck at 'publishing' (snapshots have
// no lease). Release it so the page stays editable. Runs on boot + every 2 min.
// ensure the interaction-review table exists (so /api/projects' review verdict query never 500s)
pool.query("create table if not exists dogfood_reviews (id bigserial primary key, project_id uuid, passed boolean not null default false, summary text, issues jsonb not null default '[]'::jsonb, checked jsonb not null default '{}'::jsonb, at timestamptz not null default now())").catch(() => {});

// AUTONOMOUS BUILD RECOVERY (0-human): re-run any 'blocked' project that still has failed tasks AND resurrect
// budget left, so a build that got stuck while the server kept running heals itself — no restart, no human.
// runLoop performs the actual resurrect; this only re-invokes it. Budget-bounded, so a perma-stuck project
// (already emitted 'project_stuck') is left alone for a human, not retried forever.
const MAX_RETRIES = Number(process.env.RELAY_MAX_PROJECT_RETRIES || 2);
const recoverBlocked = async () => {
  if (process.env.RELAY_BUILD === '0') return;
  try {
    const r = await pool.query(
      `select p.id from projects p
        where p.status='blocked'
          and exists (select 1 from tasks t where t.project_id=p.id and t.status='failed')
          and (select count(*) from run_events e where e.project_id=p.id and e.type='project_retry') < $1`, [MAX_RETRIES]);
    for (const row of r.rows) runLoop(pool, row.id, { cap: 4, review: true }).catch(() => {});
    if (r.rows.length) console.log('recover: re-running', r.rows.length, 'blocked project(s)');
  } catch (e: any) { console.error('recoverBlocked', e?.message); }
};
setInterval(recoverBlocked, 300000).unref?.();  // every 5 min

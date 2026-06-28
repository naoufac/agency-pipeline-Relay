// Relay — the live web app. One cohesive frontend (web/) served here, plus the JSON API.
// The website IS the product: submit a brief, watch the agency build it live.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makePool } from './db.ts';
import { plan } from './planner.ts';
import { runLoop } from './runner.ts';
import { computeKpi } from './kpi.ts';
import { SITES } from './verify.ts';
import { republishPage } from './cms.ts';
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
const publishLimited = (ip: string) => limited(PUB_HITS, PUB_MAX_PER_IP, ip); // /api/page/publish: cheap + frequent during editing
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
    ? await pool.query('select id, brief, status, created_at from projects where id=$1', [projectId])
    : await pool.query('select id, brief, status, created_at from projects order by created_at desc limit 1');
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

    // ---- CMS (roadmap 08): edit content + re-publish a single page ----
    if (path === '/api/pages') {
      const id = url.searchParams.get('id'); if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      const proj = await pool.query('select params from projects where id=$1', [id]);
      const pages = (proj.rows[0]?.params?.pages) || [];
      const snaps = (await pool.query('select slug, state from page_snapshots where project_id=$1', [id])).rows;
      const drafts = (await pool.query('select slug, count(*)::int n from page_blocks where project_id=$1 and draft is not null group by slug', [id])).rows;
      const sMap = new Map(snaps.map((s: any) => [s.slug, s.state])), dMap = new Map(drafts.map((d: any) => [d.slug, d.n]));
      const out = pages.map((p: any) => ({ slug: p.slug, title: p.title, editable: sMap.has(p.slug), state: sMap.get(p.slug) || null, drafts: dMap.get(p.slug) || 0 }));
      return send(res, 200, 'application/json', JSON.stringify({ pages: out }));
    }
    if (path === '/api/page') {
      const id = url.searchParams.get('id'), slug = url.searchParams.get('slug');
      if (!id || !slug) return send(res, 400, 'application/json', '{"error":"id+slug required"}');
      const snap = (await pool.query('select state, log from page_snapshots where project_id=$1 and slug=$2', [id, slug])).rows[0];
      if (!snap) return send(res, 404, 'application/json', '{"error":"page not editable yet — rebuild to enable"}');
      const blocks = (await pool.query("select block_id, kind, label, seq, coalesce(draft,published) as value, (draft is not null) as edited, read_only from page_blocks where project_id=$1 and slug=$2 order by seq", [id, slug])).rows;
      return send(res, 200, 'application/json', JSON.stringify({ page: { slug, state: snap.state, log: snap.log }, blocks }));
    }
    if (path === '/api/page/status') {
      const id = url.searchParams.get('id'), slug = url.searchParams.get('slug');
      const snap = (await pool.query('select state, log from page_snapshots where project_id=$1 and slug=$2', [id, slug])).rows[0];
      return send(res, 200, 'application/json', JSON.stringify(snap || { state: null }));
    }
    if (path === '/api/page/save' && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      let body: any = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      const { id, slug, blocks } = body;
      if (!id || !slug || !Array.isArray(blocks)) return send(res, 400, 'application/json', '{"error":"id, slug, blocks[] required"}');
      for (const b of blocks) {
        const v = String(b.value ?? '');
        if (!v.trim()) return send(res, 400, 'application/json', JSON.stringify({ error: 'text can’t be empty' }));
        if (/https?:\/\//i.test(v)) return send(res, 400, 'application/json', JSON.stringify({ error: 'links/URLs aren’t allowed in page copy' }));
        await pool.query('update page_blocks set draft=$3, updated_at=now() where project_id=$1 and slug=$2 and block_id=$4 and read_only=false', [id, slug, v, b.block_id]);
      }
      await pool.query("update page_snapshots set state='editing', updated_at=now() where project_id=$1 and slug=$2 and state<>'publishing'", [id, slug]);
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (path === '/api/page/publish' && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      let body: any = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      const { id, slug } = body;
      if (!id || !slug) return send(res, 400, 'application/json', '{"error":"id+slug required"}');
      const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
      if (publishLimited(ip)) return send(res, 429, 'application/json', '{"error":"too many publishes — try again shortly"}');
      const snap = (await pool.query('select state from page_snapshots where project_id=$1 and slug=$2', [id, slug])).rows[0];
      if (!snap) return send(res, 404, 'application/json', '{"error":"page not editable"}');
      // atomic claim — only ONE concurrent publish per page wins (no SELECT-then-UPDATE TOCTOU)
      const claim = await pool.query("update page_snapshots set state='publishing', updated_at=now() where project_id=$1 and slug=$2 and state<>'publishing' returning id", [id, slug]);
      if (!claim.rowCount) return send(res, 409, 'application/json', '{"error":"already publishing"}');
      republishPage(pool, id, slug).catch((e) => console.error('republish', id, slug, e?.message));   // fire-and-forget; status polled
      return send(res, 202, 'application/json', '{"ok":true,"state":"publishing"}');
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
      runLoop(pool, id, { cap: 4, review: true }).catch((e) => console.error('run', id, e?.message));  // fire-and-forget; board shows it live
      return send(res, 200, 'application/json', JSON.stringify({ id }));
    }

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
    for (const row of r.rows) runLoop(pool, row.project_id, { cap: 4, review: true }).catch(() => {});
    if (r.rows.length) console.log('resuming', r.rows.length, 'unfinished project(s)');
  } catch (e: any) { console.error('resume failed', e?.message); }
})();

// CMS restart-safety: a publish interrupted by a crash/restart is stuck at 'publishing' (snapshots have
// no lease). Release it so the page stays editable. Runs on boot + every 2 min.
// ensure the interaction-review table exists (so /api/projects' review verdict query never 500s)
pool.query("create table if not exists dogfood_reviews (id bigserial primary key, project_id uuid, passed boolean not null default false, summary text, issues jsonb not null default '[]'::jsonb, checked jsonb not null default '{}'::jsonb, at timestamptz not null default now())").catch(() => {});
const reclaimPublishing = () => pool.query("update page_snapshots set state='failed', log='publish interrupted — please retry', updated_at=now() where state='publishing' and updated_at < now() - interval '5 minutes'").catch(() => {});
reclaimPublishing();
setInterval(reclaimPublishing, 120000).unref?.();

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
import { publicWriteTables } from './spec.ts';
import { LIFECYCLE_TABLE } from './schema.ts';
import { renderLiveFromCms, renderLivePdp, renderLiveReceipt, renderLiveFind, renderLiveAccount, renderLiveChain, renderLivePost } from './cms/live.ts';
import { requestVisitorMagic, verifyVisitorMagic, visitorFromCookie, visitorCookie, clearVisitorCookie, logoutVisitor } from './visitors.ts';
import { reviewSite, qaRunning } from './qa.ts';
import * as appdb from './appdb.ts';
import { mailReady, notifyLead, sendMail } from './mail.ts';
import { apkStatus, packageProjectAsync } from './apk.ts';
import { ensureAuthTables, requestMagic, verifyMagic, userFromCookie, logout, sessionCookie, clearCookie, canSee, type User } from './auth.ts';
import { startTgDoor } from './tg-door.ts';

const pool = makePool();
const PORT = Number(process.env.PORT || 8787);
if (!process.env.MINIMAX_API_KEY) console.error('⚠️  MINIMAX_API_KEY not set — Relay will ship STUB sites, not real work. Set it in .env before serving production traffic.');

// crash handlers: log + exit so systemd (Restart=always) brings us back clean instead of half-dead
process.on('unhandledRejection', (e: any) => console.error('unhandledRejection', e?.message ?? e));
process.on('uncaughtException', (e: any) => { console.error('uncaughtException', e?.message ?? e); process.exit(1); });

// /api/run spends real LLM tokens — guard it. Per-IP sliding window + a global concurrent-project cap
// (the cap also protects the pg pool from the runner's pool-exhaustion failure mode).
const RUN_HITS = new Map<string, number[]>(), PUB_HITS = new Map<string, number[]>(), APK_HITS = new Map<string, number[]>(), CHAT_HITS = new Map<string, number[]>();
const RATE_WINDOW_MS = 15 * 60 * 1000, RUN_MAX_PER_IP = 5, PUB_MAX_PER_IP = Number(process.env.PUB_MAX || 40), MAX_ACTIVE_PROJECTS = 6;
function limited(map: Map<string, number[]>, max: number, ip: string): boolean {
  const now = Date.now();
  const arr = (map.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= max) { map.set(ip, arr); return true; }
  arr.push(now); map.set(ip, arr); return false;
}
const QA_HITS = new Map<string, number[]>(), FORM_HITS = new Map<string, number[]>(), READ_HITS = new Map<string, number[]>(), AUTH_HITS = new Map<string, number[]>();
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
  png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon', json: 'application/json', webp: 'image/webp', webmanifest: 'application/manifest+json', xml: 'application/xml', txt: 'text/plain; charset=utf-8', apk: 'application/vnd.android.package-archive' };

async function boardJSON(user: User | null, projectId?: string) {
  const p = projectId
    ? await pool.query('select id, brief, status, params, created_at, owner_id from projects where id=$1', [projectId])
    : (user
      ? await pool.query('select id, brief, status, params, created_at, owner_id from projects where owner_id=$1 order by created_at desc limit 1', [user.id])
      : await pool.query('select id, brief, status, params, created_at, owner_id from projects where owner_id is null order by created_at desc limit 1'));
  if (!p.rows.length) return { project: null, tasks: [], edges: [] };
  const proj = p.rows[0];
  if (!canSee(user, proj.owner_id)) return { project: null, tasks: [], edges: [] };   // owned = owner's only
  delete proj.owner_id;
  const tasks = (await pool.query('select seq, title, department, status from tasks where project_id=$1 order by seq', [proj.id])).rows;
  const edges = (await pool.query(
    `select us.seq as "from", ds.seq as "to" from task_dependencies d
     join tasks us on us.id=d.upstream_id join tasks ds on ds.id=d.downstream_id
     where us.project_id=$1`, [proj.id])).rows;
  const hasSite = existsSync(fileURLToPath(new URL(proj.id + '/index.html', SITES)));
  return { project: proj, tasks, edges, site: hasSite ? '/sites/' + proj.id + '/' : null };
}

async function projectsJSON(user: User | null) {
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
    where ${user ? 'p.owner_id = $1' : 'p.owner_id is null'}
    group by p.id order by p.created_at desc limit 50`, user ? [user.id] : []);
  for (const row of r.rows)
    row.site = existsSync(fileURLToPath(new URL(row.id + '/index.html', SITES))) ? '/sites/' + row.id + '/' : null;
  return r.rows;
}

// M4 ownership gate: 404 (never 403 — don't leak existence) when an owned project isn't yours.
async function ownerOf(id: string): Promise<string | null | undefined> {
  return (await pool.query('select owner_id from projects where id=$1', [id])).rows[0]?.owner_id;
}

function send(res: http.ServerResponse, code: number, type: string, body: string | Buffer) {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    let path = url.pathname;

    // DOMAINS — <slug>.naples.agency serves that project's site at the domain root (the wildcard
    // tunnel ingress lands here; explicit hosts like board/api keep their own ingress rules).
    // /api/* stays untouched on every host — produced pages call it with absolute paths.
    const reqHost = String(req.headers.host || '').toLowerCase().split(':')[0];
    // THE SHOP WINDOW: when RELAY_HOME_SLUG is set AND the apex DNS points here, naples.agency
    // (+ www) serves the agency's own pipeline-built site — the dogfood demo. Inert until the
    // owner flips the env + DNS; the existing apex page is never stomped from code.
    if ((reqHost === 'naples.agency' || reqHost === 'www.naples.agency') && process.env.RELAY_HOME_SLUG && !path.startsWith('/api/') && !path.startsWith('/sites/')) {
      const hp = (await pool.query("select id from projects where params->>'slug' = $1 limit 1", [process.env.RELAY_HOME_SLUG])).rows[0];
      if (hp) path = '/sites/' + hp.id + (path === '/' ? '/' : path);
    }
    const sub = reqHost.match(/^([a-z0-9][a-z0-9-]{0,62})\.naples\.agency$/)?.[1];
    if (sub && !/^(board|api|email|cms|sites|www|mail|admin|status|relay)$/.test(sub) && !path.startsWith('/api/') && !path.startsWith('/sites/')) {
      const pr = (await pool.query("select id from projects where params->>'slug' = $1 limit 1", [sub])).rows[0];
      if (pr) path = '/sites/' + pr.id + (path === '/' ? '/' : path);
      else return send(res, 404, 'text/plain', 'no site here (yet)');
    }

    if (path === '/healthz') {
      // the uptime monitor trusts this — it must NEVER say ok while the database is down
      try { await pool.query('select 1'); return send(res, 200, 'text/plain', 'ok'); }
      catch { return send(res, 503, 'text/plain', 'db unavailable'); }
    }

    // HONEST INPUTS (API rating fix): an id that isn't a UUID can never be a project — answer with a
    // clean 404 instead of letting Postgres throw a 500 that leaks query internals. One guard, every
    // ?id= endpoint covered.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const qid = url.searchParams.get('id');
    if (path.startsWith('/api/') && qid && !UUID_RE.test(qid)) return send(res, 404, 'application/json', '{"error":"unknown project","project":null,"tasks":[],"edges":[],"submissions":[],"reviews":[]}');

    // M4 — who is asking? Resolved once per API request; /sites and static stay auth-free (public web).
    const user: User | null = path.startsWith('/api/') ? await userFromCookie(pool, req.headers.cookie) : null;

    // ---- AUTH: passwordless magic links on the naples.agency SMTP ----
    if (path === '/api/auth/request' && req.method === 'POST') {
      const ip = clientIp(req);
      if (limited(AUTH_HITS, 5, ip)) return send(res, 429, 'application/json', '{"error":"too many sign-in requests — try again in a few minutes"}');
      let raw = ''; for await (const c of req) raw += c;
      let email = ''; try { email = (JSON.parse(raw || '{}').email || '').trim(); } catch {}
      const r = await requestMagic(pool, email, process.env.PUBLIC_URL || 'https://board.naples.agency');
      return send(res, r.ok ? 200 : 400, 'application/json', JSON.stringify(r));
    }
    if (path === '/api/auth/verify') {
      const v = await verifyMagic(pool, url.searchParams.get('token') || '');
      if (!v) return send(res, 400, 'text/html; charset=utf-8', '<meta charset="utf-8"><body style="font-family:sans-serif;background:#0A0C12;color:#E8EAF0;padding:40px">This sign-in link has expired or was already used. <a style="color:#7C7AFF" href="/">Request a new one</a>.</body>');
      res.writeHead(302, { 'set-cookie': sessionCookie(v.session), location: '/' });
      res.end(); return;
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      await logout(pool, req.headers.cookie);
      res.writeHead(200, { 'set-cookie': clearCookie(), 'content-type': 'application/json' });
      res.end('{"ok":true}'); return;
    }
    if (path === '/api/me') return send(res, 200, 'application/json', JSON.stringify(user ? { email: user.email } : { email: null }));

    // mail.naples.agency / email.naples.agency — the PUBLISHED status of Relay's email layer:
    // what it does (lead alerts on every produced-site submission; account email lands in M4),
    // whether SMTP is live, and the externally-checkable send log. Same page at /email anywhere.
    const host = String(req.headers.host || '');
    if (path === '/email' || /^(mail|email)\./.test(host)) {
      const sent = (await pool.query("select count(*)::int n, max(at) latest from run_events where type='mail_sent'")).rows[0];
      const failed = (await pool.query("select count(*)::int n from run_events where type='mail_failed'")).rows[0];
      const ready = mailReady();
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay · Email</title>
<style>body{font:16px/1.6 -apple-system,Inter,sans-serif;background:#0A0C12;color:#E8EAF0;max-width:640px;margin:0 auto;padding:48px 20px}h1{font-size:26px}code{background:#1a1f2e;padding:2px 7px;border-radius:6px}.ok{color:#36B37E}.bad{color:#F0506E}.card{background:#12151f;border:1px solid #232a3b;border-radius:12px;padding:18px 20px;margin:14px 0}.muted{color:#8a93a6;font-size:14px}</style></head><body>
<h1>Relay · production email</h1>
<p class="muted">Every produced site's form submission is emailed to its owner within seconds — no dashboard-checking. Sign-in and account email arrive with milestone M4.</p>
<div class="card"><b>SMTP (noreply@naples.agency)</b> — <span class="${ready ? 'ok' : 'bad'}">${ready ? '● live' : '● not configured'}</span><br>
<span class="muted">SPF · DKIM · DMARC aligned on naples.agency — inbox-grade, verified by live delivery.</span></div>
<div class="card"><b>Send log (external record, never self-reported)</b><br>
${sent.n} sent${sent.latest ? ` · last ${new Date(sent.latest).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''} · ${failed.n} failed<br>
<span class="muted">Every send/failure is a <code>mail_sent</code>/<code>mail_failed</code> event in the project log.</span></div>
<p class="muted"><a href="https://board.naples.agency" style="color:#7C7AFF">← board.naples.agency</a></p></body></html>`;
      return send(res, 200, 'text/html; charset=utf-8', html);
    }

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
        // PDP (PQ2): /sites/<id>/product-<n>.html has no CMS page row and no static file — it renders
        // LIVE from the product row itself, in its OWN error scope (a DB hiccup logs as live-pdp and
        // answers an honest 404 'product not found', never a misleading fall-through).
        const pdp = live[2].match(/^product-(\d{1,12})$/i);
        if (pdp) {
          try {
            const phtml = await renderLivePdp(pool, live[1], Number(pdp[1]));
            if (phtml) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' }); res.end(phtml); return; }
          } catch (e: any) { console.error('live-pdp', live[1], pdp[1], e?.message ?? e); }
          return send(res, 404, 'text/plain', 'product not found');
        }
        // BLOG: post-<n>.html renders live from the article row — honest 404 on an unknown id.
        const post = live[2].match(/^post-(\d{1,12})$/i);
        if (post) {
          try {
            const bhtml = await renderLivePost(pool, live[1], Number(post[1]));
            if (bhtml) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' }); res.end(bhtml); return; }
          } catch (e: any) { console.error('live-post', live[1], post[1], e?.message ?? e); }
          return send(res, 404, 'text/plain', 'post not found');
        }
        // FS1 · RECEIPT: the visitor's own record, keyed by the secret token in their URL. Honest 404
        // on a wrong token — never a stale or someone else's page.
        const rcpt = live[2].match(/^receipt-([a-z_][a-z0-9_]{0,62})-([0-9a-f]{16,64})$/i);
        if (rcpt) {
          try {
            const rhtml = await renderLiveReceipt(pool, live[1], rcpt[1].toLowerCase(), rcpt[2].toLowerCase());
            if (rhtml) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' }); res.end(rhtml); return; }
          } catch (e: any) { console.error('live-receipt', live[1], rcpt[1], e?.message ?? e); }
          return send(res, 404, 'text/plain', 'receipt not found');
        }
        // FS1 · FIND MY BOOKING: system page, live-rendered with the site's chrome.
        if (live[2] === 'find') {
          try {
            const fhtml = await renderLiveFind(pool, live[1]);
            if (fhtml) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' }); res.end(fhtml); return; }
          } catch (e: any) { console.error('live-find', live[1], e?.message ?? e); }
        }
        // CHAIN: the production record, served live for ANY project (old sites included).
        if (live[2] === 'how-it-was-built') {
          try {
            const chtml = await renderLiveChain(pool, live[1]);
            if (chtml) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' }); res.end(chtml); return; }
          } catch (e: any) { console.error('live-chain', live[1], e?.message ?? e); }
        }
        // FS2 · MY BOOKINGS: sign-in / the signed-in visitor's records. The session is validated
        // server-side against the app's OWN token table — the cookie is only the courier.
        if (live[2] === 'account') {
          try {
            const v = await visitorFromCookie(pool, live[1], req.headers.cookie);
            const ahtml = await renderLiveAccount(pool, live[1], v);
            if (ahtml) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' }); res.end(ahtml); return; }
          } catch (e: any) { console.error('live-account', live[1], e?.message ?? e); }
        }
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
    // PROJECT CHAT (multi-session): a signed-in user converses about THEIR project. A change-
    // intent message fires the REAL rebuild machinery; everything else gets a grounded answer.
    if (path === '/api/chat/sessions') {
      if (!user) return send(res, 401, 'application/json', '{"error":"sign in to chat"}');
      const pidQ = url.searchParams.get('id') || '';
      if (!UUID_RE.test(pidQ) || !canSee(user, await ownerOf(pidQ))) return send(res, 404, 'application/json', '{"error":"not found"}');
      const chat = await import('./chat.ts');
      if (req.method === 'POST') return send(res, 200, 'application/json', JSON.stringify(await chat.createSession(pool, pidQ, user.id)));
      return send(res, 200, 'application/json', JSON.stringify({ sessions: await chat.listSessions(pool, pidQ, user.id) }));
    }
    if (path === '/api/chat/messages') {
      if (!user) return send(res, 401, 'application/json', '{"error":"sign in to chat"}');
      const sidQ = url.searchParams.get('session') || '';
      if (!UUID_RE.test(sidQ)) return send(res, 404, 'application/json', '{"error":"not found"}');
      const chat = await import('./chat.ts');
      if (req.method === 'POST') {
        if (limited(CHAT_HITS, Number(process.env.CHAT_MAX || 30), clientIp(req))) return send(res, 429, 'application/json', '{"error":"too many messages — take a breath"}');
        let raw = ''; for await (const c of req) raw += c;
        let b: any = {}; try { b = JSON.parse(raw || '{}'); } catch {}
        const out = await chat.postMessage(pool, { sessionId: sidQ, userId: user.id, body: String(b.body || '') }, {
          rebuild: async (projectId, changeText) => {
            const busy = Number((await pool.query("select count(*)::int n from tasks where project_id=$1 and status in ('ready','running','verifying')", [projectId])).rows[0].n);
            if (busy) return { started: false, reason: 'the site is still building' };
            const pr = (await pool.query('select brief from projects where id=$1', [projectId])).rows[0];
            if (!pr) return { started: false, reason: 'project not found' };
            const amended = `${pr.brief} · UPDATE: ${changeText.slice(0, 500)}`;
            try { const dir = fileURLToPath(new URL(projectId + '/', SITES)); for (const f of readdirSync(dir)) if (f.endsWith('.html')) rmSync(dir + '/' + f); } catch {}
            await replan(pool, projectId, amended);
            if (process.env.RELAY_BUILD !== '0') runLoop(pool, projectId, { cap: 4, review: true }).catch(() => {});
            // the session hears the outcome — fire-and-forget
            chat.announceWhenDone(pool, sidQ, projectId).catch(() => {});
            return { started: true };
          },
        });
        return send(res, out.ok ? 200 : 400, 'application/json', JSON.stringify(out));
      }
      const sess = await chat.sessionOf(pool, sidQ, user.id);
      if (!sess) return send(res, 404, 'application/json', '{"error":"not found"}');
      return send(res, 200, 'application/json', JSON.stringify({ messages: await chat.listMessages(pool, sidQ), title: sess.title }));
    }
    // OWNER CALENDAR FEED: bookings as iCalendar — paste once into Google/Apple Calendar.
    // The key is the auth (calendar apps cannot sign in), minted by the integrations step.
    const icsM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/calendar\.ics$/);
    if (icsM && req.method === 'GET') {
      if (readLimited(clientIp(req))) return send(res, 429, 'text/plain', 'rate limited');
      const wantKey = url.searchParams.get('key') || '';
      const haveKey = (await pool.query("select params->>'cal_key' as k from projects where id=$1", [icsM[1]])).rows[0]?.k;
      if (!haveKey || wantKey !== haveKey) return send(res, 404, 'text/plain', 'not found');
      const { buildIcs } = await import('./ics.ts');
      const ics = await buildIcs(pool, icsM[1]);
      if (!ics) return send(res, 404, 'text/plain', 'no calendar for this site');
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(ics);
      return;
    }
    // ANDROID surface: GET = is there an app / is one being packaged; POST = package this site.
    // Owner-gated like every project API (404, never 403 — existence is not leaked).
    if (path === '/api/apk') {
      const aid = url.searchParams.get('id') || '';
      if (!/^[0-9a-f-]{36}$/.test(aid)) return send(res, 404, 'application/json', '{"error":"not found"}');
      if (!canSee(user, await ownerOf(aid))) return send(res, 404, 'application/json', '{"error":"not found"}');
      if (req.method === 'POST') {
        // packaging is a 25-min gradle run (a core + memory) — a resource-consuming WRITE, so it
        // needs the OWNER (canSee admits anon on ownerless legacy projects, fine for reads, NOT for
        // spawning builds) AND an IP cap. GET status stays on canSee.
        const owner = await ownerOf(aid);
        if (!user || owner == null || user.id !== owner) return send(res, 404, 'application/json', '{"error":"not found"}');
        if (limited(APK_HITS, Number(process.env.APK_MAX || 4), clientIp(req))) return send(res, 429, 'application/json', '{"error":"too many packaging requests — try again shortly"}');
        const r = packageProjectAsync(pool, aid);
        return send(res, r.started ? 202 : 409, 'application/json', JSON.stringify(r));
      }
      if (readLimited(clientIp(req))) return send(res, 429, 'application/json', '{"error":"rate limited"}');
      return send(res, 200, 'application/json', JSON.stringify(await apkStatus(pool, aid, SITES)));
    }
    if (path === '/api/board') return send(res, 200, 'application/json', JSON.stringify(await boardJSON(user, url.searchParams.get('id') || undefined)));
    if (path === '/api/projects') return send(res, 200, 'application/json', JSON.stringify(await projectsJSON(user)));
    if (path === '/api/kpi') {
      const kid = url.searchParams.get('id') || undefined;
      if (kid && !canSee(user, await ownerOf(kid))) return send(res, 404, 'application/json', 'null');
      return send(res, 200, 'application/json', JSON.stringify(await computeKpi(pool, kid)));
    }
    if (path === '/api/output') {
      if (!canSee(user, await ownerOf(url.searchParams.get('id') || ''))) return send(res, 404, 'application/json', '{}');
      const r = await pool.query(
        `select t.seq, t.title, t.department, t.status, t.verify, coalesce(o.content,'') as content
         from tasks t left join task_outputs o on o.task_id=t.id and o.is_current
         where t.project_id=$1 and t.seq=$2`, [url.searchParams.get('id'), Number(url.searchParams.get('seq'))]);
      return send(res, 200, 'application/json', JSON.stringify(r.rows[0] || {}));
    }


    // ---- Full-stack: a produced site's form posts here -> Postgres ----
    const submitM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/submit$/i);
    if (submitM && !UUID_RE.test(submitM[1])) return send(res, 404, 'application/json', '{"error":"unknown site"}');
    // honeypot: a filled 'company_website' marks a bot — pretend success, write nothing
    const isBot = (d: any) => !!String(d?.company_website ?? '').trim();
    const stripHp = (d: any) => { if (d && typeof d === 'object') delete d.company_website; return d; };
    if (submitM && req.method === 'POST') {
      const sid = submitM[1];
      const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
      if (formLimited(ip)) return send(res, 429, 'application/json', '{"error":"too many submissions — try again shortly"}');
      let raw = ''; for await (const c of req) raw += c;
      let b: any = {}; try { b = JSON.parse(raw || '{}'); } catch {}
      const form = String(b.form || 'contact').slice(0, 60);
      const data = (b.data && typeof b.data === 'object') ? b.data : {};
      const proj = (await pool.query('select brief from projects where id=$1', [sid])).rows[0];
      if (!proj) return send(res, 404, 'application/json', '{"error":"unknown site"}');
      if (isBot(data)) return send(res, 200, 'application/json', '{"ok":true}');
      stripHp(data);
      await pool.query('insert into site_submissions(project_id,form,data) values($1,$2,$3)', [sid, form, JSON.stringify(data)]);
      notifyLead(pool, sid, proj.brief, form, data);   // the operator hears about every lead by email
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    // ---- Live per-project DB: read/insert rows from the produced app's OWN isolated schema ----
    // FS5 — REAL AVAILABILITY: the free slots for a booking day. Aggregate free/busy only — never
    // who booked. Same rate limit as data reads; unknown table / bad date answer an honest 404.
    const slotsM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/slots\/([a-zA-Z_][a-zA-Z0-9_]{0,62})$/);
    if (slotsM && req.method === 'GET') {
      if (readLimited(clientIp(req))) return send(res, 429, 'application/json', '{"slots":[],"error":"rate limited"}');
      const refs: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { if (k !== 'date' && /^[a-z_][a-z0-9_]{0,62}$/i.test(k)) refs[k] = v; });
      try {
        const slots = await appdb.freeSlots(pool, slotsM[1], slotsM[2], String(url.searchParams.get('date') || ''), refs);
        if (!slots) return send(res, 404, 'application/json', '{"slots":[],"error":"no slots here"}');
        return send(res, 200, 'application/json', JSON.stringify({ slots }));
      } catch { return send(res, 200, 'application/json', '{"slots":[]}'); }
    }

    const dataM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/data\/([a-zA-Z_][a-zA-Z0-9_]{0,62})$/);
    if (dataM && !UUID_RE.test(dataM[1])) return send(res, 404, 'application/json', '{"rows":[],"error":"unknown site"}');
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
      if (isBot(data)) return send(res, 200, 'application/json', '{"ok":true}');
      stripHp(data);
      try {
        // FS1: the public may write ONLY the tables the composed site actually targets with a form —
        // never the catalog (anyone could "add services" to a barbershop through the raw API).
        const sitep = (await pool.query('select params from projects where id=$1', [dataM[1]])).rows[0]?.params?.site;
        if (!publicWriteTables(sitep).includes(dataM[2])) return send(res, 404, 'application/json', '{"ok":false,"error":"this site has no such form"}');
        const r = await appdb.insertRow(pool, dataM[1], dataM[2], data);
        if (r.ok) {
          const proj = (await pool.query("select brief, params->>'slug' as slug, params->>'locale' as loc from projects where id=$1", [dataM[1]])).rows[0];
          if (proj) notifyLead(pool, dataM[1], proj.brief, dataM[2], data);   // typed rows are leads too
          // VISITOR CONFIRMATION (the notifications leg): a booking with an email gets its receipt
          // link by mail, in the site's language — fire-and-forget, mailReady-guarded inside sendMail
          const vmail = String(data.email || data.customer_email || '').trim();
          if (r.ref && proj && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(vmail)) {
            const { L } = await import('./i18n.ts');
            const base = proj.slug ? `https://${proj.slug}.naples.agency` : `${process.env.PUBLIC_URL || 'https://board.naples.agency'}/sites/${dataM[1]}`;
            const thing = dataM[2].replace(/s$/, '').replace(/_/g, ' ');
            sendMail(pool, dataM[1], vmail, L(proj.loc, 'mail_confirm_subject', { x: thing }), L(proj.loc, 'mail_confirm_body', { x: thing, link: `${base}/receipt-${dataM[2]}-${r.ref}.html` })).catch(() => {});
          }
        }
        // FS1: the receipt ref rides back so the form can land the visitor on their receipt page
        return send(res, r.ok ? 200 : 400, 'application/json', JSON.stringify(r.ref ? { ok: r.ok, ref: r.ref, table: dataM[2] } : { ok: r.ok, ...(r.error ? { error: r.error } : {}) }));
      }
      catch (e: any) { console.error('site data insert', dataM[1], dataM[2], e?.message ?? e); return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'could not save — please check the form and try again' })); }
    }
    // ---- FS1 · receipts: resolve a pasted code to its receipt page; or mail every link for an email ----
    const rfindM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/receipt\/([0-9a-f]{16,64})$/i);
    if (rfindM && req.method === 'GET') {
      if (!UUID_RE.test(rfindM[1])) return send(res, 404, 'application/json', '{"error":"unknown site"}');
      if (readLimited(clientIp(req))) return send(res, 429, 'application/json', '{"error":"rate limited"}');
      try {
        const hit = await appdb.findByToken(pool, rfindM[1], rfindM[2].toLowerCase());
        if (hit) return send(res, 200, 'application/json', JSON.stringify({ page: `receipt-${hit.table}-${rfindM[2].toLowerCase()}.html` }));
      } catch (e: any) { console.error('receipt find', rfindM[1], e?.message ?? e); }
      return send(res, 404, 'application/json', '{"error":"no receipt for that code"}');
    }
    const rmailM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/receipt-mail$/i);
    if (rmailM && req.method === 'POST') {
      if (!UUID_RE.test(rmailM[1])) return send(res, 404, 'application/json', '{"error":"unknown site"}');
      if (formLimited(clientIp(req))) return send(res, 429, 'application/json', '{"error":"too many requests — try again shortly"}');
      let raw = ''; for await (const c of req) raw += c;
      let email = ''; try { email = String(JSON.parse(raw || '{}').email || '').trim(); } catch {}
      try {
        const links = await appdb.receiptLinksByEmail(pool, rmailM[1], email);
        if (links.length) {
          const base = (process.env.PUBLIC_URL || 'https://board.naples.agency') + '/sites/' + rmailM[1] + '/';
          const body = 'Here are your receipt links:\n\n' + links.map(l => `• ${base}receipt-${l.table}-${l.ref}.html`).join('\n') + '\n\nEach link opens your record directly — keep them private.';
          sendMail(pool, rmailM[1], email, 'Your receipt links', body).catch(() => {});
        }
      } catch (e: any) { console.error('receipt mail', rmailM[1], e?.message ?? e); }
      return send(res, 200, 'application/json', '{"ok":true}');   // ALWAYS "sent" — no enumeration
    }
    // ---- FS2 · visitor accounts on the produced app: request magic link / verify / logout ----
    const vreqM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/visitor\/request$/i);
    if (vreqM && req.method === 'POST') {
      if (!UUID_RE.test(vreqM[1])) return send(res, 404, 'application/json', '{"error":"unknown site"}');
      if (formLimited(clientIp(req))) return send(res, 429, 'application/json', '{"error":"too many requests — try again shortly"}');
      let raw = ''; for await (const c of req) raw += c;
      let email = ''; try { email = String(JSON.parse(raw || '{}').email || '').trim(); } catch {}
      try {
        const proj = (await pool.query('select params from projects where id=$1', [vreqM[1]])).rows[0];
        if (proj && ['app', 'store'].includes(String(proj.params?.archetype))) {
          const r = await requestVisitorMagic(pool, vreqM[1], email);
          if (r.token) {
            const link = `${process.env.PUBLIC_URL || 'https://board.naples.agency'}/api/site/${vreqM[1]}/visitor/verify?token=${r.token}`;
            sendMail(pool, vreqM[1], email, 'Your sign-in link', `Tap to sign in:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't request it, ignore this email.`).catch(() => {});
          }
        }
      } catch (e: any) { console.error('visitor request', vreqM[1], e?.message ?? e); }
      return send(res, 200, 'application/json', '{"ok":true}');   // ALWAYS "sent" — no enumeration
    }
    const vverM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/visitor\/verify$/i);
    if (vverM && req.method === 'GET') {
      if (!UUID_RE.test(vverM[1])) return send(res, 404, 'text/plain', 'not found');
      try {
        const v = await verifyVisitorMagic(pool, vverM[1], url.searchParams.get('token') || '');
        if (v) {
          res.writeHead(302, { 'set-cookie': visitorCookie(vverM[1], v.session), location: `/sites/${vverM[1]}/account.html` });
          res.end(); return;
        }
      } catch (e: any) { console.error('visitor verify', vverM[1], e?.message ?? e); }
      return send(res, 400, 'text/html; charset=utf-8', '<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">This sign-in link has expired or was already used. <a href="javascript:history.back()">Request a new one</a>.</body>');
    }
    const vlogM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/visitor\/logout$/i);
    if (vlogM && req.method === 'POST') {
      if (!UUID_RE.test(vlogM[1])) return send(res, 404, 'application/json', '{"error":"unknown site"}');
      await logoutVisitor(pool, vlogM[1], req.headers.cookie).catch(() => {});
      res.writeHead(200, { 'set-cookie': clearVisitorCookie(vlogM[1]), 'content-type': 'application/json' });
      res.end('{"ok":true}'); return;
    }
    // ---- PQ2 · CHECKOUT: cart -> one transactional order (server-priced, never client prices) ----
    const orderM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/order$/i);
    if (orderM && !UUID_RE.test(orderM[1])) return send(res, 404, 'application/json', '{"ok":false,"error":"unknown site"}');
    if (orderM && req.method === 'POST') {
      // (honeypot checked after parse below)
      const ip = clientIp(req);
      if (formLimited(ip)) return send(res, 429, 'application/json', '{"ok":false,"error":"too many orders — try again shortly"}');
      let raw = ''; for await (const c of req) raw += c;
      let b: any = {}; try { b = JSON.parse(raw || '{}'); } catch {}
      const proj = (await pool.query('select brief from projects where id=$1', [orderM[1]])).rows[0];
      if (!proj) return send(res, 404, 'application/json', '{"ok":false,"error":"unknown site"}');
      if (isBot(b.buyer)) return send(res, 200, 'application/json', '{"ok":true}');
      stripHp(b.buyer);
      const r = await appdb.placeOrder(pool, orderM[1], b.buyer || {}, Array.isArray(b.items) ? b.items : []);
      if (r.ok) {
        await pool.query("insert into run_events(project_id, type, detail) values ($1,'order_placed',$2)", [orderM[1], `order #${r.order} · total $${r.total}`]).catch(() => {});
        notifyLead(pool, orderM[1], proj.brief, 'order', { order: `#${r.order}`, total: `$${r.total}`, name: b.buyer?.customer_name || b.buyer?.name || '', email: b.buyer?.email || '' });
      }
      return send(res, r.ok ? 200 : 400, 'application/json', JSON.stringify(r));
    }

    if (path === '/api/submissions') {
      const id = url.searchParams.get('id'); if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      const own = await ownerOf(id);
      // public feeds (a site's own 'feed' section) pass a form name; the owner's full Data view does not
      if (!url.searchParams.get('form') && !canSee(user, own)) return send(res, 404, 'application/json', '{"submissions":[]}');
      if (readLimited(clientIp(req))) return send(res, 429, 'application/json', '{"submissions":[],"error":"rate limited"}');
      const form = url.searchParams.get('form');   // public feeds pass a form name; the operator's Data tab omits it (all forms)
      const r = form
        ? await pool.query('select form, data, created_at from site_submissions where project_id=$1 and form=$2 order by created_at desc limit 200', [id, form.slice(0, 60)])
        : await pool.query('select form, data, created_at from site_submissions where project_id=$1 order by created_at desc limit 200', [id]);
      return send(res, 200, 'application/json', JSON.stringify({ submissions: r.rows }));
    }

    // CSV EXPORT (owner-only): download a collection — same guard as the content admin
    const exportM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/export\/([a-zA-Z_][a-zA-Z0-9_]{0,62})\.csv$/);
    if (exportM && req.method === 'GET') {
      if (!UUID_RE.test(exportM[1])) return send(res, 404, 'text/plain', 'not found');
      if (!canSee(user, await ownerOf(exportM[1]))) return send(res, 404, 'text/plain', 'not found');
      const csv = await appdb.exportCsv(pool, exportM[1], exportM[2]).catch(() => null);
      if (csv === null) return send(res, 404, 'text/plain', 'not found');
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${exportM[2]}.csv"` });
      res.end(csv);
      return;
    }

    // ---- PQ3 · CLIENT CONTENT ADMIN (owner-only): edit the site's real content (products/menu/…) ----
    // Directus can't reach the app_<hex> schema (separate DB), so the OWNER edits content here; the
    // live site reads these tables live, so an edit shows immediately.
    const contentM = path.match(/^\/api\/site\/([0-9a-f-]{36})\/content(?:\/([a-zA-Z_][a-zA-Z0-9_]{0,62}))?(?:\/(\d{1,12}))?$/);
    if (contentM) {
      if (!UUID_RE.test(contentM[1])) return send(res, 404, 'application/json', '{"error":"unknown site"}');
      if (!canSee(user, await ownerOf(contentM[1]))) return send(res, 404, 'application/json', '{"error":"not found"}');
      const sid = contentM[1], table = contentM[2], rid = contentM[3] ? Number(contentM[3]) : null;
      // list the editable collections
      if (!table && req.method === 'GET') {
        try {
          const collections = await appdb.contentTables(pool, sid);
          // the OWNER's calendar link rides along (key-auth'd feed from the integrations step)
          const ck = (await pool.query("select params->>'cal_key' as k from projects where id=$1", [sid])).rows[0]?.k;
          const calUrl = ck ? `${process.env.PUBLIC_URL || 'https://board.naples.agency'}/api/site/${sid}/calendar.ics?key=${ck}` : null;
          return send(res, 200, 'application/json', JSON.stringify({ collections, calUrl }));
        }
        catch { return send(res, 200, 'application/json', '{"collections":[]}'); }
      }
      // list one collection's rows + its editable columns (for the admin table + edit form)
      if (table && rid === null && req.method === 'GET') {
        try { return send(res, 200, 'application/json', JSON.stringify({ columns: await appdb.formColumns(pool, sid, table, 'owner'), rows: await appdb.readRows(pool, sid, table, 200, 'owner') })); }
        catch { return send(res, 200, 'application/json', '{"columns":[],"rows":[]}'); }
      }
      // IMAGE UPLOAD (owner-only): set a row's photo — body {image:<base64>}; magic-byte checked
      if (table && rid !== null && req.method === 'POST') {
        let raw = ''; let over = false;
        for await (const c of req) { raw += c; if (raw.length > 6_000_000) { over = true; break; } }
        if (over) return send(res, 413, 'application/json', '{"error":"image too large (max 3 MB)"}');
        let b: any = {}; try { b = JSON.parse(raw || '{}'); } catch {}
        const r = await appdb.saveRowImage(pool, sid, table, rid, String(b.image || '')).catch(() => ({ ok: false as const, error: 'upload failed' }));
        return send(res, r.ok ? 200 : 400, 'application/json', JSON.stringify(r));
      }
      // edit one record
      if (table && rid !== null && (req.method === 'PATCH' || req.method === 'PUT')) {
        let raw = ''; for await (const c of req) raw += c;
        let b: any = {}; try { b = JSON.parse(raw || '{}'); } catch {}
        const ok = await appdb.updateRow(pool, sid, table, rid, (b && b.data) || {});
        // FS3 · the loop closes: when the OWNER flips a lifecycle status, the VISITOR hears about it
        // by email (with their receipt link) — recorded in the sent-mail ledger, never self-reported.
        if (ok && b?.data && typeof b.data.status === 'string' && LIFECYCLE_TABLE.test(table)) {
          try {
            const c2 = await appdb.rowContact(pool, sid, table, rid);
            if (c2) {
              const label = table.replace(/_/g, ' ').replace(/ies$/, 'y').replace(/s$/, '');
              const link = c2.ref ? `\n\nSee it here: ${(process.env.PUBLIC_URL || 'https://board.naples.agency')}/sites/${sid}/receipt-${table}-${c2.ref}.html` : '';
              sendMail(pool, sid, c2.email, `Your ${label} is ${String(b.data.status).toLowerCase()}`, `Update on your ${label}: it is now ${String(b.data.status).toUpperCase()}.${link}`).catch(() => {});
            }
          } catch (e: any) { console.error('status notify', sid, table, rid, e?.message ?? e); }
        }
        return send(res, ok ? 200 : 400, 'application/json', JSON.stringify({ ok }));
      }
      // delete one record
      if (table && rid !== null && req.method === 'DELETE') {
        const ok = await appdb.deleteRow(pool, sid, table, rid);
        return send(res, ok ? 200 : 400, 'application/json', JSON.stringify({ ok }));
      }
      // add a record (reuses the validated insert path)
      if (table && rid === null && req.method === 'POST') {
        let raw = ''; for await (const c of req) raw += c;
        let b: any = {}; try { b = JSON.parse(raw || '{}'); } catch {}
        const ok = (await appdb.insertRow(pool, sid, table, (b && b.data) || {}, 'owner')).ok;
        return send(res, ok ? 200 : 400, 'application/json', JSON.stringify({ ok }));
      }
      return send(res, 405, 'application/json', '{"error":"method not allowed"}');
    }

    // ---- Interaction QA (dogfood): a real browser used the site; latest verdict ----
    if (path === '/api/dogfood') {
      const id = url.searchParams.get('id'); if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      if (!canSee(user, await ownerOf(id))) return send(res, 404, 'application/json', '{"summary":null,"issues":[],"checked":{}}');
      try {
        const r = await pool.query('select passed, summary, issues, checked, at from dogfood_reviews where project_id=$1 order by id desc limit 1', [id]);
        return send(res, 200, 'application/json', JSON.stringify(r.rows[0] || { summary: null, issues: [], checked: {} }));
      } catch { return send(res, 200, 'application/json', '{"summary":null,"issues":[],"checked":{}}'); }
    }
    // ---- The data model the agency designed for this project (live introspection) ----
    if (path === '/api/schema') {
      const id = url.searchParams.get('id'); if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      if (!canSee(user, await ownerOf(id))) return send(res, 404, 'application/json', '{"schema":null,"tables":[]}');
      try { return send(res, 200, 'application/json', JSON.stringify(await appdb.describeSchema(pool, id))); }
      catch (e: any) { console.error('schema introspection', id, e?.message ?? e); return send(res, 200, 'application/json', JSON.stringify({ schema: null, tables: [] })); }
    }
    // ---- Visual QA: a vision model reads the produced pages + reports issues ----
    if (path === '/api/qa') {
      const id = url.searchParams.get('id'); if (!id) return send(res, 400, 'application/json', '{"error":"id required"}');
      if (!canSee(user, await ownerOf(id))) return send(res, 404, 'application/json', '{"overall":null,"reviews":[]}');
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
      const pr = (await pool.query('select status, owner_id from projects where id=$1', [id])).rows[0];
      if (!pr || !canSee(user, pr.owner_id)) return send(res, 404, 'application/json', '{"error":"project not found"}');
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
      if (user) await pool.query('update projects set owner_id=$2 where id=$1', [id, user.id]);   // your brief = your site
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
      const pr = (await pool.query('select brief, status, owner_id from projects where id=$1', [id])).rows[0];
      if (!pr || !canSee(user, pr.owner_id)) return send(res, 404, 'application/json', '{"error":"project not found"}');
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
    // THE SOURCE of the "raw Postgres error leaked to the client" class: this catch-all used to echo
    // e.message straight back, so ANY unhandled throw (a bad cast, a constraint, a query typo) dumped
    // internals to whoever hit the URL. Now the real error is logged SERVER-SIDE with a short ref;
    // the client gets an opaque message + that ref. No handler — present or future — can leak again.
    const ref = Math.abs(hashStr(String(e?.stack ?? e?.message ?? e) + req.url)).toString(36).slice(0, 6);
    console.error(`[500 ref=${ref}] ${req.method} ${req.url} —`, e?.stack ?? e?.message ?? e);
    if (!res.headersSent) send(res, 500, 'application/json', JSON.stringify({ error: 'Something went wrong on our end.', ref }));
  }
});

// tiny, dependency-free string hash for an error correlation ref (log ↔ client, no internals shared)
function hashStr(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; } return h; }
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
ensureAuthTables(pool).catch((e) => console.error('auth tables', e?.message));
import('./chat.ts').then((m) => m.ensureChatTables(pool)).catch((e) => console.error('chat tables', e?.message));
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
startTgDoor(pool);

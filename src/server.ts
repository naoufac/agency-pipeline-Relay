// Relay — the live web app. One cohesive frontend (web/) served here, plus the JSON API.
// The website IS the product: submit a brief, watch the agency build it live.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { makePool } from './db.ts';
import { plan } from './planner.ts';
import { runLoop } from './runner.ts';
import { computeKpi } from './kpi.ts';

const pool = makePool();
const PORT = Number(process.env.PORT || 8787);
const WEB = new URL('../web/', import.meta.url);

const STATIC: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html',
  '/styles.css': 'styles.css', '/app.js': 'app.js',
};
const MIME: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript' };

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
  return { project: proj, tasks, edges };
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
      coalesce(round(extract(epoch from (max(t.updated_at) - p.created_at)))::int,0) as wall
    from projects p left join tasks t on t.project_id=p.id
    group by p.id order by p.created_at desc limit 50`);
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

    if (path === '/api/run' && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      let brief = ''; try { brief = (JSON.parse(raw || '{}').brief || '').trim(); } catch {}
      if (!brief) return send(res, 400, 'application/json', JSON.stringify({ error: 'brief required' }));
      const id = await plan(pool, brief);
      runLoop(pool, id, { cap: 4 }).catch((e) => console.error('run', id, e?.message));  // fire-and-forget; board shows it live
      return send(res, 200, 'application/json', JSON.stringify({ id }));
    }

    const file = STATIC[path];
    if (file) {
      const ext = file.split('.').pop()!;
      return send(res, 200, MIME[ext] || 'text/plain', readFileSync(new URL(file, WEB)));
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e: any) {
    send(res, 500, 'text/plain', 'err: ' + (e?.message ?? e));
  }
});
server.listen(PORT, '0.0.0.0', () => console.log('Relay on http://0.0.0.0:' + PORT));

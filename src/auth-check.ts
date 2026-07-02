// auth:check — THE M4 GATE (PLAN.md). Two-user isolation proven against the RUNNING server with
// real session cookies: user B must not see, open, or rebuild user A's project; anonymous must not
// see it either; legacy ownerless projects stay public. Test rows are created directly in the DB
// (no email round-trip needed to prove SCOPING) and cleaned up after. Exit 1 on any failure.
// Run: npm run auth:check (server must be up — default http://127.0.0.1:8787).
import { randomBytes } from 'node:crypto';
import { makePool } from './db.ts';

const BASE = process.env.AUTH_CHECK_BASE || 'http://127.0.0.1:8787';
const pool = makePool();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };
const get = (p: string, cookie?: string) => fetch(BASE + p, { headers: cookie ? { cookie } : {} }).then(r => r.json());

const suffix = randomBytes(4).toString('hex');
const A = `auth-check-a-${suffix}@relay.test`, B = `auth-check-b-${suffix}@relay.test`;
let aId = '', bId = '', projId = '';

try {
  // real users + real session tokens (the same rows verifyMagic would create)
  aId = (await pool.query('insert into users(email) values($1) returning id', [A])).rows[0].id;
  bId = (await pool.query('insert into users(email) values($1) returning id', [B])).rows[0].id;
  const sa = randomBytes(32).toString('hex'), sb = randomBytes(32).toString('hex');
  await pool.query("insert into auth_tokens(token,user_id,kind,expires_at) values($1,$2,'session',now()+interval '1 hour'),($3,$4,'session',now()+interval '1 hour')", [sa, aId, sb, bId]);
  const CA = `relay_session=${sa}`, CB = `relay_session=${sb}`;

  ok('me: A resolves', (await get('/api/me', CA)).email === A);
  ok('me: B resolves', (await get('/api/me', CB)).email === B);
  ok('me: anonymous is null', (await get('/api/me')).email === null);
  ok('me: garbage cookie is null', (await get('/api/me', 'relay_session=' + 'f'.repeat(64))).email === null);

  // A owns a project (planted directly — scoping is what's under test, not the builder)
  projId = (await pool.query("insert into projects(brief, params, status, owner_id) values('auth-check private site','{}','done',$1) returning id", [aId])).rows[0].id;

  const listA = await get('/api/projects', CA), listB = await get('/api/projects', CB), listAnon = await get('/api/projects');
  ok('list: A sees A\'s project', listA.some((p: any) => p.id === projId));
  ok('list: B does NOT', !listB.some((p: any) => p.id === projId));
  ok('list: anonymous does NOT', !listAnon.some((p: any) => p.id === projId));
  ok('list: B sees none of A\'s at all', !listB.some((p: any) => String(p.brief).includes('auth-check')));
  ok('list: anonymous still sees the public/legacy board', listAnon.length > 0);

  ok('board: A opens own project', (await get('/api/board?id=' + projId, CA)).project?.id === projId);
  ok('board: B gets nothing', (await get('/api/board?id=' + projId, CB)).project === null);
  ok('board: anonymous gets nothing', (await get('/api/board?id=' + projId)).project === null);

  ok('kpi: B blocked', (await fetch(`${BASE}/api/kpi?id=${projId}`, { headers: { cookie: CB } })).status === 404);
  ok('submissions (Data tab): B blocked', ((await get(`/api/submissions?id=${projId}`, CB)).submissions || []).length === 0);
  const rb = await fetch(`${BASE}/api/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: CB }, body: JSON.stringify({ id: projId }) });
  ok('rebuild: B blocked (404, no existence leak)', rb.status === 404);
  ok('schema: B blocked', (await get(`/api/schema?id=${projId}`, CB)).schema === null);
  // PQ3 content admin is owner-only: B cannot list/edit A's content
  const cList = await fetch(`${BASE}/api/site/${projId}/content`, { headers: { cookie: CB } });
  ok('content list: B blocked (404)', cList.status === 404);
  const cEdit = await fetch(`${BASE}/api/site/${projId}/content/products/1`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: CB }, body: JSON.stringify({ data: { price: 1 } }) });
  ok('content edit: B blocked (404, no leak)', cEdit.status === 404);
  const cAnon = await fetch(`${BASE}/api/site/${projId}/content`);
  ok('content list: anonymous blocked', cAnon.status === 404);

  // legacy ownerless projects remain public (the demo board)
  const legacy = (await pool.query('select id from projects where owner_id is null limit 1')).rows[0];
  if (legacy) ok('legacy: anonymous can open ownerless project', (await get('/api/board?id=' + legacy.id)).project?.id === legacy.id);

  // expired + used sessions die
  await pool.query("update auth_tokens set expires_at=now()-interval '1 minute' where token=$1", [sa]);
  ok('expired session is signed out', (await get('/api/me', CA)).email === null);
} catch (e: any) {
  fail++; console.error('  ✗ threw:', e?.message ?? e);
} finally {
  if (projId) await pool.query('delete from projects where id=$1', [projId]).catch(() => {});
  await pool.query("delete from users where email like 'auth-check-%@relay.test'").catch(() => {});
}
console.log(`\nauth:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

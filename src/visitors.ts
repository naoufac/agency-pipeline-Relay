// FS2 — VISITOR ACCOUNTS on the PRODUCED app (the locked promise: "a full-stack app with a database
// and user accounts"). End-users sign in on the produced site itself: email → magic link → My
// bookings, scoped to their verified address. Same safety contract as appdb: everything lives in the
// app's OWN app_<hex> schema, identifier-validated, parameterized.
//
// Identity model: the VERIFIED EMAIL is the identity. A visitor's records are the rows in the app's
// private tables that carry that email — which makes accounts work retroactively (pre-account
// bookings appear the moment the address is verified; nothing to claim, nothing to guess).
//
// Security boundary: SERVER-SIDE token validation against the app's own _relay_visitor_tokens table.
// The cookie (relay_v_<hex12>, per-app name) is convenience only — a token from app A simply does
// not exist in app B's schema, so cross-app replay is structurally dead.
//
// Table namespace: _relay_visitors / _relay_visitor_tokens. The data-model compiler snake()s entity
// names and STRIPS leading underscores, so a composed model can never collide with these.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { PRIVATE_READ } from './schema.ts';
import { schemaName, listTables } from './appdb.ts';

const MAGIC_TTL_MIN = 15, SESSION_TTL_DAYS = 30, MAGIC_PER_EMAIL_PER_DAY = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/i;

export type Visitor = { id: number; email: string };

async function ensureTables(pool: pg.Pool, projectId: string): Promise<string> {
  const schema = schemaName(projectId);
  await pool.query(`create table if not exists "${schema}"."_relay_visitors" (
    id serial primary key, email text not null unique, created_at timestamptz not null default now())`);
  await pool.query(`create table if not exists "${schema}"."_relay_visitor_tokens" (
    token text primary key, visitor_id integer not null references "${schema}"."_relay_visitors"(id) on delete cascade,
    kind text not null check (kind in ('magic','session')), expires_at timestamptz not null,
    used_at timestamptz, created_at timestamptz not null default now())`);
  return schema;
}

// Step 1 — request: create (or find) the visitor and mint a single-use magic token. INTERNAL: the
// route mails the link and always answers "sent"; this function never sends anything (probes read
// the token straight from here — no real mail in gates). Per-email daily cap, so the mailbox of a
// stranger can't be flooded through us.
export async function requestVisitorMagic(pool: pg.Pool, projectId: string, email: string): Promise<{ token?: string; capped?: boolean }> {
  const em = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(em) || em.length > 254) return {};
  const schema = await ensureTables(pool, projectId);
  const v = (await pool.query(
    `insert into "${schema}"."_relay_visitors" (email) values ($1) on conflict (email) do update set email=excluded.email returning id`, [em])).rows[0];
  const recent = Number((await pool.query(
    `select count(*)::int n from "${schema}"."_relay_visitor_tokens" where visitor_id=$1 and kind='magic' and created_at > now() - interval '1 day'`, [v.id])).rows[0].n);
  if (recent >= MAGIC_PER_EMAIL_PER_DAY) return { capped: true };
  const token = randomBytes(16).toString('hex');
  await pool.query(
    `insert into "${schema}"."_relay_visitor_tokens" (token, visitor_id, kind, expires_at) values ($1,$2,'magic', now() + interval '${MAGIC_TTL_MIN} minutes')`, [token, v.id]);
  return { token };
}

// Step 2 — verify: exchange a live magic token (unused, unexpired) for a session token. Single-use
// is enforced in the UPDATE itself (used_at is null) — two clicks can't both win.
export async function verifyVisitorMagic(pool: pg.Pool, projectId: string, token: string): Promise<{ session: string; visitor: Visitor } | null> {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const schema = await ensureTables(pool, projectId);
  const r = await pool.query(
    `update "${schema}"."_relay_visitor_tokens" set used_at=now()
     where token=$1 and kind='magic' and used_at is null and expires_at > now() returning visitor_id`, [token]);
  if (!r.rowCount) return null;
  const vid = Number(r.rows[0].visitor_id);
  const session = randomBytes(16).toString('hex');
  await pool.query(
    `insert into "${schema}"."_relay_visitor_tokens" (token, visitor_id, kind, expires_at) values ($1,$2,'session', now() + interval '${SESSION_TTL_DAYS} days')`, [session, vid]);
  // lazy sweep: expired tokens don't accumulate
  await pool.query(`delete from "${schema}"."_relay_visitor_tokens" where expires_at < now() - interval '7 days'`).catch(() => {});
  const v = (await pool.query(`select id, email from "${schema}"."_relay_visitors" where id=$1`, [vid])).rows[0];
  return v ? { session, visitor: { id: Number(v.id), email: String(v.email) } } : null;
}

// The per-app cookie name — collision-free across the many apps on one origin. The NAME scopes which
// token is presented; the SCHEMA validates whether it means anything.
export const visitorCookieName = (projectId: string) => 'relay_v_' + schemaName(projectId).slice(4, 16);
export const visitorCookie = (projectId: string, session: string) =>
  `${visitorCookieName(projectId)}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 86400}${/^https:/.test(process.env.PUBLIC_URL || '') ? '; Secure' : ''}`;
export const clearVisitorCookie = (projectId: string) => `${visitorCookieName(projectId)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function visitorFromCookie(pool: pg.Pool, projectId: string, cookieHeader: string | undefined): Promise<Visitor | null> {
  const m = String(cookieHeader || '').match(new RegExp('(?:^|;\\s*)' + visitorCookieName(projectId) + '=([0-9a-f]{32})'));
  if (!m) return null;
  return visitorFromSession(pool, projectId, m[1]);
}
export async function visitorFromSession(pool: pg.Pool, projectId: string, session: string): Promise<Visitor | null> {
  if (!TOKEN_RE.test(String(session || ''))) return null;
  const schema = schemaName(projectId);
  try {
    const r = await pool.query(
      `select v.id, v.email from "${schema}"."_relay_visitor_tokens" t join "${schema}"."_relay_visitors" v on v.id=t.visitor_id
       where t.token=$1 and t.kind='session' and t.expires_at > now()`, [session]);
    return r.rows[0] ? { id: Number(r.rows[0].id), email: String(r.rows[0].email) } : null;
  } catch { return null; }   // app without visitor tables yet -> signed out, never an error
}

export async function logoutVisitor(pool: pg.Pool, projectId: string, cookieHeader: string | undefined): Promise<void> {
  const m = String(cookieHeader || '').match(new RegExp('(?:^|;\\s*)' + visitorCookieName(projectId) + '=([0-9a-f]{32})'));
  if (!m) return;
  const schema = schemaName(projectId);
  await pool.query(`delete from "${schema}"."_relay_visitor_tokens" where token=$1 and kind='session'`, [m[1]]).catch(() => {});
}

// MY BOOKINGS — the visitor's records: rows in the app's private tables carrying their VERIFIED
// email, newest first, each with its receipt link when the row has a token. Server-internal: the
// account page renders this; the public API never exposes an email query.
export async function visitorRecords(pool: pg.Pool, projectId: string, email: string): Promise<{ table: string; row: any; ref: string | null }[]> {
  const em = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(em)) return [];
  const schema = schemaName(projectId);
  const out: { table: string; row: any; ref: string | null }[] = [];
  for (const t of await listTables(pool, projectId)) {
    if (!PRIVATE_READ.test(t) || t.startsWith('_relay_')) continue;
    const cols = (await pool.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2', [schema, t])).rows.map((c: any) => c.column_name);
    const emailCol = ['email', 'customer_email', 'visitor_email', 'contact_email'].find(c => cols.includes(c));
    if (!emailCol) continue;
    const hasRef = cols.includes('ref_token');
    const rows = (await pool.query(`select * from "${schema}"."${t}" where lower("${emailCol}")=$1 order by id desc limit 20`, [em])).rows;
    for (const row of rows) {
      const ref = hasRef && typeof row.ref_token === 'string' ? row.ref_token : null;
      const o: any = { ...row };
      for (const k of Object.keys(o)) if (/pass|secret|token|hash|salt|api_?key|private|credential/i.test(k)) delete o[k];
      out.push({ table: t, row: o, ref });
    }
  }
  return out;
}

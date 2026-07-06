// analytics.ts — ARC J: first-party, cookieless, privacy-first visitor analytics.
//
// DESIGN INVARIANTS (forced in code + DB, never via LLM instructions):
//   • No cookies, no localStorage, no external service, no fingerprinting.
//   • Raw IPs NEVER stored — only sha256(ip + user-agent + day + RELAY_IP_SALT).
//   • Hash rotates daily by construction (day is in the salt input), so cross-day
//     tracking is structurally impossible.
//   • UNIQUE index on (project_id, day, path, visitor_hash) + INSERT … ON CONFLICT
//     DO NOTHING = exactly one count per unique visitor per page per day.
//   • Rows older than 400 days pruned opportunistically on each write (cheap: index-backed
//     DELETE, no separate cron needed — same pattern as anon_runs).
//   • Path is sanitized: leading /, max 200 chars, query strings stripped.
import pg from 'pg';
import { createHash } from 'node:crypto';

// ---- DDL ----

export async function ensureAnalyticsTables(pool: pg.Pool): Promise<void> {
  // site_hits: one row per (project, day, path, visitor_hash).
  // visitor_hash = sha256(ip + ua + day + salt) — raw IP never stored; daily salt rotation
  // makes cross-day linkage structurally impossible; different salt per day means a hash from
  // day N is useless on day N+1 (different output for the same input).
  await pool.query(`
    create table if not exists site_hits (
      project_id   uuid  not null,
      day          date  not null,
      path         text  not null,
      visitor_hash text  not null
    )`);
  // THE ONE GATE: duplicate (project, day, path, visitor_hash) is silently dropped.
  // This is what makes a visitor count ONCE per page per day — no application-level
  // dedup needed, the DB rejects the duplicate at INSERT time (ON CONFLICT DO NOTHING).
  await pool.query(`
    create unique index if not exists site_hits_dedup_ux
      on site_hits(project_id, day, path, visitor_hash)`);
  // Fast aggregation index: all analytics queries are project-scoped and day-ranged.
  await pool.query(`
    create index if not exists site_hits_proj_day_ix
      on site_hits(project_id, day desc)`);
}

// ---- hash ----

// ipSalt: the static secret mixed into every hash. Falls back to a fixed literal so
// dev/test works without config — the fallback is not secret but the raw IP is still
// never stored. Same env var as the anon_runs salt for operational consistency.
function ipSalt(): string {
  return process.env.RELAY_IP_SALT || 'relay-anon-salt-v1';
}

// visitorHash: sha256(ip + ua + day + salt). The day token makes it rotate daily
// so a hash from yesterday cannot be correlated with today — no cross-day tracking.
// Raw IP is never persisted anywhere; this function is the only place it is touched.
export function visitorHash(ip: string, userAgent: string, day: string): string {
  return createHash('sha256')
    .update(ip + '\x00' + userAgent + '\x00' + day + '\x00' + ipSalt())
    .digest('hex');
}

// ---- path sanitization ----

// sanitizePath: strip query strings, enforce leading slash, cap at 200 chars.
// WHY: the beacon sends location.pathname (already query-free) but we enforce server-side
// too — defense in depth. An over-long path is rejected (empty string → caller drops it).
export function sanitizePath(raw: string): string {
  // strip query string (everything from ? onward) — never store user query params
  const noQuery = String(raw || '').split('?')[0].split('#')[0];
  // enforce leading slash
  const slashed = noQuery.startsWith('/') ? noQuery : '/' + noQuery;
  // cap at 200 chars (reject by returning '' — caller drops the hit)
  if (slashed.length > 200) return '';
  // allow empty path to normalise to '/'
  return slashed || '/';
}

// ---- record hit ----

// recordHit: INSERT … ON CONFLICT DO NOTHING — returns true when a new unique visit was
// counted, false when the visitor already counted for this page/day (duplicate silently dropped).
// Also prunes rows older than 400 days opportunistically (one cheap DELETE per call).
export async function recordHit(
  pool: pg.Pool,
  projectId: string,
  path: string,
  ip: string,
  userAgent: string,
): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);   // UTC YYYY-MM-DD
  const hash = visitorHash(ip, userAgent, day);
  const safe = sanitizePath(path);
  if (!safe) return false;   // path too long or completely empty after sanitize

  // Prune rows older than 400 days before insert (cheap: index-backed, fire-and-forget).
  // 400d matches the spec (GDPR-safe retention window).
  await pool.query(
    `delete from site_hits where day < current_date - interval '400 days'`).catch(() => {});

  const r = await pool.query(
    `insert into site_hits(project_id, day, path, visitor_hash)
     values ($1, $2::date, $3, $4)
     on conflict (project_id, day, path, visitor_hash) do nothing`,
    [projectId, day, safe, hash]);
  return (r.rowCount ?? 0) > 0;
}

// ---- aggregate visits for owner view ----

export interface VisitStats {
  today:    number;
  last7:    number;
  last30:   number;
  topPaths: Array<{ path: string; n: number }>;
}

// visitsForProject: SQL aggregation over site_hits for the owner dashboard.
// Returns counts for today / last 7d / last 30d and the top-5 paths of the last 30d.
// WHY SQL not application-level: single round-trip, DB does the math, no row-by-row
// transfer — the table can grow to millions of rows and this stays O(index range scan).
export async function visitsForProject(
  pool: pg.Pool,
  projectId: string,
): Promise<VisitStats> {
  const r = await pool.query(`
    select
      count(*) filter (where day = current_date)::int                         as today,
      count(*) filter (where day >= current_date - interval '6 days')::int    as last7,
      count(*) filter (where day >= current_date - interval '29 days')::int   as last30
    from site_hits
    where project_id = $1
      and day >= current_date - interval '29 days'
  `, [projectId]);

  const top = await pool.query(`
    select path, count(*)::int as n
    from site_hits
    where project_id = $1
      and day >= current_date - interval '29 days'
    group by path
    order by n desc
    limit 5
  `, [projectId]);

  return {
    today:    Number(r.rows[0]?.today    ?? 0),
    last7:    Number(r.rows[0]?.last7    ?? 0),
    last30:   Number(r.rows[0]?.last30   ?? 0),
    topPaths: top.rows.map((row) => ({ path: String(row.path), n: Number(row.n) })),
  };
}

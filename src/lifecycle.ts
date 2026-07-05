// lifecycle.ts — CLOSING THE BOOKING LOOP (pipeline depth, owner directive "the 14 steps are not
// enough"). Two capabilities every produced app gets for free, both deterministic:
//   1. ONE-TAP OWNER ACTIONS — the lead email carries signed Confirm/Decline links. GET shows a
//      button page (mail scanners prefetch GETs — a prefetch must never flip a booking); POST
//      performs. Confirmed/declined flows back to the VISITOR by localized email, and a declined
//      booking frees its slot (the slot guard already ignores declined/cancelled rows).
//   2. BOOKING REMINDERS — a sweep finds bookings starting inside the reminder window and emails
//      the visitor once, in the site's language. Idempotent via a sent-log in the main DB; a
//      failed send is NOT logged, so the next sweep retries it.
// The HMAC token is the auth (the operator's inbox is the trust boundary — same model as the
// calendar-feed key). No RELAY_SECRET → no links, routes 404: deterministic degradation.
import pg from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as appdb from './appdb.ts';
import { LIFECYCLE_TABLE, PRIVATE_READ, pickWhenColumn } from './schema.ts';
import { sendMail, isQaProbe } from './mail.ts';
import { L, isLocale } from './i18n.ts';
import { ev } from './db.ts';

export type Action = 'confirm' | 'decline';
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function actToken(projectId: string, ref: string, action: Action): string | null {
  const secret = process.env.RELAY_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update(`${projectId}.${ref}.${action}`).digest('hex').slice(0, 32);
}

export function verifyAct(projectId: string, ref: string, action: Action, token: string): boolean {
  const want = actToken(projectId, ref, action);
  if (!want || !/^[0-9a-f]{32}$/.test(String(token || ''))) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

// locate the lifecycle row a receipt ref points at — actionTable first, then the other private tables
export async function findByRef(pool: pg.Pool, projectId: string, ref: string): Promise<{ table: string; row: any } | null> {
  if (!/^[0-9a-f]{16,64}$/i.test(String(ref || ''))) return null;
  const schema = appdb.schemaName(projectId);
  const params = (await pool.query('select params from projects where id=$1', [projectId])).rows[0]?.params || {};
  const tables = await appdb.listTables(pool, projectId).catch(() => [] as string[]);
  const candidates = [...new Set([String(params?.schema_forms?.actionTable || ''), ...tables.filter((t) => PRIVATE_READ.test(t))])].filter(Boolean);
  for (const t of candidates) {
    if (!tables.includes(t) || !IDENT.test(t) || !LIFECYCLE_TABLE.test(t)) continue;
    const cols = (await pool.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2', [schema, t])).rows.map((r: any) => r.column_name);
    if (!cols.includes('ref_token') || !cols.includes('status')) continue;
    const row = (await pool.query(`select * from "${schema}"."${t}" where "ref_token"=$1 limit 1`, [ref])).rows[0];
    if (row) return { table: t, row };
  }
  return null;
}

// legal transitions only: pending → confirmed/declined; confirmed → declined (a late cancellation).
// declined/cancelled are final. Anything else reports `already` with the current status.
export async function applyAction(pool: pg.Pool, projectId: string, ref: string, action: Action): Promise<{ ok: boolean; already?: string; table?: string }> {
  const hit = await findByRef(pool, projectId, ref);
  if (!hit) return { ok: false };
  const cur = String(hit.row.status || 'pending');
  const next = action === 'confirm' ? 'confirmed' : 'declined';
  const legal = (cur === 'pending') || (cur === 'confirmed' && next === 'declined');
  if (cur === next) return { ok: true, already: cur, table: hit.table };
  if (!legal) return { ok: false, already: cur, table: hit.table };
  const schema = appdb.schemaName(projectId);
  await pool.query(`update "${schema}"."${hit.table}" set "status"=$1 where "ref_token"=$2`, [next, ref]);
  await ev(pool, projectId, null, 'lifecycle_' + next, `${hit.table} · ref ${String(ref).slice(0, 8)}…`).catch(() => {});
  // the VISITOR hears the verdict — localized, with their receipt link (never for QA probes)
  const proj = (await pool.query("select params->>'slug' as slug, params->>'locale' as loc from projects where id=$1", [projectId])).rows[0];
  const vmail = String(hit.row.email || hit.row.customer_email || '').trim();
  if (proj && !isQaProbe(hit.row) && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(vmail)) {
    const base = proj.slug ? `https://${proj.slug}.naples.agency` : `${process.env.PUBLIC_URL || 'https://board.naples.agency'}/sites/${projectId}`;
    const thing = hit.table.replace(/s$/, '').replace(/_/g, ' ');
    const link = `${base}/receipt-${hit.table}-${ref}.html`;
    sendMail(pool, projectId, vmail,
      L(proj.loc, `mail_status_${next}_subject`, { x: thing }),
      L(proj.loc, `mail_status_${next}_body`, { x: thing, link })).catch(() => {});
  }
  return { ok: true, table: hit.table };
}

export async function ensureLifecycleTables(pool: pg.Pool): Promise<void> {
  await pool.query(`create table if not exists reminder_log (
    project_id uuid not null, tbl text not null, row_id bigint not null,
    sent_at timestamptz not null default now(), primary key (project_id, tbl, row_id)
  )`);
}

export type Sender = (pool: pg.Pool, projectId: string, to: string, subject: string, text: string) => Promise<{ ok: boolean }>;

// REMINDERS: bookings starting within `hours` get one localized email. The sent-log insert-first
// (on conflict do nothing) claims the row so overlapping sweeps can't double-send; a FAILED send
// releases the claim so the next sweep retries. Capped per sweep — the cap is logged, never silent.
export async function sweepReminders(pool: pg.Pool, opts: { hours?: number; cap?: number; send?: Sender; projectIds?: string[] } = {}): Promise<number> {
  const hours = Math.min(168, Math.max(1, Number(process.env.REMINDER_HOURS || opts.hours || 24)));
  const cap = opts.cap ?? 100;
  const send = opts.send || sendMail;
  // the log is append-only per booking; a booking 60+ days past will never be swept again, so its
  // claim can go — keeps reminder_log from growing without bound. (audit 2026-07-05)
  await pool.query("delete from reminder_log where sent_at < now() - interval '60 days'").catch(() => {});
  const projects = (await pool.query(
    `select id, params->>'slug' as slug, params->>'locale' as loc, params->'schema_forms'->>'actionTable' as act from projects where status='done'${opts.projectIds ? ' and id = any($1)' : ''}`,
    opts.projectIds ? [opts.projectIds] : [])).rows;
  let sent = 0;
  for (const p of projects) {
    if (sent >= cap) { console.log(`reminders: cap ${cap} reached — remaining projects wait for the next sweep`); break; }
    // ONE project's bad schema/locale must never abort the sweep for everyone else. (audit 2026-07-05)
    try {
      const loc = isLocale(p.loc) ? p.loc : 'en';   // a corrupt locale would throw in Intl and kill the run
      const schema = appdb.schemaName(p.id);
      const tables = await appdb.listTables(pool, p.id).catch(() => [] as string[]);
      for (const t of [...new Set([String(p.act || ''), ...tables.filter((x) => LIFECYCLE_TABLE.test(x))])].filter(Boolean)) {
        if (!tables.includes(t) || !IDENT.test(t)) continue;
        const cols = (await pool.query('select column_name as name, data_type as type from information_schema.columns where table_schema=$1 and table_name=$2', [schema, t])).rows;
        const names = cols.map((c: any) => c.name);
        const when = pickWhenColumn(cols);   // the EVENT column, never date_of_birth / created_at
        const mailCol = names.includes('email') ? 'email' : (names.includes('customer_email') ? 'customer_email' : null);
        if (!when || !mailCol) continue;
        const rows = (await pool.query(
          `select r.* from "${schema}"."${t}" r
           where r."${when}" > now() and r."${when}" <= now() + ($1 || ' hours')::interval
             and coalesce(r."${mailCol}",'') <> ''
             ${names.includes('status') ? "and coalesce(r.\"status\",'pending') not in ('declined','cancelled')" : ''}
             and not exists (select 1 from public.reminder_log l where l.project_id=$2 and l.tbl=$3 and l.row_id=r.id)
           order by r."${when}" limit 50`, [String(hours), p.id, t])).rows;
        for (const r of rows) {
          if (sent >= cap) break;
          if (isQaProbe(r)) continue;
          const claimed = await pool.query('insert into reminder_log(project_id, tbl, row_id) values ($1,$2,$3) on conflict do nothing returning 1', [p.id, t, r.id]);
          if (!claimed.rows.length) continue;   // another sweep owns it
          const base = p.slug ? `https://${p.slug}.naples.agency` : `${process.env.PUBLIC_URL || 'https://board.naples.agency'}/sites/${p.id}`;
          const thing = t.replace(/s$/, '').replace(/_/g, ' ');
          const whenTxt = new Intl.DateTimeFormat(loc, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(r[when]));
          const link = r.ref_token ? `\n\n${base}/receipt-${t}-${r.ref_token}.html` : `\n\n${base}`;
          const res = await send(pool, p.id, String(r[mailCol]).trim(),
            L(loc, 'mail_reminder_subject', { x: thing }),
            L(loc, 'mail_reminder_body', { x: thing, when: whenTxt }) + link).catch(() => ({ ok: false }));
          if (res.ok) { sent++; await ev(pool, p.id, null, 'reminder_sent', `${t} #${r.id} · ${whenTxt}`).catch(() => {}); }
          else await pool.query('delete from reminder_log where project_id=$1 and tbl=$2 and row_id=$3', [p.id, t, r.id]).catch(() => {});
        }
      }
    } catch (e: any) {
      console.error('reminders: project skipped after error', p.id, e?.message ?? e);
    }
  }
  return sent;
}

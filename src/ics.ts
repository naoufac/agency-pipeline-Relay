// ics.ts — OWNER CALENDAR FEED. Every app whose action table carries a timestamp gets a live
// iCalendar feed: the owner pastes ONE url into Google/Apple Calendar and every booking lands
// on their phone forever. Deterministic — rows in, VEVENTs out; the key is the auth (calendar
// clients cannot sign in), minted once per project like a ref_token.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import * as appdb from './appdb.ts';
import { PRIVATE_READ } from './schema.ts';

export async function calKeyFor(pool: pg.Pool, projectId: string): Promise<string> {
  const cur = (await pool.query("select params->>'cal_key' as k from projects where id=$1", [projectId])).rows[0]?.k;
  if (cur) return cur;
  const k = randomBytes(16).toString('hex');
  await pool.query("update projects set params = jsonb_set(params, '{cal_key}', to_jsonb($2::text), true) where id=$1 and (params->>'cal_key') is null", [projectId, k]);
  // a concurrent mint may have won — the stored value is the truth
  return (await pool.query("select params->>'cal_key' as k from projects where id=$1", [projectId])).rows[0]?.k || k;
}

const icsEsc = (s: string) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n').slice(0, 250);
const icsDt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

// the action table's upcoming rows become VEVENTs. Table choice: the schema snapshot's actionTable,
// else the first PRIVATE table with a timestamp column. Rows older than 30 days are left out.
export async function buildIcs(pool: pg.Pool, projectId: string): Promise<string | null> {
  const params = (await pool.query('select params from projects where id=$1', [projectId])).rows[0]?.params || {};
  const brand = String(params?.brand?.name || 'Relay app');
  const tables: string[] = await appdb.listTables(pool, projectId).catch(() => []);
  const candidates = [String(params?.schema_forms?.actionTable || ''), ...tables.filter((t) => PRIVATE_READ.test(t))].filter(Boolean);
  for (const t of [...new Set(candidates)]) {
    if (!tables.includes(t)) continue;
    const cols = await appdb.formColumns(pool, projectId, t, 'owner').catch(() => []);
    const when = cols.find((c: any) => /timestamp|date/.test(String(c.type)) && !/created_at/.test(c.name));
    if (!when) continue;
    const nameCol = cols.find((c: any) => /(^|_)name$/.test(c.name))?.name;
    const rows = await appdb.readRows(pool, projectId, t, 500, 'owner').catch(() => []);
    const events: string[] = [];
    for (const r of rows) {
      const ts = r[when.name] ? new Date(r[when.name]) : null;
      if (!ts || isNaN(+ts) || +ts < Date.now() - 30 * 86_400_000) continue;
      const who = nameCol && r[nameCol] ? String(r[nameCol]) : `#${r.id}`;
      const status = r.status ? ` [${r.status}]` : '';
      const details = ['email', 'phone', 'notes', 'party_size'].map((k) => (r[k] != null && r[k] !== '' ? `${k}: ${r[k]}` : '')).filter(Boolean).join(' · ');
      events.push([
        'BEGIN:VEVENT',
        `UID:${t}-${r.id}@${projectId}`,
        `DTSTAMP:${icsDt(new Date())}`,
        `DTSTART:${icsDt(ts)}`,
        `DTEND:${icsDt(new Date(+ts + 60 * 60_000))}`,
        `SUMMARY:${icsEsc(who + status + ' — ' + brand)}`,
        details ? `DESCRIPTION:${icsEsc(details)}` : '',
        'END:VEVENT',
      ].filter(Boolean).join('\r\n'));
    }
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//Relay//${icsEsc(brand)}//EN`, `X-WR-CALNAME:${icsEsc(brand)}`, ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
  }
  return null;   // no action table with a timestamp — honestly no feed (a contact-form site)
}

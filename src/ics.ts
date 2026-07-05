// ics.ts — OWNER CALENDAR FEED. Every app whose action table carries a timestamp gets a live
// iCalendar feed: the owner pastes ONE url into Google/Apple Calendar and every booking lands
// on their phone forever. Deterministic — rows in, VEVENTs out; the key is the auth (calendar
// clients cannot sign in), minted once per project like a ref_token.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import * as appdb from './appdb.ts';
import { PRIVATE_READ, pickWhenColumn } from './schema.ts';

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
const icsDate = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');   // YYYYMMDD for VALUE=DATE

// RFC 5545 §3.1: content lines MUST be folded at 75 OCTETS, continuation lines prefixed with a space.
// Strict parsers (and some Outlook flows) reject longer lines. Fold on codepoint boundaries so a
// multibyte char (é, €) is never split across the fold. (adversarial audit 2026-07-05)
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out: string[] = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    const budget = out.length === 0 ? 75 : 74;   // continuation lines carry a leading space (1 octet)
    if (bytes + b > budget) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ' ' + l)).join('\r\n');
}

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
    const whenName = pickWhenColumn(cols as any);   // the EVENT column, never date_of_birth / created_at
    const when = whenName ? (cols as any[]).find((c: any) => c.name === whenName) : null;
    if (!when) continue;
    const dateOnly = String(when.type) === 'date';   // a date column is an ALL-DAY event, not 00:00Z
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
        dateOnly ? `DTSTART;VALUE=DATE:${icsDate(ts)}` : `DTSTART:${icsDt(ts)}`,
        dateOnly ? `DTEND;VALUE=DATE:${icsDate(new Date(+ts + 86_400_000))}` : `DTEND:${icsDt(new Date(+ts + 60 * 60_000))}`,
        `SUMMARY:${icsEsc(who + status + ' — ' + brand)}`,
        details ? `DESCRIPTION:${icsEsc(details)}` : '',
        'END:VEVENT',
      ].filter(Boolean).join('\r\n'));
    }
    const doc = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//Relay//${icsEsc(brand)}//EN`, `X-WR-CALNAME:${icsEsc(brand)}`, ...events, 'END:VCALENDAR'].join('\r\n');
    return doc.split('\r\n').map(foldLine).join('\r\n') + '\r\n';   // fold every physical line to ≤75 octets
  }
  return null;   // no action table with a timestamp — honestly no feed (a contact-form site)
}

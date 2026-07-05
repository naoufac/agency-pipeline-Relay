// digest.ts — THE MORNING BRIEF: one Telegram message, every number read from the database
// (never an agent's word). What the agency did in the last 24h, what its client apps
// collected (bookings/orders — the reason the sites exist), and whether the machinery
// (canary · backup · watchdog · quota · disk) is healthy. Run: npm run digest
// (prod: relay-digest.timer, daily 07:30 UTC). DIGEST_DRY=1 prints instead of sending.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { makePool } from './db.ts';
import { PRIVATE_READ } from './schema.ts';
import { telegramAlert } from './alert.ts';

const pool = makePool();

async function activity24h(): Promise<{ rows: number; apps: number }> {
  // new rows in PRIVATE tables only (bookings/orders/messages): seed hygiene strips seeds from
  // private tables, so every row here was written by a REAL VISITOR — never build-time fiction.
  const schemas = (await pool.query("select schema_name from information_schema.schemata where schema_name like 'app_%'")).rows;
  let rows = 0, apps = 0;
  for (const sc of schemas) {
    const tabs = (await pool.query(
      `select c.table_name from information_schema.columns c where c.table_schema=$1 and c.column_name='created_at'
       group by c.table_name`, [sc.schema_name])).rows;
    let n = 0;
    for (const t of tabs) {
      if (!/^[a-z_][a-z0-9_]*$/.test(t.table_name) || /^_relay_/.test(t.table_name) || !PRIVATE_READ.test(t.table_name)) continue;
      try { n += Number((await pool.query(`select count(*)::int c from "${sc.schema_name}"."${t.table_name}" where created_at > now() - interval '24 hours'`)).rows[0].c); } catch {}
    }
    if (n > 0) { rows += n; apps++; }
  }
  return { rows, apps };
}

async function main() {
  const b = (await pool.query(`
    select count(*)::int as started,
      count(*) filter (where status='done')::int as done,
      count(*) filter (where status='blocked')::int as blocked
    from projects where created_at > now() - interval '24 hours'`)).rows[0];
  const rv = (await pool.query(`
    select count(*) filter (where passed)::int as passed, count(*) filter (where not passed)::int as failed
    from dogfood_reviews where at > now() - interval '24 hours'`)).rows[0];
  const apk = (await pool.query("select count(*)::int n from run_events where type='apk_built' and at > now() - interval '24 hours'")).rows[0].n;
  const stalled = (await pool.query(`
    select count(distinct project_id)::int n from run_events
    where type='quota_stall' and at > now() - interval '24 hours'`)).rows[0].n;
  const canary = (await pool.query(`
    select p.status, (select d.passed from dogfood_reviews d where d.project_id=p.id order by d.id desc limit 1) as passed
    from projects p where brief like '%— canary 2%' and created_at > now() - interval '24 hours'
    order by created_at desc limit 1`)).rows[0];
  const act = await activity24h();

  let backup = '🔴 no vault manifest — BACKUPS MAY BE DEAD';
  try {
    const m = JSON.parse(readFileSync('/root/relay-vault/manifest-latest.json', 'utf8'));
    const ageH = Math.round((Date.now() - Date.parse(m.stamp)) / 3_600_000);
    // >30h = last night's run did NOT ship — say it like the alarm it is, never a calm statistic
    backup = ageH > 30 ? `🔴 STALE — last shipped ${ageH}h ago. Check relay-backup.service.` : `${ageH}h ago · ${Math.round(m.dump_bytes / 1e6)}MB · ${m.projects} projects`;
  } catch {}
  // the FALLBACK provider gets a daily 8-token ping — a stale second key must surface NOW,
  // not on the day the primary lapses and the failover silently has nothing to fail over to
  let fallback = '';
  try {
    const { pingFallback } = await import('./agents.ts');
    const f = await pingFallback();
    if (f !== null) fallback = f ? '' : '🔑 FALLBACK PROVIDER DEAD — failover has nothing to fail over to';
  } catch {}
  let disk = '?';
  try { disk = execSync("df -h / | tail -1 | awk '{print $4}'", { encoding: 'utf8' }).trim(); } catch {}
  let surfaces = '';
  for (const s of ['board', 'sites', 'cms']) {
    try { surfaces += `${readFileSync(`/tmp/relay-uptime-${s}.state`, 'utf8').trim() === 'up' ? '✅' : '🔴'}${s} `; } catch { surfaces += `·${s} `; }
  }

  const canaryLine = canary
    ? (canary.passed === true ? '✅ green' : canary.passed === false ? '🔴 review failed' : `⏳ ${canary.status}`)
    : (stalled > 0 ? '⏭ skipped (quota)' : '— none flown');

  const msg = [
    `📊 RELAY — daily brief`,
    ``,
    `Builds 24h: ${b.started} started · ${b.done} done · ${b.blocked} blocked`,
    `Reviews: ${rv.passed} passed · ${rv.failed} failed · APKs: ${apk}`,
    `Client activity: ${act.rows} new record${act.rows === 1 ? '' : 's'} across ${act.apps} app${act.apps === 1 ? '' : 's'}`,
    ``,
    `Canary: ${canaryLine}`,
    `Vault: ${backup}`,
    `Surfaces: ${surfaces.trim()} · Disk free: ${disk}`,
    stalled > 0 ? `⏸ ${stalled} build(s) quota-stalled — top up a provider to resume` : '',
    fallback,
  ].filter(Boolean).join('\n');

  if (process.env.DIGEST_DRY === '1') console.log(msg);
  else { const r = await telegramAlert(msg); if (!r.ok) { console.error('digest send failed:', r.error); process.exit(1); } }
  await pool.end();
}
main().catch((e) => { console.error('digest error:', e?.message ?? e); process.exit(1); });

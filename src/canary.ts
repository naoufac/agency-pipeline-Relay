// canary.ts — THE NIGHTLY SELF-PROOF. The 13 gate suites test components; the canary tests THE
// CHAIN: one rotating brief (app / store / warm+blog — the three archetypes), built zero-touch
// through the LIVE server, judged by the standing review. Green = one quiet log line and the
// previous canary is swept. Anything else = the operator's phone rings (telegramAlert). This is
// the drift detector: an LLM behavior shift that degrades builds surfaces the same night, not
// when a client finds it. Run: npm run canary (prod: relay-canary.timer, nightly).
import { makePool } from './db.ts';
import { telegramAlert } from './alert.ts';

const BRIEFS = [
  'a barbershop booking app — customers pick a barber, a service and a time slot, and book',
  'an online store for a small-batch candle maker — classic scents in three sizes',
  'a neighborhood taqueria with weekend reservations and a blog of family recipes',
];
const BASE = process.env.CANARY_BASE || 'http://127.0.0.1:8787';
const BOARD = process.env.PUBLIC_URL || 'https://board.naples.agency';

async function sweepOldCanaries(pool: any, keepId: string) {
  const old = (await pool.query("select id from projects where brief like '%— canary 2%' and id<>$1", [keepId])).rows;
  const { rmSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  for (const o of old) {
    await pool.query(`drop schema if exists "app_${String(o.id).replace(/-/g, '').slice(0, 32)}" cascade`).catch(() => {});
    for (const t of ['dogfood_reviews', 'run_events', 'tasks', 'site_submissions']) await pool.query(`delete from ${t} where project_id=$1`, [o.id]).catch(() => {});
    await pool.query('delete from projects where id=$1', [o.id]).catch(() => {});
    try { rmSync(fileURLToPath(new URL('../sites/' + o.id, import.meta.url)), { recursive: true, force: true }); } catch {}
  }
  return old.length;
}

async function main() {
  const pool = makePool();
  const day = Math.floor(Date.now() / 86_400_000);
  const brief = `${BRIEFS[day % BRIEFS.length]} — canary ${new Date().toISOString().slice(0, 10)}`;
  const t0 = Date.now();
  let id = '';
  try {
    const r: any = await (await fetch(`${BASE}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brief }) })).json();
    id = String(r?.id || '');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('run refused: ' + JSON.stringify(r).slice(0, 200));
    console.log(`canary building: ${brief} · ${id}`);
    const deadline = Date.now() + 35 * 60 * 1000;
    for (;;) {
      await new Promise(res => setTimeout(res, 30_000));
      const p = (await pool.query(
        `select status,
           (select d.passed from dogfood_reviews d where d.project_id=$1 order by d.id desc limit 1) as passed,
           (select count(*)::int from tasks where project_id=$1 and status in ('ready','running','verifying')) as active
         from projects where id=$1`, [id])).rows[0];
      if (!p) throw new Error('canary project vanished mid-build');
      const mins = Math.round((Date.now() - t0) / 60_000);
      if (p.status === 'done' && p.passed !== null && Number(p.active) === 0) {
        if (p.passed === true) {
          const swept = await sweepOldCanaries(pool, id);
          console.log(`canary OK — review passed in ${mins} min (${swept} old canar${swept === 1 ? 'y' : 'ies'} swept)`);
          process.exit(0);
        }
        await telegramAlert(`🐤🛑 CANARY FAILED — the chain degraded overnight\n\n"${brief}"\nbuilt in ${mins} min but the review did NOT pass\n${BOARD}/#/p/${id}/build`);
        process.exit(1);
      }
      if (p.status === 'blocked') {
        await telegramAlert(`🐤🛑 CANARY BLOCKED — the build could not finish\n"${brief}"\n${BOARD}/#/p/${id}/build`);
        process.exit(1);
      }
      if (Date.now() > deadline) {
        await telegramAlert(`🐤⏱ CANARY TIMED OUT (35 min)\n"${brief}"\n${BOARD}/#/p/${id}/build`);
        process.exit(1);
      }
    }
  } catch (e: any) {
    await telegramAlert(`🐤🛑 CANARY CRASHED: ${String(e?.message ?? e).slice(0, 300)}${id ? `\n${BOARD}/#/p/${id}/build` : ''}`);
    process.exit(1);
  }
}
main();

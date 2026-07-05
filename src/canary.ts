// canary.ts — THE NIGHTLY SELF-PROOF. The 13 gate suites test components; the canary tests THE
// CHAIN: one rotating brief (app / store / warm+blog — the three archetypes), built zero-touch
// through the LIVE server, judged by the standing review. Green = one quiet log line and the
// previous canary is swept. Anything else = the operator's phone rings (telegramAlert). This is
// the drift detector: an LLM behavior shift that degrades builds surfaces the same night, not
// when a client finds it. Run: npm run canary (prod: relay-canary.timer, nightly).
import { request as httpRequest } from 'node:http';
import { makePool } from './db.ts';
import { telegramAlert } from './alert.ts';

const BRIEFS = [
  'a barbershop booking app — customers pick a barber, a service and a time slot, and book',
  'an online store for a small-batch candle maker — classic scents in three sizes',
  'a neighborhood taqueria with weekend reservations and a blog of family recipes',
  // i18n: the Italian flight — proves locale detection, Italian chrome, € pricing, all zero-touch
  'una trattoria di quartiere con prenotazioni per il weekend e un blog di ricette della nonna',
];
const BASE = process.env.CANARY_BASE || 'http://127.0.0.1:8787';
const BOARD = process.env.PUBLIC_URL || 'https://board.naples.agency';

async function sweepOldCanaries(pool: any, keepId: string) {
  const old = (await pool.query("select id, params->>'slug' as slug from projects where brief like '%— canary 2%' and id<>$1", [keepId])).rows;
  const { rmSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  for (const o of old) {
    await pool.query(`drop schema if exists "app_${String(o.id).replace(/-/g, '').slice(0, 32)}" cascade`).catch(() => {});
    for (const t of ['dogfood_reviews', 'run_events', 'tasks', 'site_submissions']) await pool.query(`delete from ${t} where project_id=$1`, [o.id]).catch(() => {});
    await pool.query('delete from projects where id=$1', [o.id]).catch(() => {});
    try { rmSync(fileURLToPath(new URL('../sites/' + o.id, import.meta.url)), { recursive: true, force: true }); } catch {}
    // the packaging workdir too — nightly canaries would otherwise grow /root/apk-builds forever
    if (o.slug && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(o.slug)) {
      try { rmSync('/root/apk-builds/' + o.slug, { recursive: true, force: true }); } catch {}
    }
  }
  return old.length;
}

// every row in the project's own app schema — the number that must never go DOWN through a rebuild
async function appRowCount(pool: any, projectId: string): Promise<number> {
  const schema = 'app_' + String(projectId).replace(/-/g, '').slice(0, 32);
  const tables = (await pool.query("select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE'", [schema])).rows;
  let n = 0;
  for (const t of tables) n += Number((await pool.query(`select count(*)::int c from "${schema}"."${t.table_name}"`)).rows[0].c);
  return n;
}

async function main() {
  const pool = makePool();
  const day = Math.floor(Date.now() / 86_400_000);
  // CANARY_INDEX overrides the daily rotation — used to flight-test a specific archetype on demand
  const idx = process.env.CANARY_INDEX !== undefined ? Math.abs(Number(process.env.CANARY_INDEX)) % BRIEFS.length : day % BRIEFS.length;
  const brief = `${BRIEFS[idx]} — canary ${new Date().toISOString().slice(0, 10)}`;
  const t0 = Date.now();
  let id = '';
  try {
    // PREFLIGHT: one 8-token ping. Quota-dead providers mean the flight can only stall and
    // time out — skip quietly (the quota_stall alert already told the operator; the watchdog
    // covers serving). Transient ping failures still fly: the build path retries those.
    const { callLLM, isQuotaExhausted } = await import('./agents.ts');
    const ping = await callLLM('Answer with the single word: ok', 'ping', 400, { timeoutMs: 30000 });
    if (!ping.meta.ok && isQuotaExhausted(ping.meta.error)) {
      console.log('canary SKIPPED — LLM providers exhausted (quota); builds are stalled and resume on refill.');
      process.exit(0);
    }
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
      // (transient poll/DB errors are tolerated by the catch-continue below — only real verdicts exit)
      const mins = Math.round((Date.now() - t0) / 60_000);
      if (p.status === 'done' && p.passed !== null && Number(p.active) === 0) {
        if (p.passed === true) {
          // subdomain invariant: a slug was minted and Host-routing serves the site
          // (raw http.request — fetch/undici silently drops a Host override, which
          //  turns this probe into a false-pass against the board UI)
          const slug = (await pool.query("select params->>'slug' s from projects where id=$1", [id])).rows[0]?.s;
          if (!slug) throw new Error('canary built but no slug was minted');
          const u = new URL(BASE);
          const home = await new Promise<{ status: number; body: string }>((res, rej) => {
            const rq = httpRequest({ host: u.hostname, port: u.port || 80, path: '/', headers: { host: `${slug}.naples.agency` } }, (rs) => {
              let b = ''; rs.on('data', (c) => b += c); rs.on('end', () => res({ status: rs.statusCode || 0, body: b }));
            });
            rq.on('error', rej); rq.end();
          });
          if (home.status !== 200 || !home.body.includes('<title>')) throw new Error(`subdomain route dead: ${slug}.naples.agency → ${home.status}`);
          // ANDROID BY DEFAULT: the runner queued a packaging job when the build finished —
          // a green canary now also means a signed APK exists and is served on the subdomain
          if (process.env.RELAY_APK_AUTO !== '0' && process.env.RELAY_KS_PASS) {
            const apkDeadline = Date.now() + 8 * 60_000;
            for (;;) {
              const got = (await pool.query("select 1 from run_events where project_id=$1 and type='apk_built' limit 1", [id])).rows[0];
              if (got) break;
              const bad = (await pool.query("select detail from run_events where project_id=$1 and type='apk_failed' order by id desc limit 1", [id])).rows[0];
              if (bad) throw new Error('auto-APK failed: ' + String(bad.detail).slice(0, 200));
              if (Date.now() > apkDeadline) throw new Error('auto-APK never arrived (8 min) — the packaging queue is stuck or the hook is gone');
              await new Promise(res => setTimeout(res, 15_000));
            }
            const apk = await new Promise<{ status: number; len: number }>((res, rej) => {
              const rq = httpRequest({ host: u.hostname, port: u.port || 80, path: '/app.apk', headers: { host: `${slug}.naples.agency` } }, (rs) => {
                let n = 0; rs.on('data', (c) => n += c.length); rs.on('end', () => res({ status: rs.statusCode || 0, len: n }));
              });
              rq.on('error', rej); rq.end();
            });
            if (apk.status !== 200 || apk.len < 100_000) throw new Error(`auto-APK not served: /app.apk → ${apk.status} (${apk.len}B)`);
          }
          // M3 · ITERATION LEG: the flagship promise — "your data survives the rebuild" —
          // proven zero-touch. Rebuild the SAME project through the public API with an amended
          // brief; assert identity kept, not one row lost, and the review passes AGAIN.
          if (process.env.CANARY_ITERATE !== '0') {
            const rowsBefore = await appRowCount(pool, id);
            const reviewsBefore = Number((await pool.query('select count(*)::int n from dogfood_reviews where project_id=$1', [id])).rows[0].n);
            const rb: any = await (await fetch(`${BASE}/api/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, brief: brief + ' · UPDATE: add a short FAQ section about opening hours' }) })).json();
            if (rb && rb.error) throw new Error('iteration: rebuild refused — ' + rb.error);
            console.log(`canary iterating: rebuild of ${id} started (${rowsBefore} rows must survive)`);
            const iterDeadline = Date.now() + 25 * 60_000;
            for (;;) {
              await new Promise(res => setTimeout(res, 30_000));
              const q = (await pool.query(
                `select p.status,
                   (select count(*)::int from dogfood_reviews d where d.project_id=$1) as reviews,
                   (select d.passed from dogfood_reviews d where d.project_id=$1 order by d.id desc limit 1) as passed,
                   (select count(*)::int from tasks where project_id=$1 and status in ('ready','running','verifying')) as active
                 from projects p where p.id=$1`, [id])).rows[0];
              if (q && q.status === 'done' && Number(q.active) === 0 && Number(q.reviews) > reviewsBefore) {
                if (q.passed !== true) throw new Error('iteration: the rebuilt site FAILED its review');
                break;
              }
              if (q && q.status === 'blocked') throw new Error('iteration: rebuild blocked');
              if (Date.now() > iterDeadline) throw new Error('iteration: rebuild timed out (25 min)');
            }
            const rowsAfter = await appRowCount(pool, id);
            if (rowsAfter < rowsBefore) throw new Error(`iteration: data LOST in rebuild — ${rowsBefore} rows before, ${rowsAfter} after`);
            const slug2 = (await pool.query("select params->>'slug' s from projects where id=$1", [id])).rows[0]?.s;
            if (slug2 !== slug) throw new Error(`iteration: identity changed — slug ${slug} became ${slug2}`);
            console.log(`canary iteration OK — data survived (${rowsBefore}→${rowsAfter} rows), identity kept, review re-passed`);
          }
          const swept = await sweepOldCanaries(pool, id);
          console.log(`canary OK — review passed in ${mins} min · ${slug}.naples.agency routed (${swept} old canar${swept === 1 ? 'y' : 'ies'} swept)`);
          process.exit(0);
        }
        console.error(`canary FAILED — review did not pass (${mins} min) · ${BOARD}/#/p/${id}/build`);
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
    console.error('canary error:', e?.message ?? e);
    await telegramAlert(`🐤🛑 CANARY CRASHED: ${String(e?.message ?? e).slice(0, 300)}${id ? `\n${BOARD}/#/p/${id}/build` : ''}`);
    process.exit(1);
  }
}
main();

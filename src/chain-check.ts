// chain:check — THE PRODUCTION-RECORD GATE. "How it was built" is a client-facing product surface
// rendered LIVE from the pipeline's own database. It must: render with the site's chrome for any
// finished project, tell the story from CURATED data only, and NEVER leak internals (task outputs,
// event detail text, emails, tokens, prompts). Exit 1 on any failure. Run: npm run chain:check.
import { randomUUID } from 'node:crypto';
import { makePool } from './db.ts';
import { renderLiveChain } from './cms/live.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

const pool = makePool();
const id = randomUUID();
const BRIEF = 'a barbershop booking app for the chain-check scratch project';
const params = {
  archetype: 'app', theme: 'warm', layout: { hero: 'image', nav: 'standard', band: false, cards: 'photo' },
  brand: { name: 'Chopline', cta: 'Get started', tokens: { bg: '#fff8f1', primary: '#b5532a' } },
  scope: {
    difficulty: 2,
    includes: [{ name: 'booking', promise: 'online booking with live receipts and status updates' }, { name: 'installable', promise: 'installs as an app on any phone' }],
    excludes: [{ ask: 'card payments', alternative: 'orders are recorded and confirmed; payment is settled off-platform for now' }],
  },
  site: { pages: [{ slug: 'index', title: 'Home', sections: [{ type: 'hero', headline: 'Fresh fades' }] }, { slug: 'book', title: 'Book', sections: [{ type: 'form', table: 'bookings' }] }] },
};

try {
  await pool.query(`insert into projects(id, brief, status, params) values ($1,$2,'done',$3)`, [id, BRIEF, JSON.stringify(params)]);
  await pool.query(
    `insert into tasks(project_id, seq, title, department, status, verify, attempts, max_attempts)
     values ($1,1,'Plan','plan','done','json_valid',1,3),
            ($1,2,'Schema','database','done','sql_applies',1,3),
            ($1,3,'Home','render','done','render',2,3)`, [id]);
  await pool.query(`insert into run_events(project_id, type, detail) values ($1,'plan_repair','dropped facade page "dashboard"'), ($1,'plan_repair','injected collection'), ($1,'project_retry','resurrected 1 failed task(s) SECRET-EVENT-DETAIL')`, [id]);
  await pool.query(`insert into dogfood_reviews(project_id, passed, summary, issues) values ($1, true, 'looks right', '[{"kind":"cta-monotone","page":"index","detail":"all 3 buttons share contact.html SECRET-ISSUE-DETAIL","severity":"medium","viewport":"desktop"}]')`, [id]);

  const html = await renderLiveChain(pool, id);
  ok('chain page renders for a finished project', !!html && html.length > 2000, String(html?.length));
  const h = String(html || '');

  // ANDROID section: strictly artifact-gated — appears ONLY when app.apk exists on disk
  ok('no APK on disk → no Android section (never a promise)', !h.includes('It is also an Android app'));
  {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { SITES } = await import('./verify.ts');
    await pool.query(`update projects set params = jsonb_set(params, '{slug}', '"chain-check-scratch"') where id=$1`, [id]);
    const dir = fileURLToPath(new URL(id + '/', SITES));
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + 'app.apk', 'not-a-real-apk');
    const h2 = String(await renderLiveChain(pool, id) || '');
    ok('APK on disk + slug → Android section with subdomain link', h2.includes('It is also an Android app') && h2.includes('https://chain-check-scratch.naples.agency/app.apk'));
    ok('Android section carries a scannable QR (real svg)', /<svg[^>]*>[\s\S]*<\/svg>/.test(h2.slice(h2.indexOf('It is also an Android app'))));
    rmSync(dir, { recursive: true, force: true });
  }

  // the story — from curated data
  ok('site chrome: brand in the nav', h.includes('Chopline'));
  ok('the brief, verbatim', h.includes(BRIEF));
  ok('scope: complexity shown', h.includes('complexity 2/5') || h.includes('2/5'));
  ok('scope: a delivered promise shown', h.includes('online booking with live receipts'));
  ok('scope: the honest exclusion + alternative shown', h.includes('card payments') && h.includes('settled off-platform'));
  ok('blueprint: the kind in plain words', h.includes('a real application'));
  ok('blueprint: design language named', h.includes('warm'));
  ok('blueprint: palette chips carry the locked tokens', h.includes('#fff8f1') && h.includes('#b5532a'));
  ok('run: task count shown', /production tasks/.test(h));
  ok('run: repairs stated honestly', h.includes('2 automatic repairs'));
  ok('checks: verify types in plain words', h.includes('database schema applies cleanly') && h.includes('renders correctly'));
  ok('checks: privacy stated', h.includes('never publicly listable'));
  ok('review: verdict pill', h.includes('Independent review: PASSED'));
  ok('page is itself installable-site chrome (manifest link present)', h.includes('manifest.webmanifest'));

  // the seal — internals NEVER leak
  ok('leak: event detail text never renders', !h.includes('SECRET-EVENT-DETAIL'));
  ok('leak: review issue detail text never renders', !h.includes('SECRET-ISSUE-DETAIL'));
  ok('leak: no email addresses anywhere', !/[\w.+-]+@[\w-]+\.[\w.]+/.test(h));
  ok('leak: no ref_token / session markers', !/ref_token|_relay_visitor/.test(h));

  // the door + the 404
  ok('footer of every produced page carries the door', (await import('./components.ts')).footer('X', [{ slug: 'index', title: 'Home' }]).includes('how-it-was-built.html'));
  ok('unknown project → null (honest 404)', (await renderLiveChain(pool, randomUUID())) === null);
  // a legacy project without a composed site model → null, never a crash
  const bare = randomUUID();
  await pool.query(`insert into projects(id, brief, status, params) values ($1,'bare','done','{}')`, [bare]);
  ok('project without a site model → null (no crash)', (await renderLiveChain(pool, bare)) === null);
  await pool.query('delete from projects where id=$1', [bare]);
} finally {
  await pool.query('delete from dogfood_reviews where project_id=$1', [id]).catch(() => {});
  await pool.query('delete from run_events where project_id=$1', [id]).catch(() => {});
  await pool.query('delete from tasks where project_id=$1', [id]).catch(() => {});
  await pool.query('delete from projects where id=$1', [id]).catch(() => {});
  await pool.end();
}

console.log(`\nchain:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

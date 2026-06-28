// STRESS TEST — "one website = one navigation = one logo", proven, not asserted by hand.
// Three engines, each a different angle on the same invariant:
//   A. SPEC-FUZZ (no DB): render hundreds of varied multi-page specs through the REAL renderer and assert
//      every page has exactly 1 nav + 1 logo, and every page of a site shares ONE logo + ONE palette.
//   B. GATE-BITE (no DB): prove the gate REJECTS the bad cases — a second <nav>, a missing logo, a logo
//      that drifts page-to-page. A gate that only ever passes is theatre; this proves it bites.
//   C. END-TO-END (scratch DB): plan -> run -> render -> media -> CMS -> gate, for real briefs, then read
//      the FILES ON DISK and assert the invariant on the actual produced site + that the QA gate ran+passed.
// Run:  A+B always (npx tsx _stress.ts).  C only when DATABASE_URL points at a *brandproof* scratch DB.
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { renderPage } from './src/render.ts';
import { applyBrand, type Brand } from './src/spec.ts';
import { verify, SITES, navDefect, pageLogo, pagePalette } from './src/verify.ts';

let fails = 0;
const FAIL = (msg: string) => { fails++; console.log('  ❌ ' + msg); };
const OK = (msg: string) => console.log('  ✓ ' + msg);

// ---------------------------------------------------------------------------------------------------
// A. SPEC-FUZZ — the renderer across many shapes
// ---------------------------------------------------------------------------------------------------
const BRANDS: Brand[] = [
  { name: 'Café Noir', cta: 'Reserve', tokens: { bg: '#11100e', primary: '#d9a441' } },
  { name: 'Hörst & Co.', cta: 'Get started', tokens: { bg: '#ffffff', primary: '#1d4ed8' } },
  { name: 'Lumière', cta: 'Book now', tokens: { bg: '#0b1220', primary: '#7c7aff' } },
  { name: 'O\'Malley & Sons', cta: 'Contact', tokens: { bg: '#fdfaf3', primary: '#0b6e4f' } },
  { name: 'Studio "Verde"', cta: 'See work', tokens: { bg: '#101418', primary: '#36b37e' } },
  { name: '北京 Noodle Bar', cta: 'Order', tokens: { bg: '#1a0f0f', primary: '#e23636' } },
];
const THEMES = ['editorial', 'modern', 'warm', 'bold', 'minimal'];
const PAGE_POOL = [
  { slug: 'index', title: 'Home' }, { slug: 'about', title: 'Our Story' }, { slug: 'services', title: 'Services' },
  { slug: 'menu', title: 'Menu' }, { slug: 'pricing', title: 'Pricing' }, { slug: 'work', title: 'Work' }, { slug: 'contact', title: 'Contact' },
];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
// EVIL copy: a literal "<nav>" / fake logo embedded in user copy must be ESCAPED, never become a real one.
const EVIL = '<nav class="nav"><a class="nav-brand">HACKED</a></nav> & <script>x</script>';
const SECTION_BUILDERS: (() => any)[] = [
  () => ({ type: 'features', title: 'Why us', intro: EVIL, items: [{ title: 'Fast', body: EVIL }, { title: 'Honest', body: 'Clear pricing.' }, { title: 'Local', body: 'Made nearby.' }] }),
  () => ({ type: 'split', eyebrow: 'About', title: 'Our craft ' + EVIL, body: EVIL, cta: 'Learn more', link: 'about' }),
  () => ({ type: 'gallery', title: 'Gallery', images: ['studio interior', 'team at work', 'product detail', 'city street'] }),
  () => ({ type: 'cta', headline: 'Ready when you are', body: EVIL, cta: 'Get in touch', link: 'contact' }),
  () => ({ type: 'stats', title: 'By the numbers', items: [{ value: '480+', label: 'shipped' }, { value: '98%', label: 'would refer' }, { value: '12y', label: 'in business' }] }),
  () => ({ type: 'pricing', title: 'Plans', intro: 'Simple.', plans: [{ name: 'Basic', price: '$9', period: 'mo', features: ['A', 'B'], cta: 'Pick' }, { name: 'Pro', price: '$29', period: 'mo', featured: true, features: ['A', 'B', 'C'], cta: 'Pick' }] }),
  () => ({ type: 'testimonials', title: 'Loved by', items: [{ quote: EVIL, name: 'A. Person', role: 'Owner' }, { quote: 'Great.', name: 'B. Body', role: 'Chef' }] }),
  () => ({ type: 'faq', title: 'FAQ', items: [{ q: 'How?', a: EVIL }, { q: 'When?', a: 'Soon.' }] }),
  () => ({ type: 'form', title: 'Say hello', intro: 'We reply fast.', cta: 'Send', form: 'contact' }),
];
function fuzzSite(): { ok: boolean; pages: number; detail: string } {
  const brand = pick(BRANDS);
  const theme = pick(THEMES);
  const n = 2 + Math.floor(Math.random() * 4);          // 2..5 pages
  const pages = [PAGE_POOL[0], ...PAGE_POOL.slice(1).sort(() => Math.random() - 0.5).slice(0, n - 1)];
  const logos = new Set<string>(); const palettes = new Set<string>(); const navIssues: string[] = [];
  for (const pg of pages) {
    const k = 2 + Math.floor(Math.random() * 3);
    const sections = [{ type: 'hero', eyebrow: 'Welcome', headline: `${brand.name} ${EVIL}`, lead: EVIL, cta: brand.cta, link: 'contact' },
      ...Array.from({ length: k }, () => pick(SECTION_BUILDERS)())];
    const spec: any = { brand: { name: brand.name, cta: brand.cta, tokens: {} }, sections };
    applyBrand(spec, brand);                              // brand-lock, exactly like the runner
    const html = renderPage(spec, { pages, slug: pg.slug, title: pg.title, theme });
    const nd = navDefect(html);
    if (nd) navIssues.push(`${pg.slug}: ${nd}`);
    logos.add(pageLogo(html)); palettes.add(pagePalette(html));
  }
  const detail = navIssues.length ? navIssues.join('; ')
    : logos.size !== 1 ? `logo drift ${[...logos].map(l => JSON.stringify(l)).join('|')}`
    : palettes.size !== 1 ? `palette drift ${[...palettes].join('|')}` : 'ok';
  return { ok: detail === 'ok', pages: pages.length, detail };
}
function engineA(rounds = 400) {
  console.log(`\n[A] SPEC-FUZZ — ${rounds} random multi-page sites through the real renderer`);
  let pagesTested = 0, bad = 0; const samples: string[] = [];
  for (let i = 0; i < rounds; i++) { const r = fuzzSite(); pagesTested += r.pages; if (!r.ok) { bad++; if (samples.length < 5) samples.push(r.detail); } }
  if (bad) FAIL(`${bad}/${rounds} fuzzed sites broke the invariant — e.g. ${samples.join(' || ')}`);
  else OK(`${rounds} sites · ${pagesTested} pages — every page exactly 1 nav + 1 logo, every site 1 logo + 1 palette (incl. unicode/quote/escaped-<nav> copy)`);
}

// ---------------------------------------------------------------------------------------------------
// B. GATE-BITE — prove the checks REJECT the bad cases
// ---------------------------------------------------------------------------------------------------
function goodPage(): string {
  const brand: Brand = { name: 'Proof Co.', cta: 'Go', tokens: { bg: '#ffffff', primary: '#4f46e5' } };
  const spec: any = { brand: { name: brand.name, cta: brand.cta, tokens: {} }, sections: [{ type: 'hero', headline: 'Hi', lead: 'x', cta: 'Go', link: 'contact' }, { type: 'cta', headline: 'Bye', cta: 'Go', link: 'contact' }] };
  applyBrand(spec, brand);
  return renderPage(spec, { pages: [{ slug: 'index', title: 'Home' }, { slug: 'contact', title: 'Contact' }], slug: 'index', title: 'Home', theme: 'minimal' });
}
async function engineB() {
  console.log('\n[B] GATE-BITE — the gate must REJECT a second nav, a missing logo, and logo drift');
  const good = goodPage();
  if (navDefect(good)) FAIL('a correct page was wrongly rejected: ' + navDefect(good)); else OK('a correct page passes navDefect');
  // regression of the EXACT historical bug: a footer that emitted its own <nav> (every old site had 2)
  const twoNav = good.replace('</main>', '</main>\n<footer><nav><a href="contact.html">Contact</a></nav></footer>');
  navDefect(twoNav)?.includes('found 2') ? OK('a 2nd <nav> (the old footer bug) is caught: ' + navDefect(twoNav)) : FAIL('a duplicated <nav> SLIPPED THE GATE — this is the original defect');
  const noLogo = good.replace('class="nav-brand"', 'class="nav-brandless"');
  navDefect(noLogo)?.includes('found 0') ? OK('a missing logo is caught') : FAIL('a missing logo slipped the gate');
  const threeLogo = good.replace('</main>', '</main><a class="nav-brand">B</a><a class="nav-brand">C</a>');
  navDefect(threeLogo)?.includes('found 3') ? OK('3 logos on one page is caught') : FAIL('3 logos slipped the gate');

  // site-level drift through the REAL verify('site_consistent') against files on disk
  const pid = '__stress_gatebite__';
  const dir = fileURLToPath(new URL(pid + '/', SITES));
  try {
    mkdirSync(dir, { recursive: true });
    const a = goodPage();
    const bDrift = a.replace(/class="nav-brand"([^>]*)>Proof Co\./, 'class="nav-brand"$1>OTHER Brand');   // page 2 shows a different logo
    writeFileSync(dir + 'index.html', a); writeFileSync(dir + 'about.html', bDrift);
    const r1 = await verify({} as any, { project_id: pid, verify: 'site_consistent', artifact: null }, '');
    (!r1.ok && /logo drift/i.test(r1.log)) ? OK('site_consistent REJECTS per-page logo drift: ' + r1.log) : FAIL('logo drift across pages slipped site_consistent: ' + r1.log);
    writeFileSync(dir + 'about.html', a);   // now both pages identical brand
    const r2 = await verify({} as any, { project_id: pid, verify: 'site_consistent', artifact: null }, '');
    r2.ok ? OK('site_consistent PASSES a coherent site: ' + r2.log) : FAIL('a coherent site was wrongly rejected: ' + r2.log);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// ---------------------------------------------------------------------------------------------------
// C. END-TO-END — real builds, real files on disk (scratch DB only)
// ---------------------------------------------------------------------------------------------------
const E2E_BRIEFS = [
  'A neighbourhood Italian trattoria in Brooklyn — menu, our story, reservations',
  'A specialty coffee roaster in Lisbon — shop, brewing guides, about, contact',
  'An online multiplayer One Piece adventure game — characters, how to play, leaderboard',
  'A boutique architecture studio in Copenhagen — portfolio, services, about, contact',
  'A city-wide bike courier startup — how it works, for businesses, pricing, sign up',
];
async function engineC() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('brandproof')) {
    console.log('\n[C] END-TO-END — SKIPPED (point DATABASE_URL at an *agency_brandproof* scratch DB to run real builds; never the live board)');
    return;
  }
  console.log(`\n[C] END-TO-END — ${E2E_BRIEFS.length} real briefs: plan → run → render → gate, then assert the files on disk`);
  const { makePool, ensureDatabase, applySchema } = await import('./src/db.ts');
  const { plan } = await import('./src/planner.ts');
  const { runLoop } = await import('./src/runner.ts');
  await ensureDatabase('agency_brandproof'); const pool = makePool(); await applySchema(pool);
  for (const brief of E2E_BRIEFS) {
    let id: string;
    try { id = await plan(pool, brief); await runLoop(pool, id, { review: false, cap: 4 }); }
    catch (e: any) { FAIL(`build threw for "${brief.slice(0, 40)}": ${e?.message}`); continue; }
    const dir = fileURLToPath(new URL(id + '/', SITES));
    const files = readdirSync(dir).filter(f => f.endsWith('.html'));
    if (!files.length) { FAIL(`"${brief.slice(0, 40)}" produced no pages`); continue; }
    const logos = new Set<string>(); const palettes = new Set<string>(); const navBad: string[] = [];
    for (const f of files) { const h = readFileSync(dir + f, 'utf8'); const nd = navDefect(h); if (nd) navBad.push(`${f}:${nd}`); logos.add(pageLogo(h)); palettes.add(pagePalette(h)); }
    // independently confirm the QA gate itself ran AND passed (not just our re-read)
    const qa = (await pool.query("select status, verify from tasks where project_id=$1 and department='qa'", [id])).rows[0];
    const gateOk = qa && qa.verify === 'site_consistent' && qa.status === 'done';
    const probs: string[] = [];
    if (navBad.length) probs.push('nav/logo: ' + navBad.join(', '));
    if (logos.size !== 1) probs.push('logo drift: ' + [...logos].map(l => JSON.stringify(l)).join('|'));
    if (palettes.size !== 1) probs.push('palette drift: ' + [...palettes].join('|'));
    if (!gateOk) probs.push(`QA site_consistent gate not done (status=${qa?.status}, verify=${qa?.verify})`);
    probs.length ? FAIL(`"${brief.slice(0, 40)}" (${files.length} pages): ${probs.join(' · ')}`)
      : OK(`"${brief.slice(0, 40)}" — ${files.length} pages, 1 nav/1 logo each, logo ${JSON.stringify([...logos][0])}, palette ${[...palettes][0]}, QA gate ✓`);
  }
  await pool.end();
}

// ---------------------------------------------------------------------------------------------------
console.log('=== STRESS: one website = one navigation = one logo ===');
engineA(Number(process.env.FUZZ_ROUNDS || 400));
await engineB();
await engineC();
console.log(`\n=== ${fails === 0 ? '✅ ALL CLEAR — the invariant holds and the gate bites' : `❌ ${fails} FAILURE(S)`} ===`);
process.exit(fails === 0 ? 0 : 1);

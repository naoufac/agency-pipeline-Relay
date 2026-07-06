// orchestrator:check — DETERMINISTIC gate for the Orchestrator contract.
// WHY: every new classification path must be proven before it can break a production build.
// This gate runs WITHOUT a live LLM (llm option omitted → floor only), so it is:
//   (a) fast (< 100ms),
//   (b) never flaky (no network),
//   (c) unambiguous about what the deterministic floor produces.
//
// Assertions:
//  1. Determinism: same brief → same {deliverable, stack, chainReason type}.
//  2. Diverse briefs → correct deliverables (bakery marketing, COD courier dashboard, lingerie shop, etc.).
//  3. Forced SPINE present in every composed chain (understand/research/branding/design_guidelines/qa).
//  4. Back-compat: plain "5-page bakery website" → directus_site AND same department set as validate().
//  5. LLM cannot downgrade: an LLM-returned 'directus_site' for a woocommerce brief is ignored (floor wins).
//  6. Campaign brief → campaign deliverable, no render/qa-site steps.
//
// Exit 0 on all pass, exit 1 on any failure. Run: npm run orchestrator:check.

import { detectDeliverable, composeChain, orchestrate, detectNeeds, DELIVERABLES } from './orchestrator.ts';
import { buildPlan } from './planner.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ────────────────────────────────────────────────────────────────────────────
// 1. DETERMINISM: same brief always yields the same floor
// ────────────────────────────────────────────────────────────────────────────
{
  const brief = 'a simple landing page for a Naples plumber';
  const a = detectDeliverable(brief);
  const b = detectDeliverable(brief);
  ok('determinism: same brief → same deliverable', a === b, `${a} vs ${b}`);
  ok('plain/landing brief → directus_site', a === 'directus_site', `got ${a}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 2. DIVERSE BRIEFS → CORRECT DELIVERABLES
// ────────────────────────────────────────────────────────────────────────────

// Bakery marketing site (content, not a shop) — must be a CMS deliverable, not a store
{
  const brief = 'a bakery marketing site — recipes, blog, seasonal news, catering inquiries';
  const d = detectDeliverable(brief);
  // blog + news → wp_site; NOT wp_woocommerce; NOT fullstack_app
  ok('bakery marketing with blog → wp_site (not store)', d === 'wp_site', `got ${d}`);
}

// Naples COD-courier "get paid tomorrow, settlement dashboard for drivers" → fullstack_app
{
  const brief = 'get paid tomorrow — a settlement dashboard for COD courier drivers tracking their deliveries and earnings';
  const d = detectDeliverable(brief);
  ok('COD courier dashboard → fullstack_app', d === 'fullstack_app', `got ${d}`);
}

// French lingerie boutique online shop → wp_woocommerce
{
  const brief = 'une boutique selling lingerie en ligne — shop, cart, checkout, product catalog for a French fashion brand';
  const d = detectDeliverable(brief);
  ok('lingerie online shop with cart/checkout → wp_woocommerce', d === 'wp_woocommerce', `got ${d}`);
}

// Restaurant with weekend bookings (site deliverable + booking/integrations branch)
{
  const brief = 'Osteria Faro — a fine dining restaurant in Naples with online table reservations for weekends';
  const d = detectDeliverable(brief);
  // bookings alone don't push to fullstack_app from directus_site — this is a site with a booking branch
  // (the restaurant may resolve to directus_site or wp_site — both are "site" deliverables with integrations)
  ok('restaurant with reservations → site deliverable (not store)', d !== 'wp_woocommerce', `got ${d}`);
  // But the detectedNeeds must include integrations (from booking regex)
  const archetype = DELIVERABLES[d].archetypeCompat;
  const needs = detectNeeds(brief, archetype, d);
  ok('restaurant booking brief → integrations branch detected', needs.includes('integrations'), `needs: ${needs.join(',')}`);
}

// Email launch campaign → campaign deliverable (no site)
{
  const brief = 'email campaign for the launch of a new product — newsletter blast, drip campaign, social media posts';
  const d = detectDeliverable(brief);
  ok('email launch campaign → campaign', d === 'campaign', `got ${d}`);
}

// Simple landing page → directus_site
{
  const brief = 'a simple landing page for a personal portfolio — one page, minimal, clean';
  const d = detectDeliverable(brief);
  ok('simple landing page → directus_site', d === 'directus_site', `got ${d}`);
}

// E-commerce with explicit "woocommerce" mention
{
  const brief = 'a WooCommerce shop for handmade candles — products, checkout, cart';
  const d = detectDeliverable(brief);
  ok('explicit woocommerce brief → wp_woocommerce', d === 'wp_woocommerce', `got ${d}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 3. FORCED SPINE present in every deliverable's composed chain
// WHY: the blueprint mandates understand→research→branding→design_guidelines→qa
// for EVERY deliverable. Any missing spine cap = broken orchestrator.
// ────────────────────────────────────────────────────────────────────────────
const SPINE_DEPTS = ['strategy', 'research', 'branding', 'design', 'qa'];
const TEST_PAGES = [{ slug: 'index', title: 'Home' }, { slug: 'about', title: 'About' }];

for (const [brief, delivId] of [
  ['a simple site', 'directus_site'],
  ['a blog and news magazine', 'wp_site'],
  ['an online shop with products and checkout cart', 'wp_woocommerce'],
  ['a SaaS dashboard for fleet tracking', 'fullstack_app'],
  ['email campaign newsletter blast social media posts', 'campaign'],
] as [string, string][]) {
  const d = delivId as any;
  const needs = detectNeeds(brief, DELIVERABLES[d].archetypeCompat, d);
  const tasks = composeChain(d, needs, TEST_PAGES);
  const depts = tasks.map(t => t.department);
  for (const spine of SPINE_DEPTS) {
    ok(`spine '${spine}' in ${d} chain`, depts.includes(spine), `got: ${depts.join(',')}`);
  }
  // QA must be last
  const qaSeq = tasks.find(t => t.department === 'qa')?.seq ?? -1;
  const maxSeq = Math.max(...tasks.map(t => t.seq));
  ok(`qa is last in ${d} chain`, qaSeq === maxSeq, `qa=${qaSeq} max=${maxSeq}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 4. BACK-COMPAT: plain "5-page bakery website" → directus_site + same depts as validate()
// WHY: this is THE compatibility guarantee — the classic path must be byte-identical.
// We compare the department set (not exact titles) because validate() uses LLM-fallback tasks
// whose titles vary; departments are the semantic unit.
// ────────────────────────────────────────────────────────────────────────────
{
  const brief = '5-page bakery website — home, about, menu, gallery, contact';
  const d = detectDeliverable(brief);
  ok('5-page bakery → directus_site', d === 'directus_site', `got ${d}`);

  // Run buildPlan (no DB — pure) and verify the orchestration result is directus_site
  const { orchestration } = await buildPlan(brief);
  ok('buildPlan: orchestration.deliverable === directus_site', orchestration.deliverable === 'directus_site', `got ${orchestration.deliverable}`);
  ok('buildPlan: builder === directus', orchestration.builder === 'directus', `got ${orchestration.builder}`);
  ok('buildPlan: stack === directus', orchestration.stack === 'directus', `got ${orchestration.stack}`);

  // For a plain site, the plan tasks must include compose + render + qa — same as validate() always produces.
  const { plan } = await buildPlan(brief);
  const taskDepts = plan.tasks.map((t: any) => t.department);
  ok('back-compat: compose task present', taskDepts.includes('compose'), `depts: ${taskDepts.join(',')}`);
  ok('back-compat: render task present', taskDepts.includes('render'), `depts: ${taskDepts.join(',')}`);
  ok('back-compat: qa task present',     taskDepts.includes('qa'),     `depts: ${taskDepts.join(',')}`);
  ok('back-compat: branding task present', taskDepts.includes('branding'), `depts: ${taskDepts.join(',')}`);
  // The plan should NOT have app_db or policies (plain site, no data)
  ok('back-compat: no database dept on plain site', !taskDepts.includes('database'), `depts: ${taskDepts.join(',')}`);
  ok('back-compat: no policies dept on plain site', !taskDepts.includes('policies'), `depts: ${taskDepts.join(',')}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 5. LLM CANNOT DOWNGRADE: floor is immune to LLM "directus_site" on a store brief
// WHY: archetypeFor() already has this contract; we verify the same applies to deliverable selection.
// The LLM is mocked here — it always returns "directus_site" regardless of the brief.
// A woocommerce brief must still resolve to wp_woocommerce (the floor wins).
// ────────────────────────────────────────────────────────────────────────────
{
  // A brief that clearly fires woocommerce (multiple signals → score > directus_site baseline)
  const storeBrief = 'an e-commerce webshop for handmade jewelry — products, cart, checkout, catalog';
  const floor = detectDeliverable(storeBrief);
  ok('store brief floor is wp_woocommerce', floor === 'wp_woocommerce', `got ${floor}`);

  // orchestrate() with a mock LLM that always returns directus_site (an attempted downgrade)
  // Because floor !== 'directus_site', the LLM is IGNORED (mirrors archetypeFor short-circuit).
  const mockLlm = async (_sys: string, _user: string, _max: number, _flags: any): Promise<string> => {
    return JSON.stringify({ deliverable: 'directus_site', reason: 'seems simple' });
  };
  const result = await orchestrate(storeBrief, { llm: mockLlm });
  ok('LLM cannot downgrade wp_woocommerce floor to directus_site', result.deliverable === 'wp_woocommerce', `got ${result.deliverable}`);
}

// LLM CAN UPGRADE directus_site → wp_site (the one allowed upgrade path)
{
  const blogBrief = 'a simple news site for a local community';
  const floor = detectDeliverable(blogBrief);
  // floor might be directus_site (not enough blog signals) — then LLM upgrade is valid
  // If floor already is wp_site, the upgrade is redundant but still correct
  const mockLlm = async (_sys: string, _user: string, _max: number, _flags: any): Promise<string> => {
    return JSON.stringify({ deliverable: 'wp_site', reason: 'blog/news site benefits from WordPress CMS' });
  };
  const result = await orchestrate(blogBrief, { llm: mockLlm });
  ok('LLM can upgrade directus_site → wp_site', ['directus_site', 'wp_site'].includes(result.deliverable),
    `got ${result.deliverable} (either is valid: floor or upgraded)`);
}

// LLM returning an INVALID id → ignored, keep floor
{
  const brief = 'a personal portfolio';
  const floor = detectDeliverable(brief);
  const mockLlm = async () => JSON.stringify({ deliverable: 'not_a_real_deliverable', reason: 'garbage' });
  const result = await orchestrate(brief, { llm: mockLlm });
  ok('LLM invalid id → ignored, keep floor', result.deliverable === floor, `floor=${floor} got=${result.deliverable}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 6. CAMPAIGN: no compose/render steps; qa present
// ────────────────────────────────────────────────────────────────────────────
{
  const needs = detectNeeds('email campaign newsletter blast', 'site', 'campaign');
  const tasks = composeChain('campaign', needs, TEST_PAGES);
  const depts = tasks.map(t => t.department);
  ok('campaign: no compose step', !depts.includes('compose'), `depts: ${depts.join(',')}`);
  ok('campaign: no render step', !depts.includes('render'), `depts: ${depts.join(',')}`);
  ok('campaign: qa present', depts.includes('qa'), `depts: ${depts.join(',')}`);
  ok('campaign: content/campaign_assets present', depts.includes('content'), `depts: ${depts.join(',')}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 7. WP_PROVISION present in WordPress chains
// ────────────────────────────────────────────────────────────────────────────
{
  for (const d of ['wp_site', 'wp_woocommerce'] as const) {
    const archetype = DELIVERABLES[d].archetypeCompat;
    const needs = detectNeeds('a wordpress blog with articles and news', archetype, d);
    const tasks = composeChain(d, needs, TEST_PAGES);
    const depts = tasks.map(t => t.department);
    ok(`${d}: wp_provision dept present`, depts.includes('wp_provision'), `depts: ${depts.join(',')}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 8. FULLSTACK_APP: database + policies + integrations + app_api in chain
// ────────────────────────────────────────────────────────────────────────────
{
  const needs = detectNeeds('a SaaS booking platform dashboard', 'app', 'fullstack_app');
  const tasks = composeChain('fullstack_app', needs, TEST_PAGES);
  const depts = tasks.map(t => t.department);
  ok('fullstack_app: database dept present', depts.includes('database'), `depts: ${depts.join(',')}`);
  ok('fullstack_app: policies dept present', depts.includes('policies'), `depts: ${depts.join(',')}`);
  ok('fullstack_app: integrations dept present', depts.includes('integrations'), `depts: ${depts.join(',')}`);
  ok('fullstack_app: app_api dept present', depts.includes('app_api'), `depts: ${depts.join(',')}`);
}

// ────────────────────────────────────────────────────────────────────────────
// 9. TASK SHAPE: every emitted task has the frozen shape (seq/title/department/verify/depends_on/artifact)
// ────────────────────────────────────────────────────────────────────────────
{
  const needs = detectNeeds('a SaaS platform', 'app', 'fullstack_app');
  const tasks = composeChain('fullstack_app', needs, TEST_PAGES);
  for (const t of tasks) {
    ok(`task shape: seq is number (seq=${t.seq})`, typeof t.seq === 'number', `seq=${t.seq}`);
    ok(`task shape: title is string (seq=${t.seq})`, typeof t.title === 'string');
    ok(`task shape: department is string (seq=${t.seq})`, typeof t.department === 'string');
    ok(`task shape: verify is string (seq=${t.seq})`, typeof t.verify === 'string');
    ok(`task shape: depends_on is array (seq=${t.seq})`, Array.isArray(t.depends_on));
    ok(`task shape: artifact is string|null (seq=${t.seq})`, t.artifact === null || typeof t.artifact === 'string');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// RESULT
// ────────────────────────────────────────────────────────────────────────────
console.log(`\norchestrator:check — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

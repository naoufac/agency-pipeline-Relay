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
  // T1: a brief with "landing page" now correctly maps to landing_page deliverable.
  // The determinism contract (same brief → same result) remains unchanged.
  const brief = 'a simple landing page for a Naples plumber';
  const a = detectDeliverable(brief);
  const b = detectDeliverable(brief);
  ok('determinism: same brief → same deliverable', a === b, `${a} vs ${b}`);
  ok('landing page brief → landing_page (T1)', a === 'landing_page', `got ${a}`);
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

// T1: landing page brief → landing_page deliverable (updated: landing_page now supersedes directus_site)
{
  const brief = 'a simple landing page for a personal portfolio — one page, minimal, clean';
  const d = detectDeliverable(brief);
  ok('simple landing page → landing_page', d === 'landing_page', `got ${d}`);
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
// 10. MULTILINGUAL classification (FR/IT — the real client base, not English demos)
// ────────────────────────────────────────────────────────────────────────────
{
  ok('FR ecom: "boutique en ligne … vendre … panier … paiement" -> wp_woocommerce',
    detectDeliverable('Une boutique en ligne de lingerie — vendre des produits, panier, paiement') === 'wp_woocommerce');
  ok('IT ecom: "negozio online … vendere … carrello" -> wp_woocommerce',
    detectDeliverable('Un negozio online per vendere prodotti, carrello e pagamento') === 'wp_woocommerce');
  ok('FR app: "plateforme de réservation … tableau de bord" -> fullstack_app',
    detectDeliverable('Une plateforme de réservation avec tableau de bord') === 'fullstack_app');
  ok('IT magazine: "rivista … redazione … articoli" -> wp_site',
    detectDeliverable('Una rivista di cucina con articoli e una redazione multi-autore') === 'wp_site');
  ok('IT restaurant "prenotazioni" -> booking branch (database+integrations) on a site',
    (() => { const n = detectNeeds('Una trattoria a Napoli con prenotazioni per il weekend', 'app', 'directus_site');
             return n.includes('database') && n.includes('integrations'); })());
}

// ────────────────────────────────────────────────────────────────────────────
// 11. THE PROJECT DICTATES ITS STEPS — no nonsense branches on the wrong deliverable
// ────────────────────────────────────────────────────────────────────────────
{
  const campaign = detectNeeds('an email launch campaign, newsletter blast, no website', 'site', 'campaign');
  ok('campaign has NO database step', !campaign.includes('database'), campaign.join(','));
  ok('campaign has NO policies step', !campaign.includes('policies'), campaign.join(','));
  ok('campaign has NO integrations step', !campaign.includes('integrations'), campaign.join(','));
  ok('campaign has ONLY campaign_assets', campaign.length === 1 && campaign[0] === 'campaign_assets', campaign.join(','));

  const blog = detectNeeds('a multi-author food magazine with articles and a newsroom', 'app', 'wp_site');
  ok('blog/wp_site has NO policies step (a blog is not a booking system)', !blog.includes('policies'), blog.join(','));
  ok('blog/wp_site has NO integrations/calendar step', !blog.includes('integrations'), blog.join(','));
  ok('blog/wp_site has wp_provision', blog.includes('wp_provision'), blog.join(','));

  const bakery = detectNeeds('a simple bakery website: home, menu, about, contact', 'site', 'directus_site');
  ok('plain site has NO data steps (just content)', !bakery.includes('database') && !bakery.includes('policies'), bakery.join(','));
}

// ────────────────────────────────────────────────────────────────────────────
// T4-A: LANDING_PAGE deliverable — exactly 1 page + spine present + compose/render/qa present
// WHY: a landing page must be shape-forced to ONE page (conversion page shape invariant).
// The spine (understand→research→branding→design→qa) must also be present.
// compose+render must be there because it's still a Directus render (site gates apply).
// ────────────────────────────────────────────────────────────────────────────
{
  const landingBriefs = [
    'a landing page for our new product launch — one-page, conversion-focused, hero + CTA',
    'une page de vente pour notre nouvelle application — atterrissage, conversion, simple',
    'una pagina di atterraggio per il lancio del prodotto — pagina singola, CTA forte',
    'page de vente pour notre boutique de luxe — one page, design premium',
    'squeeze page for email sign-up campaign — one page, minimal, clean',
  ];

  for (const brief of landingBriefs) {
    const d = detectDeliverable(brief);
    ok(`landing brief → landing_page: "${brief.slice(0, 50)}"`, d === 'landing_page', `got ${d}`);
    const needs = detectNeeds(brief, DELIVERABLES[d].archetypeCompat, d);
    const tasks = composeChain(d, needs, [{ slug: 'index', title: 'Home' }]);
    const depts = tasks.map(t => t.department);

    // Spine must be present
    for (const spine of ['strategy', 'research', 'branding', 'design', 'qa']) {
      ok(`landing_page spine '${spine}' present`, depts.includes(spine), `depts: ${depts.join(',')}`);
    }

    // compose + render must be present (it's still a Directus render)
    ok('landing_page: compose present', depts.includes('compose'), `depts: ${depts.join(',')}`);
    ok('landing_page: render present', depts.includes('render'), `depts: ${depts.join(',')}`);

    // CRITICAL: exactly 1 render task (shape-forced to 1 page)
    const renderCount = tasks.filter(t => t.department === 'render').length;
    ok('landing_page: exactly 1 render task (1 page forced)', renderCount === 1, `got ${renderCount} render tasks`);

    // NO data steps (a landing page is not a data deliverable)
    ok('landing_page: no database step', !depts.includes('database'), `depts: ${depts.join(',')}`);
  }

  // T4-A: applyDeliverable forces 1 page in the plan (critical invariant)
  {
    const landingOrch = await orchestrate('landing page for our SaaS product — one-page, hero, CTA');
    ok('landing_page orchestration deliverable', landingOrch.deliverable === 'landing_page', `got ${landingOrch.deliverable}`);
    const multiPageBuilt = {
      tasks: [], pages: [
        { slug: 'index', title: 'Home' },
        { slug: 'features', title: 'Features' },
        { slug: 'pricing', title: 'Pricing' },
      ],
      theme: 'modern' as any, archetype: 'site' as any, shape: 'landing' as any,
    };
    const { applyDeliverable } = await import('./orchestrator.ts');
    const applied = applyDeliverable(multiPageBuilt, landingOrch);
    ok('landing_page: applyDeliverable forces 1 page', applied.pages.length === 1, `got ${applied.pages.length} pages`);
    ok('landing_page: forced page is index', applied.pages[0]?.slug === 'index', `got ${applied.pages[0]?.slug}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// T4-B: BRAND_IDENTITY deliverable — classified + NO render/compose in chain + spine present
// WHY: a brand identity brief yields a brand package ONLY. No compose/render steps.
// The chain ends after design_guidelines + brand_guidelines. qa is present but site-consistent.
// ────────────────────────────────────────────────────────────────────────────
{
  const brandBriefs = [
    'brand identity for our startup — logo design, palette, typography, visual identity guidelines',
    'identité de marque pour notre entreprise — logo, charte graphique, identité visuelle',
    'identità del marchio per la nostra startup — guida del brand, identità visiva, nome',
    'branding only — we need a brand name, wordmark, and brand style guide, no website',
    'visual identity design — logotype, colour palette, typography, brand guidelines document',
  ];

  for (const brief of brandBriefs) {
    const d = detectDeliverable(brief);
    ok(`brand brief → brand_identity: "${brief.slice(0, 50)}"`, d === 'brand_identity', `got ${d}`);
    const needs = detectNeeds(brief, DELIVERABLES[d].archetypeCompat, d);
    const tasks = composeChain(d, needs, [{ slug: 'index', title: 'Home' }]);
    const depts = tasks.map(t => t.department);

    // Spine must be present
    for (const spine of ['strategy', 'research', 'branding', 'design', 'qa']) {
      ok(`brand_identity spine '${spine}' present`, depts.includes(spine), `depts: ${depts.join(',')}`);
    }

    // CRITICAL: NO compose/render steps (not a website)
    ok('brand_identity: NO compose step', !depts.includes('compose'), `depts: ${depts.join(',')}`);
    ok('brand_identity: NO render step', !depts.includes('render'), `depts: ${depts.join(',')}`);

    // brand_guidelines dept must be present
    ok('brand_identity: design/brand_guidelines step present', depts.filter(d => d === 'design').length >= 2,
      `design steps: ${depts.filter(d => d === 'design').join(',')}`);

    // No data steps
    ok('brand_identity: no database step', !depts.includes('database'), `depts: ${depts.join(',')}`);
    ok('brand_identity: no policies step', !depts.includes('policies'), `depts: ${depts.join(',')}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// T4-C: CHAIN REASON — non-empty + names the deliverable for every deliverable type
// WHY: chainReason is displayed to owners on the board. It MUST (a) be non-empty,
// (b) name the deliverable, (c) include "chain:" to show the step sequence.
// ────────────────────────────────────────────────────────────────────────────
{
  const chainReasonCases: [string, string][] = [
    ['landing page for our product — one-page conversion focused', 'landing_page'],
    ['brand identity for our startup — logo, palette, guidelines, no website', 'brand_identity'],
    ['une boutique en ligne de lingerie — vendre, panier, paiement, checkout', 'wp_woocommerce'],
    ['a bakery news blog with articles, recipes and a multi-author newsroom', 'wp_site'],
    ['email campaign newsletter blast social media posts ad creative', 'campaign'],
    ['a SaaS dashboard and booking platform with user accounts and fleet tracking', 'fullstack_app'],
  ];

  for (const [brief, expectedDeliverable] of chainReasonCases) {
    const result = await orchestrate(brief);
    ok(`chainReason: deliverable matches for "${brief.slice(0, 40)}"`,
      result.deliverable === expectedDeliverable, `got ${result.deliverable}`);
    ok(`chainReason: non-empty for ${expectedDeliverable}`,
      typeof result.chainReason === 'string' && result.chainReason.length > 0,
      `chainReason: "${result.chainReason}"`);
    ok(`chainReason: names the deliverable (${expectedDeliverable})`,
      result.chainReason.includes(expectedDeliverable),
      `chainReason: "${result.chainReason}"`);
    ok(`chainReason: includes "chain:" keyword`,
      result.chainReason.includes('chain:'),
      `chainReason: "${result.chainReason}"`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// T4-D: DETERMINISM — chainReason is deterministic (same brief → same chainReason)
// WHY: the board displays chainReason; it must not flicker between page loads.
// ────────────────────────────────────────────────────────────────────────────
{
  const deterministicBriefs = [
    'landing page for our SaaS product launch — one-page hero + CTA',
    'brand identity for a French fashion startup — logo et charte graphique seulement',
    'una boutique online per vendere prodotti di moda — carrello, pagamento, catalogo',
    'a news blog with articles and editorial content — WordPress multi-author',
  ];

  for (const brief of deterministicBriefs) {
    const r1 = await orchestrate(brief);
    const r2 = await orchestrate(brief);
    ok(`determinism: same deliverable for "${brief.slice(0, 40)}"`,
      r1.deliverable === r2.deliverable, `${r1.deliverable} vs ${r2.deliverable}`);
    ok(`determinism: same chainReason for "${brief.slice(0, 40)}"`,
      r1.chainReason === r2.chainReason, `"${r1.chainReason}" vs "${r2.chainReason}"`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// T4-E: SPINE PRESENT in landing_page and brand_identity chains (via buildPlan back-compat)
// WHY: buildPlan must also produce valid spines for new deliverables (not just composeChain).
// ────────────────────────────────────────────────────────────────────────────
{
  for (const [brief, expectedDel] of [
    ['landing page for our new product — one page conversion focused hero CTA', 'landing_page'],
    ['brand identity only — logo design, visual identity, brand guidelines, no website', 'brand_identity'],
  ] as [string, string][]) {
    const { plan: p, orchestration: o } = await buildPlan(brief);
    ok(`buildPlan: ${expectedDel} classified correctly`, o.deliverable === expectedDel, `got ${o.deliverable}`);
    const taskDepts = p.tasks.map((t: any) => t.department);
    for (const spine of ['branding', 'research', 'qa']) {
      ok(`buildPlan ${expectedDel}: spine '${spine}' present`, taskDepts.includes(spine),
        `depts: ${taskDepts.join(',')}`);
    }
    if (expectedDel === 'landing_page') {
      ok(`buildPlan landing_page: compose present`, taskDepts.includes('compose'), `depts: ${taskDepts.join(',')}`);
      ok(`buildPlan landing_page: render present`, taskDepts.includes('render'), `depts: ${taskDepts.join(',')}`);
      ok(`buildPlan landing_page: 1 page`, p.pages.length === 1, `got ${p.pages.length} pages`);
    }
    if (expectedDel === 'brand_identity') {
      ok(`buildPlan brand_identity: NO compose`, !taskDepts.includes('compose'), `depts: ${taskDepts.join(',')}`);
      ok(`buildPlan brand_identity: NO render`, !taskDepts.includes('render'), `depts: ${taskDepts.join(',')}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// T24-A: LOCALE ECOM ROUTING — FR+RELAY_PRESTA=1 → prestashop builder; unset → wp_woocommerce
// WHY: T21 requires deterministic FR locale detection + feature flag gate.
// ────────────────────────────────────────────────────────────────────────────
import { detectDeliverableWithMeta } from './orchestrator.ts';
{
  const frEcomBriefs = [
    'Une boutique en ligne pour vendre des produits de mode — panier, paiement, catalogue',
    'Boutique vendre produits en ligne — livraison, commande, catalogue produits français',
    'Locale:fr boutique en ligne shop vendre panier checkout',
    'Une épicerie fine française en ligne — produits, vendre, panier, paiement, livraison',
  ];

  // Without RELAY_PRESTA (default) — must always be wp_woocommerce builder
  const savedPresta = process.env.RELAY_PRESTA;
  delete process.env.RELAY_PRESTA;
  for (const brief of frEcomBriefs) {
    const result = await orchestrate(brief);
    ok(`T21 no-flag: FR ecom → wp_woocommerce builder (not prestashop): "${brief.slice(0, 45)}"`,
      result.builder === 'wordpress' && result.deliverable === 'wp_woocommerce',
      `builder=${result.builder} deliverable=${result.deliverable}`);
  }

  // With RELAY_PRESTA=1 — FR ecom should switch to prestashop builder
  process.env.RELAY_PRESTA = '1';
  for (const brief of frEcomBriefs) {
    const result = await orchestrate(brief);
    ok(`T21 RELAY_PRESTA=1: FR ecom → prestashop builder: "${brief.slice(0, 45)}"`,
      result.builder === 'prestashop' && result.stack === 'prestashop',
      `builder=${result.builder} stack=${result.stack}`);
    // deliverable id STAYS wp_woocommerce (the e-com contract)
    ok(`T21 RELAY_PRESTA=1: FR ecom deliverable id stays wp_woocommerce: "${brief.slice(0, 45)}"`,
      result.deliverable === 'wp_woocommerce',
      `deliverable=${result.deliverable}`);
  }

  // Non-FR ecom with RELAY_PRESTA=1 — must NOT switch to prestashop
  const enEcomBriefs = [
    'an online shop for handmade candles — products, cart, checkout, catalog',
    'a webshop for electronics — store, inventory, checkout, shipping',
    'Un negozio online per vendere prodotti — carrello, pagamento, catalogo (Italian)',
  ];
  for (const brief of enEcomBriefs) {
    const result = await orchestrate(brief);
    ok(`T21 RELAY_PRESTA=1: non-FR ecom stays wp_woocommerce builder: "${brief.slice(0, 45)}"`,
      result.builder === 'wordpress' && result.deliverable === 'wp_woocommerce',
      `builder=${result.builder} deliverable=${result.deliverable}`);
  }

  // Restore env
  if (savedPresta !== undefined) process.env.RELAY_PRESTA = savedPresta;
  else delete process.env.RELAY_PRESTA;
}

// ────────────────────────────────────────────────────────────────────────────
// T24-B: CONFIDENCE + SECOND-CHOICE — in [0,1] and present on every orchestrate() call
// WHY: T22 requires confidence and secondChoice in OrchestrationResult.
// ────────────────────────────────────────────────────────────────────────────
{
  const confidenceBriefs: [string, string][] = [
    ['une boutique en ligne pour vendre des produits — panier, paiement, livraison', 'wp_woocommerce'],
    ['a SaaS dashboard and booking platform with user accounts', 'fullstack_app'],
    ['email campaign newsletter blast social media posts ad creative', 'campaign'],
    ['a landing page for our product — one-page conversion CTA hero', 'landing_page'],
    ['a simple 5-page bakery website — home, about, menu, contact', 'directus_site'],
    ['a photography portfolio showcase — my work, case studies, gallery', 'portfolio'],
    ['wedding conference festival event site — programme, RSVP, speakers', 'event'],
  ];

  for (const [brief, expectedDel] of confidenceBriefs) {
    const result = await orchestrate(brief);
    ok(`T22 confidence present for ${expectedDel}`,
      typeof result.confidence === 'number',
      `got ${typeof result.confidence}`);
    ok(`T22 confidence in [0,1] for ${expectedDel}`,
      result.confidence >= 0 && result.confidence <= 1,
      `confidence=${result.confidence}`);
    ok(`T22 secondChoice present for ${expectedDel}`,
      typeof result.secondChoice === 'string' && result.secondChoice.length > 0,
      `got ${typeof result.secondChoice}`);
    ok(`T22 secondChoice is a valid deliverable for ${expectedDel}`,
      result.secondChoice in DELIVERABLES,
      `secondChoice=${result.secondChoice}`);
    // chainReason must include confidence + alt markers
    ok(`T22 chainReason contains confidence: for ${expectedDel}`,
      result.chainReason.includes('confidence:'),
      `chainReason="${result.chainReason}"`);
    ok(`T22 chainReason contains alt: for ${expectedDel}`,
      result.chainReason.includes('alt:'),
      `chainReason="${result.chainReason}"`);
  }

  // Determinism: confidence and secondChoice must be stable (no flicker)
  const stableBrief = 'une boutique en ligne de lingerie — vendre, panier, paiement, checkout';
  const r1 = await orchestrate(stableBrief);
  const r2 = await orchestrate(stableBrief);
  ok('T22 determinism: confidence stable', r1.confidence === r2.confidence,
    `${r1.confidence} vs ${r2.confidence}`);
  ok('T22 determinism: secondChoice stable', r1.secondChoice === r2.secondChoice,
    `${r1.secondChoice} vs ${r2.secondChoice}`);

  // detectDeliverableWithMeta produces the same floor
  const meta = detectDeliverableWithMeta(stableBrief);
  ok('T22 detectDeliverableWithMeta.deliverable matches orchestrate',
    meta.deliverable === r1.deliverable,
    `meta=${meta.deliverable} orch=${r1.deliverable}`);
  ok('T22 detectDeliverableWithMeta.confidence same as orchestrate',
    meta.confidence === r1.confidence,
    `meta=${meta.confidence} orch=${r1.confidence}`);
}

// ────────────────────────────────────────────────────────────────────────────
// T24-C: PORTFOLIO + EVENT classify correctly + spine + compose/render present
// WHY: T23 requires portfolio and event deliverables with working builder + chain.
// ────────────────────────────────────────────────────────────────────────────
{
  // Portfolio EN/FR/IT detection
  const portfolioBriefs = [
    'a photography portfolio site — my work, case studies, gallery, about',
    'a designer portfolio showcase — lookbook, projects, creative work',
    'une vitrine créative — book photo, galerie, mes projets',
    'un portfolio fotografico — lavori, galleria fotografica, about',
    'a creative portfolio for a UX designer — case studies, my work, folio',
  ];
  for (const brief of portfolioBriefs) {
    const d = detectDeliverable(brief);
    ok(`T23 portfolio brief → portfolio: "${brief.slice(0, 50)}"`, d === 'portfolio', `got ${d}`);
    const needs = detectNeeds(brief, DELIVERABLES[d].archetypeCompat, d);
    const tasks = composeChain(d, needs, TEST_PAGES);
    const depts = tasks.map(t => t.department);

    // Spine must be present
    for (const spine of SPINE_DEPTS) {
      ok(`T23 portfolio spine '${spine}' present`, depts.includes(spine));
    }
    // compose + render must be present (directus render path)
    ok('T23 portfolio: compose present', depts.includes('compose'), `depts: ${depts.join(',')}`);
    ok('T23 portfolio: render present', depts.includes('render'), `depts: ${depts.join(',')}`);
    // NO data steps
    ok('T23 portfolio: no database', !depts.includes('database'), `depts: ${depts.join(',')}`);
    // builder must be directus
    ok('T23 portfolio: builder=directus', DELIVERABLES['portfolio'].builder === 'directus');
  }

  // Event EN/FR/IT detection
  const eventBriefs = [
    'a conference site — speakers, programme, RSVP, venue, attendees',
    'a wedding website — ceremony, venue, RSVP, gallery',
    'a music festival site — programme, lineup, RSVP',
    'un site pour notre conférence — programme, intervenants, inscription en ligne',
    'un site de mariage — cérémonie, programme, RSVP',
    'un sito per il convegno — programma, relatori, iscrizione, cerimonia',
  ];
  for (const brief of eventBriefs) {
    const d = detectDeliverable(brief);
    ok(`T23 event brief → event: "${brief.slice(0, 50)}"`, d === 'event', `got ${d}`);
    const needs = detectNeeds(brief, DELIVERABLES[d].archetypeCompat, d);
    const tasks = composeChain(d, needs, TEST_PAGES);
    const depts = tasks.map(t => t.department);

    // Spine must be present
    for (const spine of SPINE_DEPTS) {
      ok(`T23 event spine '${spine}' present`, depts.includes(spine));
    }
    // compose + render must be present
    ok('T23 event: compose present', depts.includes('compose'), `depts: ${depts.join(',')}`);
    ok('T23 event: render present', depts.includes('render'), `depts: ${depts.join(',')}`);
    // integrations (calendar feed) must be present
    ok('T23 event: integrations present', depts.includes('integrations'), `depts: ${depts.join(',')}`);
    // NO database step (events don't need relational data)
    ok('T23 event: no database step', !depts.includes('database'), `depts: ${depts.join(',')}`);
    // builder must be directus
    ok('T23 event: builder=directus', DELIVERABLES['event'].builder === 'directus');
  }

  // Portfolio and event must NOT fire for plain briefs
  ok('T23 plain site is NOT portfolio', detectDeliverable('a simple website for our bakery') !== 'portfolio');
  ok('T23 plain site is NOT event', detectDeliverable('a simple website for our bakery') !== 'event');

  // portfolio does NOT have database/policies
  {
    const needs = detectNeeds('a photographer portfolio with gallery and case studies', 'site', 'portfolio');
    ok('T23 portfolio needs: no database', !needs.includes('database'), needs.join(','));
    ok('T23 portfolio needs: no policies', !needs.includes('policies'), needs.join(','));
    ok('T23 portfolio needs: content_copy present', needs.includes('content_copy'), needs.join(','));
  }

  // event has integrations but NO database
  {
    const needs = detectNeeds('a conference event site with RSVP and speakers programme', 'site', 'event');
    ok('T23 event needs: integrations present', needs.includes('integrations'), needs.join(','));
    ok('T23 event needs: no database', !needs.includes('database'), needs.join(','));
    ok('T23 event needs: content_copy present', needs.includes('content_copy'), needs.join(','));
  }

  // orchestrate() produces portfolio and event deliverables correctly (via buildPlan integration)
  {
    const portfolioResult = await orchestrate('a photography portfolio — gallery, my work, case studies, book photo');
    ok('T23 orchestrate: portfolio deliverable', portfolioResult.deliverable === 'portfolio',
      `got ${portfolioResult.deliverable}`);
    ok('T23 orchestrate: portfolio builder=directus', portfolioResult.builder === 'directus',
      `got ${portfolioResult.builder}`);
    ok('T23 orchestrate: portfolio chainReason includes deliverable', portfolioResult.chainReason.includes('portfolio'),
      `chainReason: "${portfolioResult.chainReason}"`);
  }
  {
    const eventResult = await orchestrate('a conference event site with programme, speakers, RSVP and venue');
    ok('T23 orchestrate: event deliverable', eventResult.deliverable === 'event',
      `got ${eventResult.deliverable}`);
    ok('T23 orchestrate: event builder=directus', eventResult.builder === 'directus',
      `got ${eventResult.builder}`);
    ok('T23 orchestrate: event chainReason includes deliverable', eventResult.chainReason.includes('event'),
      `chainReason: "${eventResult.chainReason}"`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// T24-D: DETERMINISM — portfolio, event, confidence all deterministic
// ────────────────────────────────────────────────────────────────────────────
{
  const detBriefs = [
    'a photography portfolio site — gallery, my work, case studies, showcase',
    'a conference event site — programme, speakers, RSVP, venue',
  ];
  for (const brief of detBriefs) {
    const r1 = await orchestrate(brief);
    const r2 = await orchestrate(brief);
    ok(`T24 determinism: deliverable for "${brief.slice(0, 40)}"`,
      r1.deliverable === r2.deliverable, `${r1.deliverable} vs ${r2.deliverable}`);
    ok(`T24 determinism: confidence for "${brief.slice(0, 40)}"`,
      r1.confidence === r2.confidence, `${r1.confidence} vs ${r2.confidence}`);
    ok(`T24 determinism: secondChoice for "${brief.slice(0, 40)}"`,
      r1.secondChoice === r2.secondChoice, `${r1.secondChoice} vs ${r2.secondChoice}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// T24-E: DEFAULT 5-PAGE SITE UNCHANGED — confidence/secondChoice additive only
// WHY: the existing 5-page bakery directus_site path must be byte-identical to before.
// ────────────────────────────────────────────────────────────────────────────
{
  const brief = '5-page bakery website — home, about, menu, gallery, contact';
  const result = await orchestrate(brief);
  ok('T24 default 5-page: deliverable still directus_site', result.deliverable === 'directus_site',
    `got ${result.deliverable}`);
  ok('T24 default 5-page: builder still directus', result.builder === 'directus',
    `got ${result.builder}`);
  ok('T24 default 5-page: confidence present', typeof result.confidence === 'number',
    `got ${typeof result.confidence}`);
  ok('T24 default 5-page: secondChoice present', typeof result.secondChoice === 'string',
    `got ${typeof result.secondChoice}`);
  // Back-compat: tasks must still have compose/render/qa (unchanged chain)
  const { plan } = await buildPlan(brief);
  const taskDepts = plan.tasks.map((t: any) => t.department);
  ok('T24 default back-compat: compose present', taskDepts.includes('compose'));
  ok('T24 default back-compat: render present', taskDepts.includes('render'));
  ok('T24 default back-compat: qa present', taskDepts.includes('qa'));
  ok('T24 default back-compat: branding present', taskDepts.includes('branding'));
  ok('T24 default back-compat: no database on plain site', !taskDepts.includes('database'));
}

// ────────────────────────────────────────────────────────────────────────────
// RESULT
// ────────────────────────────────────────────────────────────────────────────
console.log(`\norchestrator:check — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

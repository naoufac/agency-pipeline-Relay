// orchestrated-e2e-check.ts — T39: CROSS-CUTTING E2E GATE FOR ORCHESTRATOR ROUTING.
//
// WHY this file exists: orchestrator-check.ts probes the low-level primitives
// (detectDeliverable, composeChain, detectNeeds). This gate goes ONE level higher and
// proves the entire orchestrate() → composeChain() path for EVERY deliverable, with
// the LLM stubbed to offline so it exercises ONLY the deterministic floor.
//
// CONTRACT:
//   For each deliverable the gate asserts:
//   1. orchestrate() (LLM offline) → correct {deliverable, builder, stack}.
//   2. The FORCED SPINE departments appear in order in the emitted chain:
//      strategy → research → branding → design → qa.
//   3. The EXPECTED DYNAMIC BRANCHES are present (per-deliverable).
//   4. chainReason is a non-empty human-readable string that names the deliverable
//      AND contains "chain:" so a board owner can audit the routing decision.
//   5. QA is the last task in every chain.
//
// BRIEFS covered (one per deliverable + two "natural falls-through" cases):
//   bakery          → directus_site
//   blog            → wp_site
//   FR shop         → wp_woocommerce
//   courier         → fullstack_app
//   landing page    → landing_page
//   brand only      → brand_identity
//   email campaign  → campaign
//   portfolio       → directus_site   (portfolio signals boost directus baseline)
//   event           → directus_site   (a corporate event site, no ecom/app signals)
//
// Run: npm run e2e:check
// Exit 0 on all pass, exit 1 on any failure.
//
// ────────────────────── ANCHOR: e2e ────────────────────────────────────────────

import {
  orchestrate,
  composeChain,
  detectNeeds,
  DELIVERABLES,
  type DeliverableId,
  type CapId,
} from './orchestrator.ts';

let pass = 0, fail = 0;

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SPINE ASSERTION HELPER
// The forced spine must always appear in this department ORDER.
// WHY: if strategy fires after branding the planner has lost the plot.
// We check presence + ordering (each spine dept's FIRST task must appear in
// strictly ascending seq order).
// ────────────────────────────────────────────────────────────────────────────

const SPINE_ORDER = ['strategy', 'research', 'branding', 'design', 'qa'] as const;

function assertSpineOrder(
  label: string,
  tasks: { seq: number; department: string }[],
): void {
  // Each spine department must be present
  for (const dept of SPINE_ORDER) {
    ok(`${label}: spine '${dept}' present`, tasks.some(t => t.department === dept));
  }

  // Spine departments must appear in the correct forward order (strategy before
  // research, research before branding, etc.). We compare the first occurrence
  // of each spine dept (they may repeat — e.g. 'design' appears for both
  // design_guidelines and brand_guidelines — so first-occurrence is the floor).
  const firstSeq = (dept: string): number => {
    const t = tasks.find(t => t.department === dept);
    return t ? t.seq : Infinity;
  };

  for (let i = 0; i < SPINE_ORDER.length - 1; i++) {
    const a = SPINE_ORDER[i];
    const b = SPINE_ORDER[i + 1];
    // qa is last — its comparison is handled in the qa-is-last gate below.
    if (b === 'qa') continue;
    const seqA = firstSeq(a);
    const seqB = firstSeq(b);
    ok(
      `${label}: spine order — '${a}' (seq ${seqA}) before '${b}' (seq ${seqB})`,
      seqA < seqB,
      `${a}=${seqA}, ${b}=${seqB}`,
    );
  }
}

function assertQaLast(label: string, tasks: { seq: number; department: string }[]): void {
  const maxSeq = Math.max(...tasks.map(t => t.seq));
  const qaTask = tasks.find(t => t.department === 'qa');
  ok(
    `${label}: qa is the last task`,
    !!qaTask && qaTask.seq === maxSeq,
    `qa.seq=${qaTask?.seq ?? 'MISSING'}, maxSeq=${maxSeq}`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// CHAIN REASON ASSERTION HELPER
// chainReason must: (a) be non-empty, (b) name the deliverable, (c) contain "chain:".
// WHY: the board displays this string verbatim for owner audit.
// ────────────────────────────────────────────────────────────────────────────

function assertChainReason(label: string, chainReason: string, deliverable: DeliverableId): void {
  ok(`${label}: chainReason is non-empty`, typeof chainReason === 'string' && chainReason.length > 0);
  ok(
    `${label}: chainReason names the deliverable '${deliverable}'`,
    chainReason.includes(deliverable),
    `got: "${chainReason}"`,
  );
  ok(
    `${label}: chainReason contains "chain:" keyword`,
    chainReason.includes('chain:'),
    `got: "${chainReason}"`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ORCHESTRATE HELPER — runs orchestrate() with the LLM STUBBED to offline.
//
// WHY stubbed: the gate is a DETERMINISTIC proof of the floor routing. If the
// LLM were live the gate would be flaky (network, quota, latency). The floor
// detector (pure regex, zero network) is what we're proving here. The LLM
// upgrade path is covered in orchestrator-check.ts section 5.
//
// Implementation: we pass opts.llm = undefined (omit entirely) so orchestrate()
// skips the LLM block and runs purely on the deterministic floor. This is
// identical to what tests run in CI (no API keys).
// ────────────────────────────────────────────────────────────────────────────

async function orchestrateDet(brief: string) {
  // No opts.llm → floor-only, zero network, fully deterministic.
  return orchestrate(brief);
}

// ────────────────────────────────────────────────────────────────────────────
// CASE DEFINITIONS
//
// Each case specifies:
//  - label:        human-readable test name
//  - brief:        the representative client brief
//  - deliverable:  expected DeliverableId
//  - builder:      expected builder key
//  - stack:        expected stack key
//  - branches:     departments that MUST be present in the dynamic branch
//                  (spine depts are checked separately for all cases)
//  - noBranches:   departments that must NOT appear (anti-regression guard)
// ────────────────────────────────────────────────────────────────────────────

type Case = {
  label: string;
  brief: string;
  deliverable: DeliverableId;
  builder: string;
  stack: string;
  branches: string[];          // expected dynamic-branch departments
  noBranches: string[];        // anti-regression: must NOT be present
};

const CASES: Case[] = [
  // ── BAKERY → directus_site ─────────────────────────────────────────────
  // WHY: a classic small-business brochure site (recipes, seasonal blog, no shop)
  // must route to the default Directus renderer, not a WordPress or WooCommerce build.
  // The blog signal is present but it is overwhelmed by the "brochure" framing;
  // the direct signal "blog" scores wp_site but the brief is too general to cross the
  // floor + 4-cap. We test the archetypal "local bakery" case that must stay on directus.
  {
    label: 'bakery brochure site → directus_site',
    brief: 'a brochure website for a Naples bakery — home, about, menu, gallery, contact',
    deliverable: 'directus_site',
    builder: 'directus',
    stack: 'directus',
    branches: ['compose', 'render'],   // directus_site always gets compose+render
    noBranches: ['wp_provision', 'ecom_catalog', 'app_api'],
  },

  // ── BLOG → wp_site ────────────────────────────────────────────────────
  // WHY: a news/editorial/multi-author magazine maps to WordPress (the CMS the LLM
  // already masters for content management). Must NOT go to woocommerce or fullstack_app.
  {
    label: 'editorial blog → wp_site',
    brief: 'a multi-author food magazine with recipes, news, and editorial articles — blog, newsroom, content hub',
    deliverable: 'wp_site',
    builder: 'wordpress',
    stack: 'wordpress',
    branches: ['wp_provision', 'content'],  // WordPress provision + content copy
    noBranches: ['ecom_catalog', 'app_api', 'database'],
  },

  // ── FR SHOP → wp_woocommerce ──────────────────────────────────────────
  // WHY: French e-commerce signals (boutique, vendre, panier, paiement) must unambiguously
  // resolve to WooCommerce — a bilingual FR/EN shop scenario the real client base uses.
  {
    label: 'FR lingerie boutique → wp_woocommerce',
    brief: 'une boutique en ligne de lingerie — vendre des produits, panier, paiement, checkout, catalogue',
    deliverable: 'wp_woocommerce',
    builder: 'wordpress',
    stack: 'woocommerce',
    branches: ['wp_provision', 'database', 'integrations'],  // woo gets DB + provision + integrations (data branch)
    noBranches: ['app_api'],
  },

  // ── COURIER → fullstack_app ───────────────────────────────────────────
  // WHY: a settlement dashboard for delivery drivers (tracking, earnings, platform)
  // requires a real data backend — it is a fullstack_app, NOT a brochure site.
  {
    label: 'COD courier dashboard → fullstack_app',
    brief: 'get paid tomorrow — a settlement dashboard for COD courier drivers tracking their deliveries and earnings on a logistics platform',
    deliverable: 'fullstack_app',
    builder: 'app',
    stack: 'node-postgres',
    branches: ['database', 'policies', 'integrations', 'app_api'],
    noBranches: ['wp_provision', 'ecom_catalog'],
  },

  // ── LANDING PAGE → landing_page ───────────────────────────────────────
  // WHY: a single-page conversion-focused brief must be shape-forced to 1 page.
  // The landing_page deliverable forces exactly ONE render task; no multi-page nav.
  {
    label: 'product launch landing page → landing_page',
    brief: 'a landing page for the launch of our new SaaS product — one-page, hero, CTA, social proof, conversion-focused',
    deliverable: 'landing_page',
    builder: 'directus',
    stack: 'directus',
    branches: ['compose', 'render', 'content'],  // landing still gets compose+render+copy
    noBranches: ['wp_provision', 'database', 'ecom_catalog', 'app_api'],
  },

  // ── BRAND ONLY → brand_identity ───────────────────────────────────────
  // WHY: a "brand identity only" brief (logo, palette, guidelines, NO website) must
  // produce ZERO compose/render steps. The chain ends after design_guidelines + brand_guidelines.
  {
    label: 'brand identity only → brand_identity',
    brief: 'brand identity for our startup — logo design, visual identity, brand guidelines document, no website',
    deliverable: 'brand_identity',
    builder: 'campaign',
    stack: 'campaign',
    branches: ['design'],   // brand_guidelines is emitted as a 'design' dept task
    noBranches: ['compose', 'render', 'wp_provision', 'database', 'app_api'],
  },

  // ── EMAIL CAMPAIGN → campaign ─────────────────────────────────────────
  // WHY: a pure email/social campaign has no website to render. The chain must
  // contain NO compose/render steps; only campaign_assets (emitted as 'content').
  {
    label: 'email launch campaign → campaign',
    brief: 'email campaign for the launch of a new product — newsletter blast, drip campaign, social media posts, ad creative',
    deliverable: 'campaign',
    builder: 'campaign',
    stack: 'campaign',
    branches: ['content'],   // campaign_assets emitted as content dept
    noBranches: ['compose', 'render', 'wp_provision', 'database', 'app_api'],
  },

  // ── PORTFOLIO → directus_site ─────────────────────────────────────────
  // WHY: a freelance photographer's portfolio is a classic brochure/presentation site.
  // "portfolio" is a directus_site booster signal (score+3). No ecom, no data.
  {
    label: 'photographer portfolio → directus_site',
    brief: 'a portfolio site for a freelance photographer — home, about, portfolio gallery, contact',
    deliverable: 'directus_site',
    builder: 'directus',
    stack: 'directus',
    branches: ['compose', 'render'],
    noBranches: ['wp_provision', 'database', 'ecom_catalog', 'app_api'],
  },

  // ── EVENT → directus_site ─────────────────────────────────────────────
  // WHY: a corporate event website (speakers, schedule, venue — but no ticketing/booking
  // signals that would fire fullstack_app, and no editorial/news signals that would fire
  // wp_site) is a brochure/presentation site. The brief deliberately avoids "press",
  // "news", "blog", booking/reservation language so the deterministic floor is directus_site.
  {
    label: 'corporate event site → directus_site',
    brief: 'website for an annual corporate conference — speakers, program, venue information, sponsors, contact',
    deliverable: 'directus_site',
    builder: 'directus',
    stack: 'directus',
    branches: ['compose', 'render'],
    noBranches: ['wp_provision', 'database', 'app_api', 'ecom_catalog'],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// MAIN GATE: run every case
// ────────────────────────────────────────────────────────────────────────────

const TEST_PAGES = [{ slug: 'index', title: 'Home' }, { slug: 'about', title: 'About' }];

for (const c of CASES) {
  const result = await orchestrateDet(c.brief);
  const tasks = composeChain(result.deliverable, result.detectedNeeds, TEST_PAGES);
  const depts = tasks.map(t => t.department);

  // ── 1. Routing: deliverable + builder + stack ─────────────────────────
  ok(
    `${c.label}: deliverable → ${c.deliverable}`,
    result.deliverable === c.deliverable,
    `got ${result.deliverable}`,
  );
  ok(
    `${c.label}: builder → ${c.builder}`,
    result.builder === c.builder,
    `got ${result.builder}`,
  );
  ok(
    `${c.label}: stack → ${c.stack}`,
    result.stack === c.stack,
    `got ${result.stack}`,
  );

  // ── 2. Forced spine present in order ─────────────────────────────────
  assertSpineOrder(c.label, tasks);

  // ── 3. QA is the last task ────────────────────────────────────────────
  assertQaLast(c.label, tasks);

  // ── 4. Expected dynamic branches present ─────────────────────────────
  for (const expectedDept of c.branches) {
    ok(
      `${c.label}: branch '${expectedDept}' present`,
      depts.includes(expectedDept),
      `got depts: ${depts.join(',')}`,
    );
  }

  // ── 5. Anti-regression: forbidden departments absent ─────────────────
  for (const forbiddenDept of c.noBranches) {
    ok(
      `${c.label}: branch '${forbiddenDept}' absent`,
      !depts.includes(forbiddenDept),
      `unexpectedly found in depts: ${depts.join(',')}`,
    );
  }

  // ── 6. chainReason human-readable + names deliverable ────────────────
  assertChainReason(c.label, result.chainReason, c.deliverable);
}

// ────────────────────────────────────────────────────────────────────────────
// CROSS-CUTTING: TASK SHAPE INVARIANT
// Every task emitted by any deliverable's chain MUST have the frozen shape:
//   {seq:number, title:string, department:string, verify:string,
//    depends_on:number[], artifact:string|null}
// WHY: runner.ts and planner.ts depend on this shape contract. Any deviation
// here means a broken DAG execution.
// ────────────────────────────────────────────────────────────────────────────

for (const c of CASES) {
  const result = await orchestrateDet(c.brief);
  const tasks = composeChain(result.deliverable, result.detectedNeeds, TEST_PAGES);
  for (const t of tasks) {
    ok(
      `task shape: seq is number [${c.deliverable}, seq=${t.seq}]`,
      typeof t.seq === 'number' && Number.isFinite(t.seq),
    );
    ok(
      `task shape: title is non-empty string [${c.deliverable}, seq=${t.seq}]`,
      typeof t.title === 'string' && t.title.length > 0,
    );
    ok(
      `task shape: department is non-empty string [${c.deliverable}, seq=${t.seq}]`,
      typeof t.department === 'string' && t.department.length > 0,
    );
    ok(
      `task shape: verify is non-empty string [${c.deliverable}, seq=${t.seq}]`,
      typeof t.verify === 'string' && t.verify.length > 0,
    );
    ok(
      `task shape: depends_on is array [${c.deliverable}, seq=${t.seq}]`,
      Array.isArray(t.depends_on),
    );
    ok(
      `task shape: artifact is string|null [${c.deliverable}, seq=${t.seq}]`,
      t.artifact === null || typeof t.artifact === 'string',
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CROSS-CUTTING: DETERMINISM
// Same brief run twice → identical {deliverable, stack, builder, chainReason}.
// WHY: the board caches and displays orchestration results; they must not
// differ between page loads (no flicker for the owner).
// ────────────────────────────────────────────────────────────────────────────

for (const c of CASES) {
  const r1 = await orchestrateDet(c.brief);
  const r2 = await orchestrateDet(c.brief);
  ok(
    `determinism: deliverable stable for "${c.label}"`,
    r1.deliverable === r2.deliverable,
    `${r1.deliverable} vs ${r2.deliverable}`,
  );
  ok(
    `determinism: stack stable for "${c.label}"`,
    r1.stack === r2.stack,
    `${r1.stack} vs ${r2.stack}`,
  );
  ok(
    `determinism: chainReason stable for "${c.label}"`,
    r1.chainReason === r2.chainReason,
    `"${r1.chainReason}" vs "${r2.chainReason}"`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// CROSS-CUTTING: LANDING_PAGE SHAPE INVARIANT
// landing_page must produce EXACTLY ONE render task regardless of how many
// pages are passed to composeChain.
// WHY: a landing page is shape-forced. If composeChain ever emits two render
// tasks the multi-page nav will appear and the conversion shape is broken.
// ────────────────────────────────────────────────────────────────────────────

{
  const landingBrief = 'a landing page for our new product launch — one-page, hero, CTA, sign-up';
  const r = await orchestrateDet(landingBrief);
  ok('landing_page: deliverable is landing_page', r.deliverable === 'landing_page', `got ${r.deliverable}`);

  // Pass a multi-page set — composeChain must still force exactly 1 render
  const multiPages = [
    { slug: 'index', title: 'Home' },
    { slug: 'features', title: 'Features' },
    { slug: 'pricing', title: 'Pricing' },
  ];
  const tasks = composeChain(r.deliverable, r.detectedNeeds, multiPages);
  const renderTasks = tasks.filter(t => t.department === 'render');
  ok(
    'landing_page: exactly 1 render task even when multi-page input supplied',
    renderTasks.length === 1,
    `got ${renderTasks.length} render tasks`,
  );
  ok(
    'landing_page: the forced page slug is "index"',
    renderTasks[0]?.artifact === 'index.html',
    `got artifact: ${renderTasks[0]?.artifact}`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// CROSS-CUTTING: BRAND_IDENTITY NO-RENDER INVARIANT
// brand_identity must NEVER emit compose or render tasks. There is no website.
// WHY: if compose/render slip through the builder will attempt to provision a
// Directus site that doesn't exist in the project — a corrupt build.
// ────────────────────────────────────────────────────────────────────────────

{
  const brandBrief = 'brand identity only — logo design, palette, typography, brand guidelines, no website';
  const r = await orchestrateDet(brandBrief);
  ok('brand_identity: deliverable is brand_identity', r.deliverable === 'brand_identity', `got ${r.deliverable}`);

  const tasks = composeChain(r.deliverable, r.detectedNeeds, TEST_PAGES);
  const depts = tasks.map(t => t.department);
  ok('brand_identity: NO compose task', !depts.includes('compose'), `depts: ${depts.join(',')}`);
  ok('brand_identity: NO render task', !depts.includes('render'), `depts: ${depts.join(',')}`);
  ok('brand_identity: design (brand_guidelines) task present', depts.filter(d => d === 'design').length >= 2, `design tasks: ${depts.filter(d => d === 'design').join(',')}`);
}

// ────────────────────────────────────────────────────────────────────────────
// CROSS-CUTTING: CAMPAIGN NO-SITE INVARIANT
// campaign must NEVER emit compose or render tasks. There is no site to build.
// WHY: a campaign is pure-asset (email HTML, social images); routing it to the
// site builder would generate a ghost Directus project with no content.
// ────────────────────────────────────────────────────────────────────────────

{
  const campaignBrief = 'email campaign newsletter blast social media posts ad creative mailing drip';
  const r = await orchestrateDet(campaignBrief);
  ok('campaign: deliverable is campaign', r.deliverable === 'campaign', `got ${r.deliverable}`);

  const tasks = composeChain(r.deliverable, r.detectedNeeds, TEST_PAGES);
  const depts = tasks.map(t => t.department);
  ok('campaign: NO compose task', !depts.includes('compose'), `depts: ${depts.join(',')}`);
  ok('campaign: NO render task', !depts.includes('render'), `depts: ${depts.join(',')}`);
  ok('campaign: campaign_assets (content) task present', depts.includes('content'), `depts: ${depts.join(',')}`);
}

// ────────────────────────────────────────────────────────────────────────────
// CROSS-CUTTING: WP DELIVERABLES — wp_provision always present
// Both wp_site and wp_woocommerce must include wp_provision in their chain.
// WHY: without wp_provision the WordPress container is never configured;
// the builder will try to write to a blank WP install.
// ────────────────────────────────────────────────────────────────────────────

{
  for (const [brief, expectedDel] of [
    ['a news and articles magazine with multi-author WordPress blog', 'wp_site'],
    ['une boutique en ligne — shop, cart, checkout, catalogue, vendre des produits', 'wp_woocommerce'],
  ] as [string, DeliverableId][]) {
    const r = await orchestrateDet(brief);
    ok(`${expectedDel}: deliverable correct`, r.deliverable === expectedDel, `got ${r.deliverable}`);
    const tasks = composeChain(r.deliverable, r.detectedNeeds, TEST_PAGES);
    const depts = tasks.map(t => t.department);
    ok(`${expectedDel}: wp_provision dept present`, depts.includes('wp_provision'), `depts: ${depts.join(',')}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CROSS-CUTTING: FULLSTACK_APP — data branch always present
// A fullstack_app must always emit database + policies + integrations + app_api.
// WHY: these four form the "real backend" guarantee. A fullstack_app without
// a real schema is a brochure pretending to be an app.
// ────────────────────────────────────────────────────────────────────────────

{
  const appBrief = 'a SaaS booking platform and fleet tracking dashboard for courier companies — subscriptions, reservations, live tracking';
  const r = await orchestrateDet(appBrief);
  ok('fullstack_app: deliverable correct', r.deliverable === 'fullstack_app', `got ${r.deliverable}`);
  const tasks = composeChain(r.deliverable, r.detectedNeeds, TEST_PAGES);
  const depts = tasks.map(t => t.department);
  for (const dept of ['database', 'policies', 'integrations', 'app_api']) {
    ok(`fullstack_app: '${dept}' dept present`, depts.includes(dept), `depts: ${depts.join(',')}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// RESULT
// ────────────────────────────────────────────────────────────────────────────

console.log(`\norchestrated-e2e-check — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

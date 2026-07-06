// cms:check — deterministic invariant: RELAY HAS EXACTLY ONE CMS (Directus), forced in code.
// Fails the moment anyone re-introduces a selector, a second registry entry, a rogue build
// endpoint, or a non-directus name. Run: npm run cms:check (exit 1 on any failure).
//
// BUILDER REGISTRY: the builder registry (resolveBuilder, BUILDER_REGISTRY) is orthogonal and
// is NOT checked here — it lives in registry.ts and is exercised by wp:check. This file only
// concerns itself with the one-CMS invariant (params.cms STAYS 'directus' forever).
import { readFileSync } from 'node:fs';
import { REGISTRY, CMS_ORDER, resolveBuildable, resolveBuilder } from './registry.ts';
import { CMS_NAMES, isCmsName, BUILDER_IDS } from './types.ts';

let fails = 0;
const ok = (cond: boolean, label: string) => { console.log(`${cond ? '✅' : '❌'} ${label}`); if (!cond) fails++; };

ok(CMS_NAMES.length === 1 && CMS_NAMES[0] === 'directus', 'types: exactly one CmsName — directus');
ok(Object.keys(REGISTRY).length === 1 && !!REGISTRY.directus, 'registry: exactly one entry — directus');
ok(CMS_ORDER.length === 1 && CMS_ORDER[0] === 'directus', 'order: directus only');
ok(REGISTRY.directus.status === 'proven', 'directus is proven');
ok(!isCmsName('wordpress') && !isCmsName('drupal') && !isCmsName('payload') && !isCmsName('sanity') && !isCmsName('craft'),
  'retired CMS names are rejected');
const r = resolveBuildable('directus');
ok(r.name === 'directus' && r.fellBackFrom === null, 'resolveBuildable(directus) → directus, no fallback');

// structural invariants on the entrypoints: no selector, no parallel generator, cms forced in code
const planner = readFileSync(new URL('../planner.ts', import.meta.url), 'utf8');
ok(!planner.includes("cms/select") && planner.includes("const cms = 'directus'"),
  "planner: cms hardcoded to 'directus', no selector import");
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
ok(!server.includes("from './cms/wordpress") && !server.includes("from './cms/usecase"),
  'server: no wordpress/usecase generator imports');
const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
ok(!app.includes("'/api/cms-run'"), 'board UI: brief posts to /api/run (no /api/cms-run)');

// SEO identity survives the CMS re-serve (the FINAL writer of every page): the adapter's
// renderPage call and the finalize ctx must thread siteBase/localBusiness/bizType, or built
// pages silently lose canonical + the specific schema.org @type (live-caught 2026-07-06).
const directus = readFileSync(new URL('./directus.ts', import.meta.url), 'utf8');
ok(directus.includes('siteBase: ctx.siteBase') && directus.includes('bizType: ctx.bizType') && directus.includes('bizFacts: ctx.bizFacts'),
  'directus adapter: renderPage carries siteBase + bizType + bizFacts');
const fin = readFileSync(new URL('./finalize.ts', import.meta.url), 'utf8');
ok(/siteBase: params\.slug \? `https:\/\/\$\{params\.slug\}\.naples\.agency` : undefined/.test(fin) && /bizType: params\.bizType/.test(fin) && fin.includes('bizFacts: extractBusinessFacts(') && fin.includes("jsonb_set(params, '{bizType}'") && fin.includes('bizTypeFor(r.brief)'),
  'finalize: BuildCtx carries siteBase + bizType + whole-site bizFacts from params');

// ---- BUILDER REGISTRY structural invariants (additive; do not weaken the one-CMS assertions) ----
// The builder registry extends the delivery substrate without touching params.cms or the CMS REGISTRY.
// Key invariants:
//   - resolveBuilder('directus') returns the directus builder (default path, byte-identical behaviour)
//   - resolveBuilder with an unknown id falls back to directus (safe)
//   - resolveBuilder('wordpress') returns a Builder with id 'wordpress' (wp path, flag-gated)
//   - BUILDER_IDS is a superset of ['directus'] — it grows, never shrinks below the original
//   - The wordpress builder module lives at cms/wordpress.ts, NOT at cms/usecase.ts or any banned path
const db = resolveBuilder('directus');
ok(db.id === 'directus' && typeof db.finalize === 'function', "builder: resolveBuilder('directus') returns directus builder");
const wb = resolveBuilder('wordpress');
ok(wb.id === 'wordpress' && typeof wb.finalize === 'function', "builder: resolveBuilder('wordpress') returns wordpress builder");
const ub = resolveBuilder(undefined as any);
ok(ub.id === 'directus', "builder: resolveBuilder(undefined) falls back to directus");
ok((BUILDER_IDS as string[]).includes('directus') && (BUILDER_IDS as string[]).includes('wordpress'),
  "builder: BUILDER_IDS includes directus and wordpress");
// The wordpress builder must NOT be in cms/usecase.ts (banned in server.ts check above is already proven).
// We additionally assert the wordpress module file exists at the expected path.
const wpBuilderSource = readFileSync(new URL('./wordpress.ts', import.meta.url), 'utf8');
ok(wpBuilderSource.includes("id: 'wordpress'") && wpBuilderSource.includes('RELAY_WP'),
  'wordpress builder: has id + RELAY_WP feature flag');
ok(!wpBuilderSource.includes("from '../server.ts'") && !wpBuilderSource.includes("'../server'"),
  'wordpress builder: does not import server.ts (avoids circular + banned pattern)');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS — one pipeline, one CMS, wordpress builder registered.');
if (fails) process.exit(1);

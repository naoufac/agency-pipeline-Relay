// Deterministic proof for the CMS selector. Run: npm run cms:check  (tsx src/cms/select-test.ts).
// Exit 0 = pass. This is the zero-trust check for the selector — never an agent's word.
import { selectCms, DEFAULT_CMS } from './select.ts';
import { CMS_NAMES, isCmsName, type CmsName } from './types.ts';
import { ARCHETYPES } from '../archetype.ts';

let fails = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); fails++; } };

// 1. Always returns a valid CMS name for any archetype/brief (incl. empty).
for (const a of ARCHETYPES)
  for (const brief of ['a bakery in lyon', 'a delivery app', 'a sneaker shop', 'a news magazine', ''])
    ok(isCmsName(selectCms(undefined, brief, a)), `valid cms for ${a}/"${brief}"`);

// 2. Deterministic: identical input → identical output (100 reps).
const det = selectCms(undefined, 'a sneaker shop', 'store');
for (let i = 0; i < 100; i++) ok(selectCms(undefined, 'a sneaker shop', 'store') === det, 'deterministic');

// 3. Explicit override honoured for the closed set; invalid names rejected and re-derived.
for (const n of CMS_NAMES) ok(selectCms(n, 'anything', 'site') === n, `explicit ${n} honoured`);
ok(isCmsName(selectCms('wordpress', 'x', 'site')) && selectCms('wordpress', 'x', 'site') !== ('wordpress' as any),
  'invalid explicit rejected + re-derived to a valid cms');

// 4. All 5 CMS are reachable across a deterministic brief sweep (no adapter starved).
const seen = new Set<CmsName>();
for (let i = 0; i < 500; i++) for (const a of ARCHETYPES) seen.add(selectCms(undefined, 'brief-' + i, a));
// blog route guarantees drupal; explicit guarantees the rest; sweep should already cover all 5.
ok(seen.size === 5, `all 5 reachable via sweep (got: ${[...seen].sort().join(',')})`);

// 5. Craft is NEVER a silent default for data archetypes (app/store) — only explicit/site-tail.
for (let i = 0; i < 500; i++) {
  ok(selectCms(undefined, 'brief-' + i, 'app') !== 'craft', 'craft not a silent app default');
  ok(selectCms(undefined, 'brief-' + i, 'store') !== 'craft', 'craft not a silent store default');
}

// 6. Fallback identity.
ok(DEFAULT_CMS === 'directus', 'default cms is directus');

if (fails) { console.error(`\n${fails} assertion(s) FAILED`); process.exit(1); }
console.log('cms selector: ALL PASS — determinism · explicit override · all-5-reachable · craft-never-silent-default');

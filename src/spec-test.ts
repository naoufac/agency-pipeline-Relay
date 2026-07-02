// src/spec-test.ts — the deterministic GATE for the build-spec contract (R1). `npm run spec:check`.
// Feeds malformed/edge specs through normalizeSpec and asserts the right repair/reject outcome.
// A gate that can't say NO isn't a gate — several cases assert REJECTION. Exits non-zero on any failure.
import { normalizeSpec } from './spec.ts';
import { copySlop, } from './verify.ts';
import { extractFirstJson, applyBrand, resolveBrand, navCtaFor, normalizeContent, normalizeDataModel, siteCopySlop, normalizeSite } from './spec.ts';
import { renderPage } from './render.ts';
import { scorePage } from './eval.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${name} ${extra}`); } };
const hero = (h = 'Welcome') => ({ type: 'hero', headline: h });

// 1) a clean valid spec passes untouched
{
  const r = normalizeSpec({ brand: { name: 'Acme', tokens: { bg: '#fff', primary: '#111' } }, sections: [hero(), { type: 'features', items: [{ title: 'A', body: 'b' }] }] });
  ok('valid spec → no errors', r.errors.length === 0);
  ok('valid spec → 2 sections', r.spec.sections.length === 2);
  ok('valid spec → brand kept', r.spec.brand.name === 'Acme');
}
// 2) CTA as an OBJECT → normalized to a string label (+ link lifted)
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [{ ...hero(), cta: { label: 'Get started', href: 'contact' } }, { type: 'cta', headline: 'Go', cta: { text: 'Buy' } }] });
  ok('cta object → string', typeof r.spec.sections[0].cta === 'string' && r.spec.sections[0].cta === 'Get started');
  ok('cta object link → s.link', r.spec.sections[0].link === 'contact');
  ok('no [object Object] anywhere', !JSON.stringify(r.spec).includes('[object Object]'));
}
// 3) unknown section type → dropped
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [hero(), { type: 'carousel3000', foo: 1 }, { type: 'features', items: [{ title: 'A' }] }] });
  ok('unknown type dropped', !r.spec.sections.some((s: any) => s.type === 'carousel3000'));
  ok('unknown type recorded', r.repairs.some(x => /unknown section type/.test(x)));
}
// 4) features with no items → dropped
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [hero(), { type: 'features', items: [] }, { type: 'split', body: 'real' }] });
  ok('empty features dropped', !r.spec.sections.some((s: any) => s.type === 'features'));
}
// 5) hero missing headline + nothing else valid → REJECT
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [{ type: 'hero' }, { type: 'features', items: [] }] });
  ok('headless hero + empties → rejected', r.errors.length > 0);
}
// 6) hero not first → moved to top
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [{ type: 'features', items: [{ title: 'A' }] }, hero('H')] });
  ok('hero moved to top', r.spec.sections[0].type === 'hero');
  ok('move recorded', r.repairs.some(x => /moved hero/.test(x)));
}
// 7) collection with a bogus table but a real primaryTable → remapped
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [hero(), { type: 'collection', table: 'nonsense' }] }, { tables: ['products', 'categories'], primaryTable: 'products' });
  const col = r.spec.sections.find((s: any) => s.type === 'collection');
  ok('collection remapped to primary', col && col.table === 'products');
}
// 8) collection with no resolvable table (plain site, no tables) → dropped
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [hero(), { type: 'collection', table: 'whatever' }, { type: 'features', items: [{ title: 'A' }] }] }, {});
  ok('unresolvable collection dropped', !r.spec.sections.some((s: any) => s.type === 'collection'));
}
// 9) primaryTable collection injected on a catalog page
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [hero(), { type: 'features', items: [{ title: 'A' }] }] }, { slug: 'shop', tables: ['products'], primaryTable: 'products' });
  ok('collection injected on catalog page', r.spec.sections.some((s: any) => s.type === 'collection' && s.table === 'products'));
  ok('injected after hero (hero stays first)', r.spec.sections[0].type === 'hero');
}
// 10) non-object / null spec → REJECT (not a crash)
{
  ok('null → rejected', normalizeSpec(null).errors.length > 0);
  ok('array → rejected', normalizeSpec([1, 2] as any).errors.length > 0);
  ok('string → rejected', normalizeSpec('nope' as any).errors.length > 0);
}
// 11) brand missing entirely → defaulted, tokens become an object
{
  const r = normalizeSpec({ sections: [hero(), { type: 'split', title: 'T' }] });
  ok('brand.name defaulted', r.spec.brand.name === 'Studio');
  ok('brand.tokens is object', r.spec.brand.tokens && typeof r.spec.brand.tokens === 'object');
}
// 12) only ONE valid section after repair → REJECT
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [hero(), { type: 'gallery', images: [] }] });
  ok('single valid section → rejected', r.errors.some(e => /need >= 2/.test(e)));
}
// 13) form pointing at a non-existent table → falls back to contact bucket (table dropped, section kept)
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [hero(), { type: 'form', table: 'ghost', title: 'Contact' }] }, { tables: ['products'], forms: { products: [] } });
  const f = r.spec.sections.find((s: any) => s.type === 'form');
  ok('form kept', !!f);
  ok('bogus form table dropped', f && f.table === undefined);
}

// ---- robust JSON extractor: string-aware (braces inside strings must NOT desync) ----
ok('json: clean object', JSON.stringify(extractFirstJson('{"a":1,"b":[1,2]}')) === '{"a":1,"b":[1,2]}');
ok('json: braces INSIDE a string value', (extractFirstJson('{"copy":"use {curly} and } here","ok":true}') || {}).ok === true);
ok('json: escaped quote in string', (extractFirstJson('{"q":"a \\" brace } inside","n":2}') || {}).n === 2);
ok('json: strips ``` fences', (extractFirstJson('```json\n{"x":5}\n```') || {}).x === 5);
ok('json: leading prose then object', (extractFirstJson('Here you go: {"y":7} done') || {}).y === 7);
ok('json: repairs invalid \\\' escape (LLM defect)', (extractFirstJson('{"t":"What\\\'s the issue?","n":3}') || {}).n === 3);
ok('json: repairs other invalid escapes (\\x)', (extractFirstJson('{"t":"a\\xb c\\zd","n":9}') || {}).n === 9);
ok('json: keeps VALID escapes (\\n \\" \\\\)', (extractFirstJson('{"t":"line1\\nline2 \\"q\\" path\\\\x","n":5}') || {}).t === 'line1\nline2 "q" path\\x');
ok('json: repairs trailing comma', (extractFirstJson('{"a":1,"b":[1,2,],}') || {}).a === 1);
ok('json: truncated/unbalanced → null', extractFirstJson('{"a":1,"b":{"c":2') === null);
ok('json: empty/no-brace → null', extractFirstJson('no json here') === null && extractFirstJson('') === null);

// ---- copy-specificity floor (R3): copySlop must catch template slop AND pass real copy ----
// rejects (each returns a reason):
ok('slop: lorem ipsum', !!copySlop('<h1>Lorem ipsum dolor sit amet</h1>'));
ok('slop: your tagline here', !!copySlop('<p>Your tagline here</p>'));
ok('slop: headline goes here', !!copySlop('<h2>Headline goes here</h2>'));
ok('slop: insert your text here', !!copySlop('<p>Insert your text here</p>'));
ok('slop: mustache token', !!copySlop('<h1>Welcome to {{company}}</h1>'));
ok('slop: TODO', !!copySlop('<p>TODO: write the about copy</p>'));
ok('slop: example.com email', !!copySlop('<a href="mailto:hi@example.com">hi@example.com</a>'));
ok('slop ignores CSS/JS', copySlop('<style>.x{content:"lorem ipsum"}</style><script>var t="tbd todo"</script><h1>Stone-fired pizza in Porto</h1>') === null);
// PASSES — real, specific copy must NEVER false-fail (false positives cause build loops):
ok('real copy passes #1', copySlop('<h1>Lisboa Roasters — single-origin coffee roasted in Alfama</h1><p>Order online, pick up in store.</p>') === null);
ok('real copy passes #2', copySlop('<h2>Book a table</h2><p>Open Tue–Sun, 6pm till late. For example, our tasting menu changes weekly.</p>') === null);
ok('real copy passes #3', copySlop('<p>Find the full description below. Nothing here yet — be the first to add one.</p>') === null);

// ---- R2 eval scorer: objective signals, no model opinion ----
{
  const goodHtml = '<h1>Lisboa Roasters</h1><section>12 single-origin beans from €9, roasted in Alfama. Open Tue–Sun, 8am.</section><section>Pickup or delivery.</section>';
  const gs = scorePage(goodHtml, { sections: [{ type: 'hero' }, { type: 'features' }, { type: 'split' }] });
  ok('scorer: specific page passes gate', gs.gatePass === true);
  ok('scorer: counts section variety', gs.distinctTypes === 3);
  ok('scorer: counts concrete signals', gs.specific >= 2);
  ok('scorer: no generic filler', gs.genericHits === 0);
  const genHtml = '<h1>Solutions</h1><section>We deliver world-class, cutting-edge solutions to empower your business and elevate your brand.</section><section>x</section>';
  const gen = scorePage(genHtml, { sections: [{ type: 'hero' }, { type: 'features' }] });
  ok('scorer: flags generic filler', gen.genericHits >= 3);
  ok('scorer: filler scores below specific', gen.specificity < gs.specificity);
}

// ---- BRAND LOCK: every page of a project must render the SAME logo, palette + nav (the recurring bug) ----
{
  const canon = { name: 'Lisboa Roasters', cta: 'Order online', tokens: { bg: '#0b0e14', primary: '#e0a96d' } };
  const pages = [{ slug: 'index', title: 'Home' }, { slug: 'about', title: 'Our story' }, { slug: 'contact', title: 'Contact' }];
  // two DIFFERENT page specs that each invented their OWN (wrong) brand + colours:
  const sA: any = { brand: { name: 'WRONG ALPHA', tokens: { bg: '#ffffff', primary: '#ff0000' } }, sections: [{ type: 'hero', headline: 'A' }, { type: 'features', items: [{ title: 't', body: 'b' }] }] };
  const sB: any = { brand: { name: 'WRONG BETA', tokens: { bg: '#123456', primary: '#00ff00' } }, sections: [{ type: 'hero', headline: 'B' }, { type: 'cta', headline: 'c' }] };
  applyBrand(sA, canon); applyBrand(sB, canon);
  const hA = renderPage(sA, { pages, slug: 'index', title: 'Home' });
  const hB = renderPage(sB, { pages, slug: 'about', title: 'Our story' });
  const logo = (h: string) => (h.match(/<a class="nav-brand"[^>]*>([^<]*)<\/a>/) || [])[1];
  const palette = (h: string) => `${(h.match(/--bg:(#[0-9a-fA-F]+)/) || [])[1]}|${(h.match(/--primary:(#[0-9a-fA-F]+)/) || [])[1]}`;
  const navTargets = (h: string) => (h.match(/href="(?:index|about|contact)\.html"/g) || []).sort().join(',');
  ok('brand lock: logo identical on every page', logo(hA) === logo(hB) && logo(hA) === 'Lisboa Roasters');
  ok('brand lock: per-page invented brand discarded', logo(hA) !== 'WRONG ALPHA' && logo(hB) !== 'WRONG BETA');
  ok('brand lock: palette identical on every page', palette(hA) === palette(hB) && /#0b0e14/i.test(palette(hA)));
  ok('brand lock: nav links identical on every page', navTargets(hA) === navTargets(hB) && navTargets(hA).length > 0);
  ok('brand lock: footer brand identical', (hA.match(/©\s*([^<]*)</) || [])[1] === (hB.match(/©\s*([^<]*)</) || [])[1]);
}

// ---- FORCED identity: a page can NEVER keep its own colours, and the canon is ALWAYS complete ----
{
  // resolveBrand always yields a COMPLETE palette (bg + primary), whatever the branding output looks like:
  const full = resolveBrand('{"name":"Rille","palette":{"primary":"#1c1917","accent":"#caa15a","bg":"#f7f5f2","text":"#111"}}');
  ok('resolveBrand: name parsed', full.name === 'Rille');
  ok('resolveBrand: bg+primary parsed', full.tokens.bg === '#f7f5f2' && full.tokens.primary === '#1c1917');
  // branding gives bg+text+accent but NO primary (the realistic drift hole) → primary still filled deterministically:
  const noPrim = resolveBrand('{"name":"Brief","palette":{"bg":"#0f1419","accent":"#3b82f6","text":"#e6edf3"}}');
  ok('resolveBrand: missing primary → filled (never empty)', /^#[0-9a-f]{3,8}$/i.test(noPrim.tokens.primary) && noPrim.tokens.bg === '#0f1419');
  // total garbage / no JSON → still a complete, usable palette + default name (never throws, never empty):
  const garbage = resolveBrand('the branding agent wrote prose, no json at all');
  ok('resolveBrand: garbage → complete default palette', !!garbage.tokens.bg && !!garbage.tokens.primary && garbage.name === 'Studio');

  // applyBrand FORCES the palette even when the page invented its own non-empty tokens:
  const pageWithOwnColours: any = { brand: { name: 'WRONG', tokens: { bg: '#000000', primary: '#ff0000' } }, sections: [hero()] };
  applyBrand(pageWithOwnColours, full);
  ok('applyBrand: page tokens overwritten by canon', pageWithOwnColours.brand.tokens.bg === '#f7f5f2' && pageWithOwnColours.brand.tokens.primary === '#1c1917');
  ok('applyBrand: page name overwritten by canon', pageWithOwnColours.brand.name === 'Rille');
  // even if a canon somehow had EMPTY tokens, the page's own colours must NOT survive (falls back to default):
  const pageEmptyCanon: any = { brand: { name: 'X', tokens: { bg: '#abcdef', primary: '#fedcba' } }, sections: [hero()] };
  applyBrand(pageEmptyCanon, { name: 'Y', cta: null, tokens: {} as any });
  ok('applyBrand: empty canon never leaks page tokens', pageEmptyCanon.brand.tokens.bg !== '#abcdef' && pageEmptyCanon.brand.tokens.primary !== '#fedcba');

  // NAV BUTTON is one per site too: deterministic by archetype, and applyBrand forces it (no per-page label)
  ok('navCtaFor: store/app/site deterministic', navCtaFor('store') === 'Shop now' && navCtaFor('app') === 'Get started' && navCtaFor('site') === 'Get in touch' && navCtaFor(undefined) === 'Get in touch');
  ok('resolveBrand: nav cta from archetype', resolveBrand('{"name":"N","palette":{"bg":"#fff","primary":"#111"}}', undefined, 'store').cta === 'Shop now');
  const pageOwnCta: any = { brand: { name: 'Z', cta: 'Enter the World', ctaLink: 'gallery', tokens: { bg: '#fff', primary: '#111' } }, sections: [hero()] };
  applyBrand(pageOwnCta, { name: 'Z', cta: 'Get in touch', tokens: { bg: '#fff', primary: '#111' } });
  ok('applyBrand: per-page nav button label overwritten', pageOwnCta.brand.cta === 'Get in touch');
  ok('applyBrand: per-page ctaLink stripped (target resolved deterministically)', pageOwnCta.brand.ctaLink === undefined);
}

// ---- CONTENT normaliser (R3): one role serves two shapes; recover one-object-or-merge, reject the unfixable ----
// 1) a clean single JSON object passes untouched (no repairs)
{
  const r = normalizeContent('{"sections":[{"id":"hero","title":"Home"},{"id":"about","title":"About"}]}');
  ok('normContent: valid single object → ok', r.ok === true && Array.isArray(r.spec.sections) && r.spec.sections.length === 2);
  ok('normContent: valid single object → no repairs', r.ok === true && r.repairs.length === 0);
}
// 2) two concatenated blocks (the "never two blocks" violation) where the string-aware pass can't take the
//    first as-is → flat second pass merges the sitemap + copy objects into one
{
  const r = normalizeContent('{"sections": }{"id":"hero","title":"Home"}{"hero":"Welcome to Lume"}');
  ok('normContent: concatenated blocks → merged ok', r.ok === true && r.spec.title === 'Home' && r.spec.hero === 'Welcome to Lume');
  ok('normContent: merge recorded as a repair', r.ok === true && r.repairs.some(x => /merged/.test(x)));
}
// 3) one valid object followed by an invalid one → first object kept (first pass wins, untouched)
{
  const r = normalizeContent('{"sections":[{"id":"hero"}]}{not valid json');
  ok('normContent: valid first + invalid second → first kept', r.ok === true && Array.isArray(r.spec.sections) && r.repairs.length === 0);
}
// 4) empty string → rejected (feeds retry-with-feedback, never a silent pass)
{
  const r = normalizeContent('');
  ok('normContent: empty → rejected', r.ok === false && r.errors.length > 0);
}
// 5) a truncated object with no closing brace → rejected
{
  const r = normalizeContent('{"sections":[{"id":"hero","title":"Home"');
  ok('normContent: truncated/no-closing → rejected', r.ok === false && r.errors.length > 0);
}

// ---- DATABASE data-model normaliser (R7): recover the model, clamp INT4 overflow, reject the unfixable ----
// 1) a clean single object with entities[] → passes untouched (fenced, exactly like a real database reply)
{
  const r = normalizeDataModel('```json\n{"entities":[{"name":"products","fields":[{"name":"title","type":"text","required":true}],"seed":[{"title":"Widget","stock":5}]}]}\n```');
  ok('normDataModel: valid entities → ok', r.ok === true && Array.isArray(r.model.entities) && r.model.entities[0].name === 'products');
  ok('normDataModel: valid → no repairs', r.ok === true && r.repairs.length === 0);
}
// 2) two concatenated objects (the model block + a trailing stray) → first complete object with entities extracted
{
  const r = normalizeDataModel('{"entities":[{"name":"roles","seed":[{"name":"Navigator"}]}]}\n{"_note":"that was the model"}');
  ok('normDataModel: concatenated → entities extracted', r.ok === true && r.model.entities[0].name === 'roles');
}
// 3) model emitted `tables:[...]` instead of `entities:[...]` → coerced
{
  const r = normalizeDataModel('{"tables":[{"name":"items","fields":[{"name":"label","type":"text"}],"seed":[{"label":"A"}]}]}');
  ok('normDataModel: tables → entities coerced', r.ok === true && Array.isArray(r.model.entities) && r.model.entities[0].name === 'items');
  ok('normDataModel: coercion recorded', r.ok === true && r.repairs.some(x => /coerced/.test(x)));
}
// 4) truncated JSON (ran out of tokens mid-seed, the real "no tables" cause) → rejected into retry-with-feedback
{
  const r = normalizeDataModel('{"entities":[{"name":"characters","seed":[{"name":"Blackbeard","bounty":3989000000,"description":"The man who');
  ok('normDataModel: truncated → rejected', r.ok === false && r.errors.length > 0);
}
// 5) a seed integer over PG INT4 (a real One Piece bounty) → clamped into range + repair logged
{
  const r = normalizeDataModel('{"entities":[{"name":"characters","seed":[{"name":"Kaido","bounty":4611100000}]}]}');
  ok('normDataModel: int4 overflow clamped', r.ok === true && r.model.entities[0].seed[0].bounty <= 2147483647);
  ok('normDataModel: clamp recorded as repair', r.ok === true && r.repairs.some(x => /clamp/i.test(x)));
}

// ---- COPY GATE moved to COMPOSE: slop rejected at the retryable stage; {{brand}} token is NOT slop ----
{
  ok('siteCopySlop: lorem caught', !!siteCopySlop([{ sections: [{ type: 'hero', headline: 'Hi' }, { type: 'features', items: [{ title: 'A', body: 'Lorem ipsum dolor sit amet' }] }] }]));
  ok('siteCopySlop: [Placeholder] caught', !!siteCopySlop([{ sections: [{ type: 'hero', headline: 'Welcome to [Studio Name]' }] }]));
  ok('siteCopySlop: {{brand}} token is NOT slop', siteCopySlop([{ sections: [{ type: 'hero', headline: 'Welcome to {{brand}}', lead: '{{brand}} ships fast' }] }]) === null);
  ok('siteCopySlop: real copy passes', siteCopySlop([{ sections: [{ type: 'hero', headline: 'Stone-fired pizza in Porto', lead: 'Open Tue–Sun, 6pm till late' }] }]) === null);

  const pages = [{ slug: 'index', title: 'Home' }, { slug: 'about', title: 'About' }];
  const slopModel = { pages: [
    { slug: 'index', title: 'Home', sections: [{ type: 'hero', headline: 'Real specific headline for the shop' }, { type: 'features', items: [{ title: 'A', body: 'real body copy about the shop' }] }] },
    { slug: 'about', title: 'About', sections: [{ type: 'hero', headline: 'Our story' }, { type: 'cta', headline: 'Lorem ipsum dolor sit amet' }] },
  ] };
  ok('normalizeSite: REJECTS composed slop (compose will retry)', normalizeSite(slopModel, pages, {}).errors.some(e => /slop|lorem/i.test(e)));
  const cleanModel = { pages: [
    { slug: 'index', title: 'Home', sections: [{ type: 'hero', headline: 'Welcome to {{brand}}' }, { type: 'features', items: [{ title: 'Fast', body: 'We deliver across the city in under an hour' }] }] },
    { slug: 'about', title: 'About', sections: [{ type: 'hero', headline: 'About {{brand}}' }, { type: 'cta', headline: 'Join {{brand}} today' }] },
  ] };
  ok('normalizeSite: clean {{brand}} model has NO slop error', !normalizeSite(cleanModel, pages, {}).errors.some(e => /slop/i.test(e)));
}


// ---- M1 · LANDING (PLAN.md): shape classifier + conversion components ----
{
  const { classifyShape, shapeFor, CONVERSION_SECTIONS } = await import('./landing.ts');
  ok('landing: "landing page for a fitness coach" → landing', classifyShape('a landing page for a fitness coach in Miami') === 'landing');
  ok('landing: "high-converting sales page" → landing', classifyShape('high-converting sales page for my course') === 'landing');
  ok('landing: "waitlist for our app launch" → landing', classifyShape('a waitlist page for our app launch') === 'landing');
  ok('landing: plain brief → multi', classifyShape('a cozy neighborhood bookshop with reading events') === 'multi');
  ok('landing: restaurant brief → multi', classifyShape('a website for an italian restaurant') === 'multi');
  ok('landing: LLM-named "landing" honoured', shapeFor('landing', 'anything') === 'landing');
  ok('landing: LLM garbage → classified from brief', shapeFor('brochure3000', 'a landing page for x') === 'landing');
  ok('landing: conversion set covers offer+logos', CONVERSION_SECTIONS.has('offer') && CONVERSION_SECTIONS.has('logos'));
}
// logos + offer normalize: valid kept, hollow dropped
{
  const r = normalizeSpec({ brand: { name: 'X' }, sections: [hero(), { type: 'logos', title: 'Trusted by', items: ['Acme', 'Nordia', 'Kite'] }, { type: 'offer', title: 'The 30-day program', bullets: ['12 sessions', 'meal plan'], cta: 'Start today', guarantee: '30-day money-back' }] });
  ok('logos+offer: valid kept', r.spec.sections.length === 3 && r.errors.length === 0);
  const d = normalizeSpec({ brand: { name: 'X' }, sections: [hero(), { type: 'logos', items: ['one'] }, { type: 'offer', bullets: ['x'] }, { type: 'cta', headline: 'Go' }] });
  ok('logos <2 names dropped', !d.spec.sections.some((s: any) => s.type === 'logos'));
  ok('offer without title dropped', !d.spec.sections.some((s: any) => s.type === 'offer'));
}
// logos + offer render clean through the deterministic renderer
{
  const spec = { brand: { name: 'FitMia', tokens: { bg: '#ffffff', primary: '#0a5c36' } }, sections: [
    { type: 'hero', headline: 'Still skipping workouts?', lead: 'Get a coach who keeps you on track', cta: 'Start today' },
    { type: 'logos', title: 'As seen in', items: ['Miami Herald', 'FitWeekly', 'WLRN'] },
    { type: 'offer', eyebrow: 'The offer', title: 'The 30-day kickstart', bullets: ['12 coached sessions', 'Custom meal plan'], price: '$299', period: 'one-time', cta: 'Start today', guarantee: '30-day money-back guarantee' },
    { type: 'cta', headline: 'Ready?', cta: 'Start today' },
  ] };
  const h = renderPage(spec, { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home' });
  ok('landing render: logos names present', h.includes('Miami Herald') && h.includes('As seen in'));
  ok('landing render: offer core present', h.includes('The 30-day kickstart') && h.includes('30-day money-back guarantee') && h.includes('$299'));
  ok('landing render: no [object Object]', !h.includes('[object Object]'));
  ok('landing render: offer CTA is a real link', /<a class="btn" href="[^"#]+">Start today<\/a>/.test(h));
}


// ---- M2 · FORMS THAT MATCH THE DATABASE (PLAN.md): typed fields + relation dropdowns ----
{
  const forms = { reservations: [
    { name: 'guest_name', type: 'text', nullable: false },
    { name: 'party_size', type: 'integer', nullable: false },
    { name: 'total', type: 'numeric', nullable: true },
    { name: 'date', type: 'date', nullable: false },
    { name: 'table_type_id', type: 'integer', nullable: false, ref: 'table_types', display: 'name' },
  ] };
  const spec = { brand: { name: 'Trattoria', tokens: { bg: '#ffffff', primary: '#7a1f1f' } }, sections: [
    { type: 'hero', headline: 'Book a table tonight' },
    { type: 'form', title: 'Reserve', table: 'reservations', cta: 'Reserve' },
  ] };
  const h = renderPage(spec, { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', forms });
  ok('M2: typed fields generated from schema', h.includes('name="guest_name"') && h.includes('name="party_size"') && h.includes('name="date"'));
  ok('M2: FK renders as a relation dropdown', /<select name="table_type_id" data-ref="table_types" data-display="name" required>/.test(h));
  ok('M2: FK label humanized (no _id)', h.includes('Table Type') && !h.includes('Table Type Id'));
  ok('M2: required from NOT NULL', /<input name="guest_name"[^>]*required/.test(h) && /<input name="party_size"[^>]*required/.test(h));
  ok('M2: money gets decimal step', /<input name="total"[^>]*step="0.01"/.test(h));
  ok('M2: int gets whole step', /<input name="party_size"[^>]*step="1"/.test(h));
  ok('M2: dropdown ships with placeholder only (options load live)', /<select name="table_type_id"[^>]*><option value="">Choose…<\/option><\/select>/.test(h));
  ok('M2: client fills selects from the data API', h.includes("select[data-ref]"));
  // a table the schema does NOT know → falls back to the contact form (never a broken typed form)
  const h2 = renderPage({ brand: { name: 'X', tokens: {} }, sections: [ { type: 'hero', headline: 'Hi' }, { type: 'form', title: 'Contact', table: 'ghosts' } ] }, { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', forms });
  ok('M2: unknown table → contact fallback (no data-table)', !h2.includes('data-table="ghosts"') && h2.includes('name="message"'));
}

console.log(`\nspec:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// src/spec-test.ts — the deterministic GATE for the build-spec contract (R1). `npm run spec:check`.
// Feeds malformed/edge specs through normalizeSpec and asserts the right repair/reject outcome.
// A gate that can't say NO isn't a gate — several cases assert REJECTION. Exits non-zero on any failure.
import { normalizeSpec } from './spec.ts';
import { copySlop, } from './verify.ts';
import { extractFirstJson } from './spec.ts';
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

console.log(`\nspec:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

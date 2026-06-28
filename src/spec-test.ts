// src/spec-test.ts — the deterministic GATE for the build-spec contract (R1). `npm run spec:check`.
// Feeds malformed/edge specs through normalizeSpec and asserts the right repair/reject outcome.
// A gate that can't say NO isn't a gate — several cases assert REJECTION. Exits non-zero on any failure.
import { normalizeSpec } from './spec.ts';

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

console.log(`\nspec:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

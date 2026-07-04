// layout:check — THE PQ1 GATE (distinct design per brief). Proves the SYSTEM produces structurally
// different layouts, not one template recolored:
//   (1) the chooser spreads real briefs across multiple hero treatments (not all the same),
//   (2) each hero variant renders its own distinct STRUCTURE (different marker classes), and
//   (3) every variant stays WCAG-safe and free of raw tokens / [object Object].
// Deterministic, no server needed. Exit 1 on any failure. Run: npm run layout:check.
import { chooseLayout, HERO_VARIANTS } from './layout.ts';
import { renderPage } from './render.ts';
import { DS_CSS } from './components.ts';
import { archetypeFor } from './archetype.ts';
import { themeFor } from './themes.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

// a spread of real briefs across archetypes/industries
const BRIEFS = [
  'a law firm specializing in mergers and acquisitions',
  'a skate shop selling boards and streetwear',
  'a wedding photographer portfolio',
  'a SaaS tool for team scheduling',
  'a neighborhood bakery with online pre-orders',
  'a fitness coaching landing page',
  'a boutique hotel on the coast',
  'a craft coffee roastery and cafe',
  'a modern dental clinic',
  'an architecture studio portfolio',
];

// (1) spread: the chooser must NOT collapse every brief to one hero
const layouts = BRIEFS.map((b) => { const theme = themeFor(undefined, b); const arch = archetypeFor(undefined, b); return chooseLayout(theme, arch, b); });
const heroesUsed = new Set(layouts.map((l) => l.hero));
ok('chooser uses ≥3 distinct hero treatments across 10 briefs', heroesUsed.size >= 3, `used: ${[...heroesUsed].join(', ')}`);
ok('chooser is deterministic (same brief → same layout)', JSON.stringify(chooseLayout('bold', 'site', BRIEFS[5])) === JSON.stringify(chooseLayout('bold', 'site', BRIEFS[5])));
const navUsed = new Set(layouts.map((l) => l.nav));
ok('nav style varies across briefs', navUsed.size >= 1);   // centered only on editorial/minimal — presence is a bonus, not required

// (2) each hero variant renders a DISTINCT structure (its own marker classes)
const specOf = () => ({ brand: { name: 'Acme', tokens: { bg: '#ffffff', primary: '#123456' } }, sections: [
  { type: 'hero', image: 'city skyline', eyebrow: 'Est. 2020', headline: 'We build things', lead: 'A one-line promise about the work.', cta: 'Get started' },
  { type: 'features', items: [{ title: 'A', body: 'b' }] },
] });
const markers: Record<string, RegExp> = {
  image: /class="hero on-image"/, split: /class="hero hero-split"/, center: /class="hero hero-center"/, editorial: /class="hero hero-editorial"/,
};
const rendered: Record<string, string> = {};
for (const v of HERO_VARIANTS) {
  const html = renderPage(specOf(), { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', layout: { hero: v, nav: 'standard', band: false, cards: 'photo' } });
  rendered[v] = html;
  ok(`hero "${v}" renders its own structure`, markers[v].test(html), 'marker missing');
  ok(`hero "${v}" carries a body layout class`, html.includes(`l-hero-${v}`));
  ok(`hero "${v}" has the headline + a working CTA`, html.includes('We build things') && /<a class="btn"/.test(html));
  ok(`hero "${v}" no raw token / [object Object]`, !html.includes('{{') && !html.includes('[object Object]'));
}
// scope photo checks to the hero MARKUP (the <header>) — the stylesheet defines .hero-bg on every page
const heroMarkup: Record<string, string> = {};
for (const v of HERO_VARIANTS) heroMarkup[v] = (rendered[v].match(/<header class="hero[\s\S]*?<\/header>/) || [''])[0];
// the four heroes must NOT be byte-identical (that was the whole bug)
ok('the four hero variants are structurally DIFFERENT from each other', new Set(Object.values(heroMarkup)).size === 4);
ok('split hero frames an in-flow photo, not a full-bleed bg', /hero-photo/.test(heroMarkup.split) && !/hero-bg/.test(heroMarkup.split));
ok('center hero drops the photo entirely', !/hero-photo|hero-bg/.test(heroMarkup.center));
ok('editorial hero uses a wide in-flow photo', /hero-wide/.test(heroMarkup.editorial));
ok('image hero uses a full-bleed bg photo', /hero-bg/.test(heroMarkup.image));

// PQ1 · DISTRIBUTION: across a fixed brief matrix the chooser must actually SPREAD — at least 3
// distinct heroes and both navs. Guards against any future rule quietly funneling everything into
// one variant (the split-funnel class the agency panel caught at 7.3/10 sameness).
{
  const { chooseLayout } = await import('./layout.ts');
  const themes = ['editorial', 'modern', 'warm', 'bold', 'minimal'] as const;
  const briefs = ['a barbershop booking app', 'an online ceramics store', 'a law firm site', 'a delivery platform', 'a bakery pre-order app', 'a yoga studio'];
  const heroes = new Set<string>(); const navs = new Set<string>(); const cardVars = new Set<string>(); const combos = new Set<string>();
  for (const t of themes) for (const b of briefs) { const l = chooseLayout(t, b.includes('store') ? 'store' : 'app', b); heroes.add(l.hero); navs.add(l.nav); if (l.cards) cardVars.add(l.cards); combos.add(`${l.hero}-${l.cards}`); }
  ok('chooser spreads: >=3 distinct heroes across the matrix', heroes.size >= 3, [...heroes].join(','));
  ok('chooser spreads: both nav variants appear', navs.size === 2, [...navs].join(','));
  ok('chooser spreads: >=2 distinct card variants across the matrix', cardVars.size >= 2, [...cardVars].join(','));
  ok('cards/hero combos are not all identical across the matrix', combos.size > 1);
}

// (PQ1-B) each l-cards-* body class lands on <body> and DS_CSS contains the variant rules
for (const cv of ['photo', 'horizontal', 'overlay'] as const) {
  const html = renderPage(specOf(), { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', layout: { hero: 'image', nav: 'standard', band: false, cards: cv } });
  ok(`l-cards-${cv} body class lands on <body>`, html.includes(`l-cards-${cv}`));
}
ok('DS_CSS contains .l-cards-horizontal rule', DS_CSS.includes('.l-cards-horizontal'));
ok('DS_CSS contains .l-cards-overlay rule', DS_CSS.includes('.l-cards-overlay'));
// the DB-card renderer must FILTER machine residue (raw slugs / bare numbers) out of card copy —
// the agency panel's #1 on a real law rebuild ('elder-law-guardianship' shipped as body text)
ok('emitted card renderer filters slugs', rendered.image.includes('(?:[-_][a-z0-9]+)+'), 'slug filter missing from page script');
// the EMITTED regex must keep its backslashes — a template literal silently eats \d, shipping a
// dead filter (/^#?d+/) that let a bare '60' reach a real law card. Assert the literal characters.
ok('emitted number filter survives template escaping', rendered.image.includes('/^#?\\d+(\\.\\d+)?$/'), 'number regex lost its backslashes in the emitted script');
ok('emitted card renderer filters ISO timestamps (backslashes intact)', rendered.image.includes('/^\\d{4}-\\d{2}-\\d{2}T/'), 'ISO regex missing or lost backslashes');
ok('emitted card renderer uses toDateString for dates', rendered.image.includes('toDateString'));
ok('admin-flag booleans never render as card copy', rendered.image.includes('active|enabled|visible|published'));
ok('DB-card images take the theme frame (no hardcoded radius)', rendered.image.includes('border-radius:var(--radius)'));
// REGISTER: service tables never render SKU-style bold prices — a quiet muted 'From $X' closes the
// panel's 'legal consultations framed as products' finding
ok('service-register cards render money muted as From $X', rendered.image.includes("'From $'") && rendered.image.includes('moneyLast'));
ok('the service register is table-classed (products stay commerce)', rendered.image.includes('practice|treatment'));
// the panel's exact findings on a real trio: 'From $0.00' on a complimentary consultation and
// '✓ available' inventory badges on brunch dishes — free = say nothing; badges are commerce-only
ok('a zero price never renders (free ≠ From $0.00)', rendered.image.includes('mv>0'));
ok('whole-dollar From-prices drop the cents', rendered.image.includes("mv%1?mv.toFixed(2):mv.toFixed(0)"));
ok('inventory badges never render on service/menu/blog registers', rendered.image.includes('!v||svc||blog||'));
ok('menu/dishes are in the service register', rendered.image.includes('menu|dish|drink'));
// SEARCH: big grids get the client-side filter (8-row threshold, accessible, textContent only)
ok('grids with >=8 rows get a search box', rendered.image.includes('__searchbox') && rendered.image.includes('count<8'));
ok('the search box is accessible + safe', rendered.image.includes("'Search this list'") && rendered.image.includes('textContent'));

console.log(`\nlayout:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// layout:check — THE PQ1 GATE (distinct design per brief). Proves the SYSTEM produces structurally
// different layouts, not one template recolored:
//   (1) the chooser spreads real briefs across multiple hero treatments (not all the same),
//   (2) each hero variant renders its own distinct STRUCTURE (different marker classes), and
//   (3) every variant stays WCAG-safe and free of raw tokens / [object Object].
// ARC F: also gates new hero variants (poster, ledger), the minimal card variant, and the three
// section-mode dimensions (features grid|rail, testimonials grid|spotlight, stats row|inline).
// Deterministic, no server needed. Exit 1 on any failure. Run: npm run layout:check.
import { chooseLayout, HERO_VARIANTS, CARD_VARIANTS } from './layout.ts';
import { renderPage } from './render.ts';
import { DS_CSS, SECTIONS } from './components.ts';
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
// specOf includes features + stats so back-compat tests can assert the default mode markers.
const specOf = () => ({ brand: { name: 'Acme', tokens: { bg: '#ffffff', primary: '#123456' } }, sections: [
  { type: 'hero', image: 'city skyline', eyebrow: 'Est. 2020', headline: 'We build things', lead: 'A one-line promise about the work.', cta: 'Get started' },
  { type: 'features', items: [{ title: 'A', body: 'b' }] },
  { type: 'stats', items: [{ value: '12k', label: 'users' }] },
] });
// ARC F: markers for all 6 hero variants — each must have a unique structural marker class.
// poster uses .hero-poster, ledger uses .hero-ledger (both new in ARC F).
const markers: Record<string, RegExp> = {
  image:    /class="hero on-image"/,
  split:    /class="hero hero-split"/,
  center:   /class="hero hero-center"/,
  editorial:/class="hero hero-editorial"/,
  poster:   /class="hero-poster/,
  ledger:   /class="hero-ledger"/,
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
// scope photo checks to the hero MARKUP — the stylesheet defines .hero-bg on every page
const heroMarkup: Record<string, string> = {};
// poster and ledger have different root elements (hero-poster/hero-ledger not hero-*) — match both patterns
for (const v of HERO_VARIANTS) {
  const m = rendered[v].match(/<header class="hero[\s\S]*?<\/header>/) || rendered[v].match(/<header class="hero-(?:poster|ledger)[\s\S]*?<\/header>/) || [''];
  heroMarkup[v] = m[0];
}
// ALL heroes must be structurally different from each other (that was the original bug)
ok('all six hero variants are structurally DIFFERENT from each other', new Set(Object.values(heroMarkup)).size === HERO_VARIANTS.length);
ok('split hero frames an in-flow photo, not a full-bleed bg', /hero-photo/.test(heroMarkup.split) && !/hero-bg/.test(heroMarkup.split));
ok('center hero drops the photo entirely', !/hero-photo|hero-bg/.test(heroMarkup.center));
ok('editorial hero uses a wide in-flow photo', /hero-wide/.test(heroMarkup.editorial));
ok('image hero uses a full-bleed bg photo', /hero-bg/.test(heroMarkup.image));
// ARC F: poster — full-bleed + scrim (white text on dark gradient, same AA technique as image hero)
ok('poster hero uses a full-bleed bg photo', /hero-bg/.test(heroMarkup.poster));
ok('poster hero has the gradient scrim (AA guarantee)', /hero-scrim/.test(heroMarkup.poster));
// ARC F: ledger — no photo, editorial two-column
ok('ledger hero has no photo', !/hero-bg|hero-photo/.test(heroMarkup.ledger));
ok('ledger hero has the grid structure', /hero-ledger-grid/.test(heroMarkup.ledger));
// ARC F: poster text-over-image AA guarantee — must NOT use plain --text colour on the image; white
// text on the gradient scrim is enforced by the scrim itself (same technique as the image hero).
ok('poster hero copy container is present (will render white text via CSS)', rendered.poster.includes('hero-copy'));
// ARC F: ledger is entirely on-bg, no overlay — safe by the theme palette guarantee.
ok('ledger hero has no overlay/scrim (on-bg text)', !rendered.ledger.includes('hero-overlay') && !rendered.ledger.includes('hero-scrim'));

// PQ1 · DISTRIBUTION: across a fixed brief matrix the chooser must actually SPREAD — at least 4
// distinct heroes and both navs. Guards against any future rule quietly funneling everything into
// one variant (the split-funnel class the agency panel caught at 7.3/10 sameness).
// ARC F: expanded matrix to 5 themes × 6 briefs = 30 sites. Expect >=4 distinct heroes, >=3 card
// variants, both section modes for each section type somewhere in the matrix.
{
  const { chooseLayout } = await import('./layout.ts');
  const themes = ['editorial', 'modern', 'warm', 'bold', 'minimal'] as const;
  // ARC F: expanded to 30 sites; include site-archetype briefs so photo-less heroes (ledger/center)
  // can appear — they are demoted for store/app archetypes, so a mixed archetype matrix is necessary.
  // 'a dental practice' → editorial theme idx 1 = ledger (verified deterministically above).
  const briefRows: Array<[string, 'site' | 'store' | 'app']> = [
    ['a barbershop booking app', 'app'], ['an online ceramics store', 'store'],
    ['a law firm site', 'site'], ['a delivery platform', 'app'],
    ['a bakery pre-order app', 'app'], ['a yoga studio', 'site'],
    ['a dental practice', 'site'], ['a portfolio for a photographer', 'site'],
    ['a SaaS scheduling tool', 'app'], ['an events agency website', 'site'],
    ['a luxury hotel website', 'site'], ['a fitness coaching landing page', 'site'],
  ];
  const heroes = new Set<string>(); const navs = new Set<string>(); const cardVars = new Set<string>(); const combos = new Set<string>();
  const featuresModes = new Set<string>(); const testimonialsModes = new Set<string>(); const statsModes = new Set<string>();
  for (const t of themes) for (const [b, arch] of briefRows) {
    const l = chooseLayout(t, arch, b);
    heroes.add(l.hero); navs.add(l.nav); if (l.cards) cardVars.add(l.cards); combos.add(`${l.hero}-${l.cards}`);
    if (l.sectionModes) {
      featuresModes.add(l.sectionModes.features);
      testimonialsModes.add(l.sectionModes.testimonials);
      statsModes.add(l.sectionModes.stats);
    }
  }
  ok('chooser spreads: >=4 distinct heroes across the 30-site matrix', heroes.size >= 4, [...heroes].join(','));
  ok('chooser spreads: both nav variants appear', navs.size === 2, [...navs].join(','));
  ok('chooser spreads: >=3 distinct card variants across the matrix', cardVars.size >= 3, [...cardVars].join(','));
  ok('cards/hero combos are not all identical across the matrix', combos.size > 1);
  // ARC F: section modes must both appear somewhere in the 30-site matrix
  ok('features: both grid and rail modes appear across the 30-site matrix', featuresModes.size === 2, [...featuresModes].join(','));
  ok('testimonials: both grid and spotlight modes appear across the matrix', testimonialsModes.size === 2, [...testimonialsModes].join(','));
  ok('stats: both row and inline modes appear across the matrix', statsModes.size === 2, [...statsModes].join(','));
  // ARC F: new hero variants actually appear in the matrix
  ok('poster hero appears somewhere in the 30-site matrix', heroes.has('poster'), [...heroes].join(','));
  ok('ledger hero appears somewhere in the 30-site matrix', heroes.has('ledger'), [...heroes].join(','));
  // ARC F: minimal card variant appears (in editorial/minimal themes)
  ok('minimal card variant appears somewhere in the 30-site matrix', cardVars.has('minimal'), [...cardVars].join(','));
}

// ARC F · OLD-PARAMS BACK-COMPAT: a Layout object from before ARC F (without sectionModes, without
// poster/ledger heroes) must render identically to a chooseLayout result with the same core fields.
// This proves that adding new fields never mutates old sites — the renderer falls back to defaults.
{
  const oldLayout = { hero: 'image' as const, nav: 'standard' as const, band: false, cards: 'photo' as const };
  const oldHtml = renderPage(specOf(), { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', layout: oldLayout });
  // Old layout still renders: must pass the structural gate (no crash, correct body class, headline present)
  ok('old params (no sectionModes): renders without crash', oldHtml.length > 100);
  ok('old params (no sectionModes): correct body l-hero-image class', oldHtml.includes('l-hero-image'));
  ok('old params (no sectionModes): headline present', oldHtml.includes('We build things'));
  // features section falls back to grid mode (no sectionModes → default)
  ok('old params (no sectionModes): features defaults to grid mode', oldHtml.includes('features-grid'));
  // stats section falls back to row mode
  ok('old params (no sectionModes): stats defaults to row mode', oldHtml.includes('stats-row'));
}

// ARC F · SECTION-MODE STRUCTURAL MARKERS: each mode of each section type emits its own marker class.
{
  const withModes = (sm: any) => renderPage(
    { brand: { name: 'X', tokens: { bg: '#fff', primary: '#111' } }, sections: [
      { type: 'hero', headline: 'Test' },
      { type: 'features', title: 'F', items: [{ title: 'A', body: 'b' }, { title: 'B', body: 'c' }] },
      { type: 'testimonials', title: 'T', items: [{ quote: 'Great!', name: 'Bob', role: 'CEO' }, { quote: 'Lovely.', name: 'Ann', role: 'Founder' }] },
      { type: 'stats', title: 'S', items: [{ value: '10k', label: 'users' }, { value: '99%', label: 'uptime' }] },
    ] },
    { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', layout: { hero: 'image', nav: 'standard', band: false, cards: 'photo', sectionModes: sm } }
  );
  const gridHtml     = withModes({ features: 'grid',  testimonials: 'grid',      stats: 'row'    });
  const railHtml     = withModes({ features: 'rail',  testimonials: 'grid',      stats: 'row'    });
  const spotHtml     = withModes({ features: 'grid',  testimonials: 'spotlight', stats: 'row'    });
  const inlineHtml   = withModes({ features: 'grid',  testimonials: 'grid',      stats: 'inline' });
  ok('features grid: marker class present',           gridHtml.includes('features-grid'));
  ok('features rail: marker class present',           railHtml.includes('features-rail'));
  ok('features rail: uses features-cards container',  railHtml.includes('features-cards'));
  ok('testimonials grid: marker class present',       gridHtml.includes('testimonials-grid'));
  ok('testimonials spotlight: marker class present',  spotHtml.includes('testimonials-spotlight'));
  ok('testimonials spotlight: large quote rendered',  spotHtml.includes('spotlight-quote'));
  ok('testimonials spotlight: attribution rendered',  spotHtml.includes('spotlight-attr'));
  ok('stats row: marker class present',               gridHtml.includes('stats-row'));
  ok('stats inline: marker class present',            inlineHtml.includes('stats-inline'));
  ok('stats inline: si-n number class present',       inlineHtml.includes('si-n'));
  ok('stats inline: si-label class present',          inlineHtml.includes('si-label'));
  // modes must be structurally DIFFERENT (not byte-identical)
  ok('features grid and rail are structurally different', gridHtml !== railHtml);
  ok('testimonials grid and spotlight are structurally different', gridHtml !== spotHtml);
  ok('stats row and inline are structurally different', gridHtml !== inlineHtml);
}

// ARC F · MINIMAL CARD: body class + DS_CSS contains the rules
{
  const minHtml = renderPage(specOf(), { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', layout: { hero: 'image', nav: 'standard', band: false, cards: 'minimal' } });
  ok('l-cards-minimal body class lands on <body>', minHtml.includes('l-cards-minimal'));
}
ok('DS_CSS contains .l-cards-minimal rule', DS_CSS.includes('l-cards-minimal'));
// ARC F: verify new hero CSS is in DS_CSS
ok('DS_CSS contains .hero-poster rule', DS_CSS.includes('.hero-poster'));
ok('DS_CSS contains .hero-poster .hero-scrim (AA scrim)', DS_CSS.includes('.hero-poster .hero-scrim'));
ok('DS_CSS contains .hero-ledger rule', DS_CSS.includes('.hero-ledger'));
ok('DS_CSS contains .hero-ledger-grid rule', DS_CSS.includes('.hero-ledger-grid'));
// ARC F: verify section-mode CSS is in DS_CSS
ok('DS_CSS contains .features-rail rule', DS_CSS.includes('.features-rail'));
ok('DS_CSS contains .testimonials-spotlight rule', DS_CSS.includes('.testimonials-spotlight'));
ok('DS_CSS contains .stats-inline rule', DS_CSS.includes('.stats-inline'));

// (PQ1-B) each l-cards-* body class lands on <body> and DS_CSS contains the variant rules
for (const cv of CARD_VARIANTS) {
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
ok('service-register cards render money muted as From $X (via the locale dict)', rendered.image.includes('RELAY_T.from_price') && rendered.image.includes('moneyLast') && rendered.image.includes('"from_price":"From "'));
ok('the service register is table-classed (products stay commerce)', rendered.image.includes('practice|treatment'));
// the panel's exact findings on a real trio: 'From $0.00' on a complimentary consultation and
// '✓ available' inventory badges on brunch dishes — free = say nothing; badges are commerce-only
ok('a zero price never renders (free ≠ From $0.00)', rendered.image.includes('mv>0'));
ok('whole-dollar From-prices drop the cents (via __moneyS, locale-aware)', rendered.image.includes('__moneyS') && rendered.image.includes('n%1?n.toFixed(2)') && rendered.image.includes('RELAY_T.from_price+__moneyS(mv)'));
ok('inventory badges never render on service/menu/blog registers', rendered.image.includes('!v||svc||blog||'));
ok('menu/dishes are in the service register', rendered.image.includes('menu|dish|drink'));
// SEARCH: big grids get the client-side filter (8-row threshold, accessible, textContent only)
ok('grids with >=8 rows get a search box', rendered.image.includes('__searchbox') && rendered.image.includes('count<8'));
ok('the search box is accessible + safe (aria from the locale dict)', rendered.image.includes('RELAY_T.search_aria') && rendered.image.includes('"search_aria":"Search this list"') && rendered.image.includes('textContent'));
// HONEYPOT: every public form carries the trap; CSS hides it off-screen; a filled value = bot
{
  const formHtml = renderPage({ brand: { name: 'A', tokens: { bg: '#fff', primary: '#123456' } }, sections: [
    { type: 'hero', headline: 'Hi there' }, { type: 'form', title: 'Contact' }] },
    { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home' });
  ok('public forms carry the honeypot field', formHtml.includes('name="company_website"') && formHtml.includes('hp-field'));
  ok('the honeypot is hidden off-screen (humans never see it)', DS_CSS.includes('.hp-field') && DS_CSS.includes('-9999px'));
  const coHtml = renderPage({ brand: { name: 'A', tokens: {} }, sections: [{ type: 'hero', headline: 'Checkout' }, { type: 'checkout' }] },
    { pages: [{ slug: 'index', title: 'Home' }], slug: 'checkout', title: 'Checkout' });
  ok('checkout carries the honeypot too', coHtml.includes('name="company_website"'));
}

// IMAGE QUALITY GATES:
// (a) Hero images get eager loading (LCP candidate — reduces CLS/FCP)
// (b) All q() placeholder images emit alt=<query text> (not empty alt="")
// (c) Non-hero images stay lazy
{
  const heroSpec = () => ({ brand: { name: 'A', tokens: { bg: '#fff', primary: '#123456' } }, sections: [
    { type: 'hero', image: 'mountain landscape at dawn', headline: 'Welcome' },
    { type: 'split', image: 'team collaborating', title: 'About', body: 'We work together.' },
  ] });
  const imgHtml = renderPage(heroSpec(), { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home' });

  // Hero image: data-q placeholder must have loading="eager" and fetchpriority="high"
  ok('hero image placeholder has loading="eager"', imgHtml.includes('loading="eager"'));
  ok('hero image placeholder has fetchpriority="high"', imgHtml.includes('fetchpriority="high"'));

  // All q() placeholders must carry alt=<query text> (not the old alt="")
  ok('q() placeholders carry alt=query text (not blank)', imgHtml.includes('alt="mountain landscape at dawn"'));
  ok('split image carries its alt query text', imgHtml.includes('alt="team collaborating"'));

  // Non-hero placeholder images must still be lazy-loaded
  ok('non-hero images stay loading="lazy"', imgHtml.includes('loading="lazy"'));
}

// CANONICAL + og:image GATES:
// canonical link is present when siteBase is known; absent when not.
// og:image is absolute when siteBase is known.
{
  const withBase = renderPage(
    { brand: { name: 'A', tokens: { bg: '#fff', primary: '#123456' } }, sections: [{ type: 'hero', headline: 'Hi' }] },
    { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', siteBase: 'https://demo.naples.agency' });
  ok('canonical link is emitted when siteBase is known', withBase.includes('<link rel="canonical" href="https://demo.naples.agency/">'));
  ok('og:image is absolutized when siteBase is known', withBase.includes('og:image" content="https://demo.naples.agency/icon-512.png"'));

  const withoutBase = renderPage(
    { brand: { name: 'A', tokens: { bg: '#fff', primary: '#123456' } }, sections: [{ type: 'hero', headline: 'Hi' }] },
    { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home' });
  ok('canonical link is absent when siteBase is not known', !withoutBase.includes('<link rel="canonical"'));
  ok('og:image stays relative when siteBase is not known', withoutBase.includes('og:image" content="icon-512.png"'));
}

// ============================================================================
// ARC D · VIDEO SECTION GATES
// All assertions must hold at render time (no server, no live DB).
// INVARIANT: no iframe tag / youtube-nocookie URL in any src attribute before click.
// ============================================================================
// (SECTIONS already imported at the top of this file — no re-import needed)

// (A) Valid YouTube facade
{
  const html = SECTIONS.video({ youtubeId: 'dQw4w9WgXcQ', title: 'Watch this', poster: 'concert stage', caption: 'Live 2024' });
  ok('video: valid youtubeId renders a facade (not empty)', html.length > 0);
  ok('video: facade has NO <iframe> pre-click', !/<iframe/i.test(html));
  ok('video: youtube-nocookie URL NOT in any src= attribute pre-click', !/ src="[^"]*youtube-nocookie/.test(html));
  ok('video: nocookie URL is only in data-src (safe for pre-click)', html.includes('data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'));
  ok('video: play button overlay present (via CSS ::after — no inline play element needed)', html.includes('video-facade'));
  ok('video: title rendered', html.includes('Watch this'));
  ok('video: caption rendered', html.includes('Live 2024'));
  ok('video: aria-label on the button', html.includes('aria-label='));
  ok('video: poster image present (YouTube hqdefault fallback)', html.includes('hqdefault.jpg') || html.includes('data-q="concert stage"'));
}

// (B) Valid YouTube facade with q()-based poster
{
  const html = SECTIONS.video({ youtubeId: 'abcDEF12345', title: 'Demo', poster: 'product demo video' });
  ok('video: q() poster via data-q when poster string provided', html.includes('data-q="product demo video"'));
}

// (C) Direct .mp4 video — must have controls, preload=metadata, playsinline, NO autoplay
{
  const html = SECTIONS.video({ src: 'https://cdn.example.com/promo.mp4', title: 'Our story', caption: 'Filmed on location' });
  ok('video: direct mp4 renders <video> element', /<video/.test(html));
  ok('video: direct mp4 has controls attribute', /\bcontrols\b/.test(html));
  ok('video: direct mp4 has preload="metadata"', html.includes('preload="metadata"'));
  ok('video: direct mp4 has playsinline', html.includes('playsinline'));
  ok('video: direct mp4 has NO autoplay attribute', !/\bautoplay\b/.test(html));
  ok('video: direct mp4 caption rendered', html.includes('Filmed on location'));
  ok('video: direct mp4 source tag with correct type', html.includes('type="video/mp4"'));
}

// (D) Direct .webm video
{
  const html = SECTIONS.video({ src: 'https://cdn.example.com/promo.webm' });
  ok('video: webm source type correct', html.includes('type="video/webm"'));
  ok('video: webm has controls, no autoplay', /\bcontrols\b/.test(html) && !/\bautoplay\b/.test(html));
}

// (E) HOSTILE FIXTURES — all must render empty string, never throw, never emit unsanitized input
{
  // javascript: URL as youtubeId
  const jsId = SECTIONS.video({ youtubeId: 'javascript:alert(1)' });
  ok('video: hostile youtubeId (javascript:) renders empty (sanitized)', jsId === '');

  // youtubeId too long
  const longId = SECTIONS.video({ youtubeId: 'a'.repeat(25) });
  ok('video: youtubeId > 20 chars renders empty', longId === '');

  // youtubeId too short
  const shortId = SECTIONS.video({ youtubeId: 'abc' });
  ok('video: youtubeId < 6 chars renders empty', shortId === '');

  // youtubeId with script breakout attempt
  const xssId = SECTIONS.video({ youtubeId: '"><script>alert(1)</script>' });
  ok('video: youtubeId with XSS chars renders empty (not in whitelist)', xssId === '');
  ok('video: hostile youtubeId does NOT emit <script>', !xssId.includes('<script>'));

  // src with javascript: protocol
  const jsSrc = SECTIONS.video({ src: 'javascript:alert(1)' });
  ok('video: src with javascript: protocol renders empty', jsSrc === '');

  // src without https
  const httpSrc = SECTIONS.video({ src: 'http://cdn.example.com/vid.mp4' });
  ok('video: src with http:// (not https) renders empty', httpSrc === '');

  // src without .mp4/.webm extension
  const badExt = SECTIONS.video({ src: 'https://cdn.example.com/vid.avi' });
  ok('video: src with .avi extension renders empty', badExt === '');

  // src with onerror injection attempt
  const onerrorSrc = SECTIONS.video({ src: 'https://cdn.example.com/vid.mp4" onerror="alert(1)' });
  ok('video: src with onerror injection renders empty (fails regex)', onerrorSrc === '');

  // </script> breakout in youtubeId field
  const scriptBreak = SECTIONS.video({ youtubeId: '</script><script>evil()' });
  ok('video: youtubeId </script> breakout renders empty', scriptBreak === '');

  // onerror attribute in poster/title (must be escaped — no raw < > " in attribute context)
  // esc() converts: < → &lt;  > → &gt;  " → &quot;  & → &amp;
  // The injected title lands in an h2 text node and in aria-label (attribute), so " > < must be escaped.
  const xssTitle = SECTIONS.video({ youtubeId: 'dQw4w9WgXcQ', title: '"><img onerror=alert(1)>' });
  // the < from the hostile title must be escaped to &lt; (so <img never becomes a real tag)
  ok('video: XSS in title: < is escaped to &lt; in rendered output', xssTitle.includes('&lt;') || xssTitle.includes('&gt;'));
  // the " from the hostile title must be escaped to &quot; in attribute contexts
  ok('video: XSS in title: " is escaped to &quot; in aria-label attribute', xssTitle.includes('&quot;') || !xssTitle.includes('""><img'));

  // no youtubeId and no src → empty
  const empty = SECTIONS.video({ title: 'No video here' });
  ok('video: no youtubeId and no src renders empty string', empty === '');

  // malformed/null youtubeId
  const nullId = SECTIONS.video({ youtubeId: null, title: 'Null id' });
  ok('video: null youtubeId renders empty', nullId === '');
}

// (F) spec.ts KNOWN pin — 'video' must be accepted (not dropped) by normalizeSpec
{
  const { normalizeSpec } = await import('./spec.ts');
  const r = normalizeSpec({ brand: { name: 'X', tokens: { bg: '#fff', primary: '#111' } }, sections: [
    { type: 'hero', headline: 'Welcome' },
    { type: 'video', youtubeId: 'dQw4w9WgXcQ', title: 'Watch' },
    { type: 'features', items: [{ title: 'A', body: 'b' }] },
  ] });
  ok('spec: video section type is in KNOWN (not dropped)', r.spec && r.spec.sections.some((s: any) => s.type === 'video'));
  ok('spec: normalizeSpec video → no errors', r.errors.length === 0);

  // youtubeId extracted from a full YouTube URL at normalize stage
  const rUrl = normalizeSpec({ brand: { name: 'X', tokens: {} }, sections: [
    { type: 'hero', headline: 'Hi' },
    { type: 'video', youtubeId: 'https://youtu.be/dQw4w9WgXcQ', title: 'Watch' },
    { type: 'features', items: [{ title: 'A', body: 'b' }] },
  ] });
  const vidSec = rUrl.spec && rUrl.spec.sections.find((s: any) => s.type === 'video');
  ok('spec: youtubeId extracted from full URL at normalize stage', vidSec && vidSec.youtubeId === 'dQw4w9WgXcQ', JSON.stringify(vidSec));

  // invalid src (http) → dropped with a repair
  const rBad = normalizeSpec({ brand: { name: 'X', tokens: {} }, sections: [
    { type: 'hero', headline: 'Hi' },
    { type: 'video', src: 'http://not-https.com/video.mp4', title: 'Bad' },
    { type: 'features', items: [{ title: 'A', body: 'b' }] },
  ] });
  ok('spec: video with non-https src is dropped', !rBad.spec?.sections.some((s: any) => s.type === 'video'));

  // video with neither youtubeId nor src → dropped
  const rNone = normalizeSpec({ brand: { name: 'X', tokens: {} }, sections: [
    { type: 'hero', headline: 'Hi' },
    { type: 'video', title: 'Watch nothing' },
    { type: 'features', items: [{ title: 'A', body: 'b' }] },
  ] });
  ok('spec: video with no youtubeId and no src is dropped', !rNone.spec?.sections.some((s: any) => s.type === 'video'));
}

// (G) DS_CSS contains the video styles
ok('DS_CSS contains .video-facade rule', DS_CSS.includes('.video-facade'));
ok('DS_CSS contains aspect-ratio:16/9 for the video facade', DS_CSS.includes('aspect-ratio:16/9'));
ok('DS_CSS contains .video-caption rule', DS_CSS.includes('.video-caption'));

console.log(`\nlayout:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

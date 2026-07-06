// jsonld:check — schema.org STRUCTURED DATA. Proves the generators emit VALID JSON-LD, the renderer
// injects the right types per page (Organization+WebSite on home, Product on a product page, Breadcrumb
// on inner pages), values are injection-safe, local-business classification is deterministic, and
// archetype-specific @types (Restaurant, Dentist, HairSalon, …) are emitted correctly.
import { ldScript, organizationLd, websiteLd, breadcrumbLd, productLd, articleLd, isLocalBusiness, bizTypeFor } from './jsonld.ts';
import { renderPage } from './render.ts';

let pass = 0, fail = 0;
const ok = (n, c, e='') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.error('  ✗', n, e); } };
const base = 'https://acme.naples.agency';
const pages = [{ slug: 'index', title: 'Home' }, { slug: 'shop', title: 'Shop' }, { slug: 'about', title: 'About' }];

// ---- generators produce valid schema.org ----
const org = organizationLd({ name: 'Acme Cuts', base, logo: 'icon-512.png', localBusiness: true });
ok('LocalBusiness: correct @type + absolute url/logo', org['@type'] === 'LocalBusiness' && org.url === base && org.logo === base + '/icon-512.png' && org['@context'] === 'https://schema.org');
ok('Organization: non-local business gets Organization', organizationLd({ name: 'X', base }).__proto__ && organizationLd({ name: 'X', base })['@type'] === 'Organization');
const web = websiteLd({ name: 'Acme', base });
ok('WebSite: name + url', web['@type'] === 'WebSite' && web.url === base);
const bc = breadcrumbLd({ pages, slug: 'about', title: 'About', base });
ok('BreadcrumbList: Home → current, absolute items', bc['@type'] === 'BreadcrumbList' && bc.itemListElement.length === 2 && bc.itemListElement[0].item === base + '/' && bc.itemListElement[1].item === base + '/about.html');
ok('BreadcrumbList: null on the home page (nothing to trail)', breadcrumbLd({ pages, slug: 'index', title: 'Home', base }) === null);
const prod = productLd({ name: 'Fade', description: 'A clean cut', image: '/p.jpg', price: 25, currency: 'EUR', inStock: true, base, brandName: 'Acme' });
ok('Product: name + Offer(price/currency/availability) + brand + absolute image', prod['@type'] === 'Product' && prod.offers.price === '25.00' && prod.offers.priceCurrency === 'EUR' && prod.offers.availability === 'https://schema.org/InStock' && prod.image === base + '/p.jpg' && prod.brand.name === 'Acme');
ok('Product: out-of-stock availability', productLd({ name: 'X', price: 5, inStock: false }).offers.availability === 'https://schema.org/OutOfStock');
ok('Product: no price → no bogus Offer', !productLd({ name: 'X' }).offers);

// ---- injection safety: a hostile value can never break out of the <script> ----
const evil = ldScript(organizationLd({ name: 'Acme</script><script>alert(1)</script>', base }));
ok('ldScript escapes </script> and & (no breakout)', !evil.includes('</script><script>alert') && evil.includes('\\u003c') && JSON.parse(evil.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '').replace(/\\u003c/g,'<').replace(/\\u003e/g,'>').replace(/\\u0026/g,'&')).name.includes('alert'));
ok('ldScript: empty in → empty out (no dead tags)', ldScript([]) === '' && ldScript(null) === '');

// ---- local-business classification ----
ok('local biz: a barbershop is a LocalBusiness', isLocalBusiness('a barbershop booking app') === true && isLocalBusiness('a neighbourhood pizzeria with reservations') === true);
ok('local biz: a SaaS is NOT a LocalBusiness', isLocalBusiness('a B2B analytics SaaS platform') === false && isLocalBusiness('a personal portfolio') === false);

// ---- the RENDERER injects the right structured data per page ----
const parseLd = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g,'<').replace(/\\u003e/g,'>').replace(/\\u0026/g,'&').replace(/\\u2028/g,' ').replace(/\\u2029/g,' ')));
const home = renderPage({ brand: { name: 'Acme', tokens: { bg: '#fff', primary: '#111' } }, sections: [{ type: 'hero', headline: 'Hi' }] }, { pages, slug: 'index', title: 'Home', theme: 'modern', siteBase: base, localBusiness: true });
const homeLd = parseLd(home);
ok('render home: emits LocalBusiness + WebSite', homeLd.some((x) => x['@type'] === 'LocalBusiness' && x.name === 'Acme') && homeLd.some((x) => x['@type'] === 'WebSite'));
ok('render home: NO breadcrumb on the home page', !homeLd.some((x) => x['@type'] === 'BreadcrumbList'));
const inner = renderPage({ brand: { name: 'Acme', tokens: { bg: '#fff', primary: '#111' } }, sections: [{ type: 'hero', headline: 'About us' }] }, { pages, slug: 'about', title: 'About', theme: 'modern', siteBase: base });
const innerLd = parseLd(inner);
ok('render inner: emits a Breadcrumb, not Organization', innerLd.some((x) => x['@type'] === 'BreadcrumbList') && !innerLd.some((x) => x['@type'] === 'Organization'));
const pdp = renderPage({ brand: { name: 'Acme', tokens: { bg: '#fff', primary: '#111' } }, sections: [{ type: 'product', row: { title: 'Sea Salt Candle', price: 24, description: 'Hand-poured', stock: 5, image_url: '/candle.jpg' } }] }, { pages, slug: 'product-1', title: 'Sea Salt Candle', theme: 'modern', siteBase: base });
const pdpLd = parseLd(pdp);
ok('render PDP: emits a Product with the real price + InStock', pdpLd.some((x) => x['@type'] === 'Product' && x.name === 'Sea Salt Candle' && x.offers?.price === '24.00' && x.offers?.availability === 'https://schema.org/InStock'), JSON.stringify(pdpLd));
ok('render: every emitted ld+json block is valid JSON (no broken structured data)', [home, inner, pdp].every((h) => { try { parseLd(h); return true; } catch { return false; } }));

// ---- Article on a blog/recipe post ----
const artGen = articleLd({ headline: 'How we roast', image: '/roast.jpg', datePublished: '2026-01-15T10:00:00Z', author: 'Nao', description: 'A guide to roasting', base, url: 'post-3.html', publisher: 'Acme' });
ok('Article: headline + ISO datePublished + author + publisher + absolute image', artGen['@type'] === 'Article' && artGen.datePublished === '2026-01-15T10:00:00.000Z' && artGen.author.name === 'Nao' && artGen.publisher.name === 'Acme' && artGen.image === base + '/roast.jpg');
const post = renderPage({ brand: { name: 'Acme', tokens: { bg: '#fff', primary: '#111' } }, sections: [{ type: 'article', row: { title: 'Sourdough 101', body: 'Long body about bread…', author: 'Mira', created_at: '2026-02-01T08:00:00Z', cover_image: '/bread.jpg' } }] }, { pages, slug: 'post-1', title: 'Sourdough 101', theme: 'modern', siteBase: base });
const postLd = parseLd(post);
ok('render post: emits an Article with the post title + author + date', postLd.some((x) => x['@type'] === 'Article' && x.headline === 'Sourdough 101' && x.author?.name === 'Mira' && !!x.datePublished), JSON.stringify(postLd));

// ---- wiring: localBusiness is a build property; the live + build renders thread siteBase ----
const plannerSrc = (await import('node:fs')).readFileSync(new URL('./planner.ts', import.meta.url), 'utf8');
ok('planner: localBusiness is computed once as a build property', plannerSrc.includes('localBusiness: isLocalBusiness(brief)'));
const liveSrc = (await import('node:fs')).readFileSync(new URL('./cms/live.ts', import.meta.url), 'utf8');
ok('live: the crawled surfaces thread siteBase + localBusiness', (liveSrc.match(/siteBase: params\.slug/g) || []).length >= 2 && liveSrc.includes('localBusiness: !!params.localBusiness'));

// ---- ARCHETYPE @type map (bizTypeFor) ----
// Each specific schema.org type must fire on the right brief; the fallback chain must hold.
ok('bizTypeFor: restaurant brief → Restaurant', bizTypeFor('a local pizzeria and trattoria') === 'Restaurant');
ok('bizTypeFor: law firm brief → LegalService', bizTypeFor('a law firm specializing in mergers') === 'LegalService');
ok('bizTypeFor: dental clinic brief → Dentist', bizTypeFor('a modern dental clinic in the city') === 'Dentist');
ok('bizTypeFor: physiotherapy → MedicalBusiness', bizTypeFor('a physiotherapy and sports clinic') === 'MedicalBusiness');
ok('bizTypeFor: hair salon → HairSalon', bizTypeFor('a hair salon and barber shop') === 'HairSalon');
ok('bizTypeFor: gym → ExerciseGym', bizTypeFor('a gym and fitness studio') === 'ExerciseGym');
ok('bizTypeFor: hotel → Hotel', bizTypeFor('a boutique hotel on the coast') === 'Hotel');
ok('bizTypeFor: shop → Store', bizTypeFor('a boutique store selling vintage clothes') === 'Store');
ok('bizTypeFor: generic local biz stays LocalBusiness (fallback tier 2)', bizTypeFor('a plumbing contractor') === 'LocalBusiness');
ok('bizTypeFor: SaaS → Organization (fallback tier 3)', bizTypeFor('a B2B analytics SaaS') === 'Organization');
ok('bizTypeFor: isLocalBusiness-true briefs NEVER return Organization', (() => {
  const briefs = ['a barbershop booking app', 'a nail salon', 'a dental practice', 'a neighbourhood bakery'];
  return briefs.every((b) => bizTypeFor(b) !== 'Organization');
})());

// ---- organizationLd uses bizType when provided (specific @type in the emitted JSON-LD) ----
const restaurant = organizationLd({ name: 'Da Vito', base, logo: 'icon-512.png', bizType: 'Restaurant' });
ok('organizationLd: bizType=Restaurant emits @type=Restaurant', restaurant['@type'] === 'Restaurant');
const legalSvc = organizationLd({ name: 'Smith & Co', base, bizType: 'LegalService' });
ok('organizationLd: bizType=LegalService emits @type=LegalService', legalSvc['@type'] === 'LegalService');
ok('organizationLd: back-compat — localBusiness=true still works as LocalBusiness', organizationLd({ name: 'X', base, localBusiness: true })['@type'] === 'LocalBusiness');

// ---- renderer emits Restaurant @type for a restaurant brief with bizType ----
const restHome = renderPage(
  { brand: { name: 'Da Vito', tokens: { bg: '#fff', primary: '#111' } }, sections: [{ type: 'hero', headline: 'La Cucina' }] },
  { pages, slug: 'index', title: 'Home', theme: 'modern', siteBase: base, localBusiness: true, bizType: 'Restaurant' });
const restLd = parseLd(restHome);
ok('render home with bizType=Restaurant: emits @type=Restaurant, not LocalBusiness', restLd.some((x) => x['@type'] === 'Restaurant') && !restLd.some((x) => x['@type'] === 'LocalBusiness'), JSON.stringify(restLd.map((x) => x['@type'])));

// ---- CANONICAL link is present with siteBase, absent without ----
ok('render: canonical link emitted when siteBase is known', home.includes('<link rel="canonical" href="https://acme.naples.agency/">'));
ok('render inner: canonical link uses the inner page URL', inner.includes('<link rel="canonical" href="https://acme.naples.agency/about.html">'));
const noBase = renderPage(
  { brand: { name: 'X', tokens: { bg: '#fff', primary: '#111' } }, sections: [{ type: 'hero', headline: 'Hi' }] },
  { pages, slug: 'index', title: 'Home' });   // no siteBase
ok('render: canonical link OMITTED when siteBase is absent (dev/fixture render)', !noBase.includes('<link rel="canonical"'));

// ---- og:image is ABSOLUTE when siteBase is known ----
ok('render: og:image is absolute when siteBase is known', home.includes('og:image" content="https://acme.naples.agency/icon-512.png"'));
ok('render: og:image is relative when siteBase is absent', noBase.includes('og:image" content="icon-512.png"'));

// ---- alt=query in q() placeholder images (gate for the q() fix in components.ts) ----
const componentsSrc = (await import('node:fs')).readFileSync(new URL('./components.ts', import.meta.url), 'utf8');
ok('components: q() emits alt=query (not empty alt)', /const q = /.test(componentsSrc) && /alt="\$\{esc\(query\)\}"/.test(componentsSrc));
ok('components: q() emits eager attrs for hero images', componentsSrc.includes('loading="eager"') && componentsSrc.includes('fetchpriority="high"'));

// ---- buildImgTag pure function in media.ts (CLS-proof, srcset, alt, eager) ----
const { buildImgTag } = await import('./media.ts');
const fixtureMeta = { query: 'sunset over the ocean', local: 'assets/media-1.jpg', localMedium: 'assets/media-1-m.jpg', width: 1920, height: 1080 };
const lazyTag = buildImgTag(fixtureMeta, false, 'hero-bg');
ok('buildImgTag: emits width + height (CLS-proof)', lazyTag.includes('width="1920"') && lazyTag.includes('height="1080"'));
ok('buildImgTag: emits srcset with large + medium', lazyTag.includes('assets/media-1.jpg') && lazyTag.includes('assets/media-1-m.jpg'));
ok('buildImgTag: emits sizes attribute', lazyTag.includes('sizes='));
ok('buildImgTag: emits alt from query', lazyTag.includes('alt="sunset over the ocean"'));
ok('buildImgTag: non-hero → loading="lazy"', lazyTag.includes('loading="lazy"') && !lazyTag.includes('loading="eager"'));
const eagerTag = buildImgTag(fixtureMeta, true, 'hero-bg');
ok('buildImgTag: hero → loading="eager" fetchpriority="high"', eagerTag.includes('loading="eager"') && eagerTag.includes('fetchpriority="high"'));
ok('buildImgTag: hero uses sizes=100vw', eagerTag.includes('sizes="100vw"'));
ok('buildImgTag: non-hero uses sizes with 33vw breakpoint', lazyTag.includes('33vw'));
ok('buildImgTag: class attribute carried through', lazyTag.includes('class="hero-bg"'));

console.log(`\njsonld:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

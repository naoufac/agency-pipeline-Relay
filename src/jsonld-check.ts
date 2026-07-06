// jsonld:check — schema.org STRUCTURED DATA. Proves the generators emit VALID JSON-LD, the renderer
// injects the right types per page (Organization+WebSite on home, Product on a product page, Breadcrumb
// on inner pages), values are injection-safe, local-business classification is deterministic, and
// archetype-specific @types (Restaurant, Dentist, HairSalon, …) are emitted correctly.
import { ldScript, organizationLd, websiteLd, breadcrumbLd, productLd, articleLd, faqPageLd, extractBusinessFacts, isLocalBusiness, bizTypeFor } from './jsonld.ts';
import { sitemapXml } from './seo.ts';
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
// ARC C source-pin: renderPage now emits a <link> to the external DS CSS; live renders go through
// the same renderPage so they automatically pick up the link. The CSS file is written by the build
// (runner.ts) into the same site dir that live serves from — the file is guaranteed present.
const renderSrc = (await import('node:fs')).readFileSync(new URL('./render.ts', import.meta.url), 'utf8');
ok('ARC C: renderPage uses dsCssHash to derive the external CSS href (not inlining DS_CSS_BODY)', renderSrc.includes('dsCssHash') && renderSrc.includes('DS_CSS_BODY') && renderSrc.includes('dsHref') && !renderSrc.includes('DS_CSS}'));
ok('ARC C: live.ts does not inline DS CSS body (uses renderPage which emits the link)', !liveSrc.includes('DS_CSS'));

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

ok('live.ts threads params.bizType into every renderPage call (live pages emit the specific @type, not generic LocalBusiness)',
  (liveSrc.match(/bizType: params\.bizType/g) || []).length >= 7);

// ---- ARC G: extractBusinessFacts fixtures ----
// Happy-path: brand carries phone + email + address + hours
const siteWithAll = {
  brand: { phone: '+39 081 123 4567', email: 'info@davito.it', address: { streetAddress: 'Via Roma 1', addressLocality: 'Napoli', addressCountry: 'IT' }, hours: 'Mon-Fri 9:00-17:00, Sat 10:00-14:00' },
  pages: [],
};
const factsAll = extractBusinessFacts(siteWithAll);
ok('extractBusinessFacts: telephone found in brand.phone', typeof factsAll.telephone === 'string' && factsAll.telephone.length > 0, JSON.stringify(factsAll));
ok('extractBusinessFacts: email found in brand.email', factsAll.email === 'info@davito.it', JSON.stringify(factsAll));
ok('extractBusinessFacts: address PostalAddress built from brand.address object', factsAll.address && factsAll.address['@type'] === 'PostalAddress' && factsAll.address.streetAddress === 'Via Roma 1' && factsAll.address.addressLocality === 'Napoli', JSON.stringify(factsAll));
ok('extractBusinessFacts: openingHours parsed Mon-Fri 9-17 + Sat 10-14', Array.isArray(factsAll.openingHours) && factsAll.openingHours.length >= 6, JSON.stringify(factsAll));
ok('extractBusinessFacts: Mon spec has opens=09:00 closes=17:00', (factsAll.openingHours || []).some((s: any) => s.dayOfWeek === 'https://schema.org/Monday' && s.opens === '09:00' && s.closes === '17:00'), JSON.stringify(factsAll));
ok('extractBusinessFacts: Sat spec has opens=10:00 closes=14:00', (factsAll.openingHours || []).some((s: any) => s.dayOfWeek === 'https://schema.org/Saturday' && s.opens === '10:00' && s.closes === '14:00'), JSON.stringify(factsAll));

// Italian day names ("Lun–Ven")
const siteItalian = {
  brand: { hours: 'Lun–Ven 9–18, Sab 10–22' },
  pages: [],
};
const factsIt = extractBusinessFacts(siteItalian);
ok('extractBusinessFacts: Italian hours Lun–Ven parses Monday through Friday', (factsIt.openingHours || []).some((s: any) => s.dayOfWeek === 'https://schema.org/Monday' && s.opens === '09:00' && s.closes === '18:00') && (factsIt.openingHours || []).some((s: any) => s.dayOfWeek === 'https://schema.org/Friday'), JSON.stringify(factsIt));
ok('extractBusinessFacts: Italian Sab parses Saturday', (factsIt.openingHours || []).some((s: any) => s.dayOfWeek === 'https://schema.org/Saturday' && s.opens === '10:00' && s.closes === '22:00'), JSON.stringify(factsIt));

// Absent data → absent fields (gate: no invented values)
const factsEmpty = extractBusinessFacts({ brand: {}, pages: [] });
ok('extractBusinessFacts: absent data yields no telephone', factsEmpty.telephone === undefined, JSON.stringify(factsEmpty));
ok('extractBusinessFacts: absent data yields no email', factsEmpty.email === undefined, JSON.stringify(factsEmpty));
ok('extractBusinessFacts: absent data yields no address', factsEmpty.address === undefined, JSON.stringify(factsEmpty));
ok('extractBusinessFacts: absent data yields no openingHours', factsEmpty.openingHours === undefined, JSON.stringify(factsEmpty));
ok('extractBusinessFacts: null/missing site → empty result (no throw)', JSON.stringify(extractBusinessFacts(null)) === '{}' && JSON.stringify(extractBusinessFacts(undefined)) === '{}');

// Hostile strings: a phone/email that contains </script> must still be escaped safely when emitted
const siteHostile = {
  brand: { phone: '+39 081</script><script>alert(1)', email: 'x@y.z' },
  pages: [],
};
const factsHostile = extractBusinessFacts(siteHostile);
// the raw string is extracted (escaping happens in ldScript), so check it doesn't invent weird values
ok('extractBusinessFacts: hostile phone string extracted (ldScript does the escaping)', typeof factsHostile.telephone === 'string');
const hostileOrg = organizationLd({ name: 'X', base, telephone: factsHostile.telephone });
const hostileScript = ldScript(hostileOrg);
ok('ldScript escapes hostile phone value in org block', !hostileScript.includes('</script><script>'));

// Flat street string → PostalAddress
const siteStr = { brand: { address: 'Via Caracciolo 10, Napoli' }, pages: [] };
const factsStr = extractBusinessFacts(siteStr);
ok('extractBusinessFacts: flat "street, city" string → PostalAddress with street + city', factsStr.address && factsStr.address.streetAddress === 'Via Caracciolo 10' && factsStr.address.addressLocality === 'Napoli', JSON.stringify(factsStr));

// ---- ARC G: FAQPage ----
const faqItems = [{ q: 'What are your hours?', a: 'Mon-Fri 9am-5pm.' }, { q: 'Do you take cards?', a: 'Yes, all major cards.' }];
const faqLd = faqPageLd(faqItems);
ok('faqPageLd: emits @type=FAQPage with 2 questions', faqLd && faqLd['@type'] === 'FAQPage' && Array.isArray(faqLd.mainEntity) && faqLd.mainEntity.length === 2, JSON.stringify(faqLd));
ok('faqPageLd: each entity is @type=Question with acceptedAnswer', faqLd && faqLd.mainEntity.every((e: any) => e['@type'] === 'Question' && e.acceptedAnswer && e.acceptedAnswer['@type'] === 'Answer'));
ok('faqPageLd: returns null on empty items', faqPageLd([]) === null);
ok('faqPageLd: returns null when items have no q/a content', faqPageLd([{ q: '', a: '' } as any]) === null);

// Renderer emits FAQPage on a page with faq section
const faqPage = renderPage(
  { brand: { name: 'Acme', tokens: { bg: '#fff', primary: '#111' } }, sections: [{ type: 'hero', headline: 'Welcome' }, { type: 'faq', title: 'FAQ', items: [{ q: 'Do you deliver?', a: 'Yes, nationwide.' }, { q: 'Returns policy?', a: '30 days.' }] }] },
  { pages, slug: 'index', title: 'Home', theme: 'modern', siteBase: base, localBusiness: true });
const faqPageLdBlocks = parseLd(faqPage);
ok('render: FAQPage emitted when faq section has 2 items', faqPageLdBlocks.some((x: any) => x['@type'] === 'FAQPage' && x.mainEntity?.length === 2), JSON.stringify(faqPageLdBlocks.map((x: any) => x['@type'])));
ok('render: FAQPage question text matches section item', faqPageLdBlocks.some((x: any) => x['@type'] === 'FAQPage' && x.mainEntity?.some((e: any) => e.name === 'Do you deliver?')), JSON.stringify(faqPageLdBlocks));

// No FAQPage when faq section has no items
const noFaqPage = renderPage(
  { brand: { name: 'Acme', tokens: { bg: '#fff', primary: '#111' } }, sections: [{ type: 'hero', headline: 'Hi' }] },
  { pages, slug: 'index', title: 'Home', theme: 'modern', siteBase: base });
const noFaqLdBlocks = parseLd(noFaqPage);
ok('render: NO FAQPage when no faq section', !noFaqLdBlocks.some((x: any) => x['@type'] === 'FAQPage'));

// ---- ARC G: sitemap lastmod ----
const sm = sitemapXml('proj-1', [{ slug: 'index' }, { slug: 'about' }], 'mysite', '2026-07-06T12:00:00.000Z');
ok('sitemapXml: lastmod element present when buildDate supplied', sm.includes('<lastmod>2026-07-06</lastmod>'), sm.slice(0, 500));
ok('sitemapXml: only date portion in lastmod (no time component)', !sm.includes('T12:00'));
ok('sitemapXml: all URL entries have lastmod', (sm.match(/<lastmod>/g) || []).length === (sm.match(/<loc>/g) || []).length, sm.slice(0, 500));
const smNoDate = sitemapXml('proj-2', [{ slug: 'index' }], undefined, undefined);
ok('sitemapXml: lastmod omitted when buildDate absent', !smNoDate.includes('<lastmod>'));
const smBadDate = sitemapXml('proj-3', [{ slug: 'index' }], undefined, 'not-a-date');
ok('sitemapXml: lastmod omitted when buildDate invalid', !smBadDate.includes('<lastmod>'));

// ---- ARC G: render home emits business facts in LocalBusiness block ----
const bizFactsHome = renderPage(
  { brand: { name: 'Trattoria Vito', tokens: { bg: '#fff', primary: '#111' }, phone: '+39 06 9999999', email: 'ciao@vito.it' }, sections: [{ type: 'hero', headline: 'La Cucina' }] },
  { pages, slug: 'index', title: 'Home', theme: 'modern', siteBase: base, localBusiness: true, bizType: 'Restaurant' });
const bizFactsLd = parseLd(bizFactsHome);
const restBlock = bizFactsLd.find((x: any) => x['@type'] === 'Restaurant');
ok('render home: telephone from brand.phone ends up in LocalBusiness block', restBlock && typeof restBlock.telephone === 'string' && restBlock.telephone.length > 0, JSON.stringify(restBlock));
ok('render home: email from brand.email ends up in LocalBusiness block', restBlock && restBlock.email === 'ciao@vito.it', JSON.stringify(restBlock));

// ---- LIVE-CAUGHT 2026-07-06: facts live in PROSE on the CONTACT page, not structured fields ----
{
  const realSite = { brand: { name: 'Studio Legale Marchetti' }, pages: [
    { slug: 'index', sections: [{ type: 'hero', headline: 'Tutela legale' }] },
    { slug: 'contact', sections: [{ type: 'split', body: 'Telefono: +39 081 555 2200. Email: segreteria@studiolegalemarchetti.it. Orari: lunedì-venerdì, 9:00-18:00. Lo studio si trova in Via Toledo 15, a Napoli — a due passi dalla fermata.' }] },
  ]};
  const rf = extractBusinessFacts(realSite);
  ok('free-text: telephone found in contact-page prose', rf.telephone === '+39 081 555 2200', JSON.stringify(rf.telephone));
  ok('free-text: email found in prose', rf.email === 'segreteria@studiolegalemarchetti.it', JSON.stringify(rf.email));
  ok('free-text: full Italian day names + comma shape parse to Mon-Fri specs', Array.isArray(rf.openingHours) && rf.openingHours.length === 5
    && rf.openingHours[0].opens === '09:00' && rf.openingHours[0].closes === '18:00', JSON.stringify(rf.openingHours || []).slice(0, 120));
  ok('free-text: Italian street address extracted conservatively', rf.address && rf.address.streetAddress === 'Via Toledo 15' && rf.address.addressLocality === 'Napoli', JSON.stringify(rf.address));
  // a time range alone must NEVER become a telephone (>=8 digit floor)
  const noPhone = extractBusinessFacts({ pages: [{ slug: 'index', sections: [{ type: 'split', body: 'Aperti 9:00-18:00 tutti i giorni.' }] }] });
  ok('free-text: a bare time range never becomes a telephone', !noPhone.telephone, JSON.stringify(noPhone));
  // renderPage PREFERS ctx.bizFacts (whole-site extraction) over the single-page proxy
  const homeHtml = renderPage({ brand: { name: 'Marchetti' }, sections: [{ type: 'hero', headline: 'x' }] },
    { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', theme: 'editorial', siteBase: 'https://x.naples.agency', bizType: 'LegalService', bizFacts: rf });
  ok('renderPage: ctx.bizFacts lands in the home LD (telephone visible)', homeHtml.includes('+39 081 555 2200'));
  ok('renderPage: ctx.bizFacts hours land in the home LD', homeHtml.includes('OpeningHoursSpecification'));
}

console.log(`\njsonld:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

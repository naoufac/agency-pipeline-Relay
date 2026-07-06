// jsonld:check — schema.org STRUCTURED DATA. Proves the generators emit VALID JSON-LD, the renderer
// injects the right types per page (Organization+WebSite on home, Product on a product page, Breadcrumb
// on inner pages), values are injection-safe, and local-business classification is deterministic.
import { ldScript, organizationLd, websiteLd, breadcrumbLd, productLd, isLocalBusiness } from './jsonld.ts';
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

// ---- wiring: localBusiness is a build property; the live + build renders thread siteBase ----
const plannerSrc = (await import('node:fs')).readFileSync(new URL('./planner.ts', import.meta.url), 'utf8');
ok('planner: localBusiness is computed once as a build property', plannerSrc.includes('localBusiness: isLocalBusiness(brief)'));
const liveSrc = (await import('node:fs')).readFileSync(new URL('./cms/live.ts', import.meta.url), 'utf8');
ok('live: the crawled surfaces thread siteBase + localBusiness', (liveSrc.match(/siteBase: params\.slug/g) || []).length >= 2 && liveSrc.includes('localBusiness: !!params.localBusiness'));

console.log(`\njsonld:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

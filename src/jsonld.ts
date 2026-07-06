// jsonld.ts — schema.org STRUCTURED DATA on every produced page. This is what makes Google show rich
// results: a business's name/logo in the knowledge panel (Organization / LocalBusiness), a sitelinks
// search box (WebSite), a price + availability on a product listing (Product), and breadcrumb trails.
// All DETERMINISTIC from data Relay already holds (brand, pages, the product row) — no LLM, no guessing.
// Emitted as <script type="application/ld+json">; values are escaped so a stray '</script>' or '&' in
// real data can never break out of the block.

const jstr = (obj: any) => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const abs = (base: string | undefined, path: string) => base ? `${base.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}` : path;
const clean = (o: any): any => { const r: any = {}; for (const k of Object.keys(o)) if (o[k] != null && o[k] !== '') r[k] = o[k]; return r; };

// one or more schema.org objects → the <script> block(s). Empty in → '' (no dead tags).
export function ldScript(objs: any): string {
  const arr = (Array.isArray(objs) ? objs : [objs]).filter(Boolean);
  return arr.map((o) => `<script type="application/ld+json">${jstr(o)}</script>`).join('');
}

// organizationLd: use bizType (specific schema.org @type) when provided;
// fall back to the old localBusiness boolean for back-compat with the existing test suite.
export function organizationLd(a: { name: string; base?: string; logo?: string; localBusiness?: boolean; bizType?: string }): any {
  const type = a.bizType || (a.localBusiness ? 'LocalBusiness' : 'Organization');
  return clean({ '@context': 'https://schema.org', '@type': type,
    name: a.name, url: a.base || undefined, logo: a.logo ? abs(a.base, a.logo) : undefined });
}
export function websiteLd(a: { name: string; base?: string }): any {
  return clean({ '@context': 'https://schema.org', '@type': 'WebSite', name: a.name, url: a.base || undefined });
}
// Home > current page. Null when there is nothing to trail (a single-page site / the home page itself).
export function breadcrumbLd(a: { pages: { slug: string; title?: string }[]; slug: string; title?: string; base?: string }): any {
  const home = (a.pages || []).find((p) => /^index$/i.test(p.slug)) || (a.pages || [])[0];
  const items: any[] = [];
  if (home && home.slug !== a.slug) items.push({ '@type': 'ListItem', position: 1, name: home.title || 'Home', item: abs(a.base, home.slug === 'index' ? '' : home.slug + '.html') });
  items.push({ '@type': 'ListItem', position: items.length + 1, name: a.title || a.slug, item: abs(a.base, a.slug === 'index' ? '' : a.slug + '.html') });
  if (items.length < 2) return null;
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items };
}
export function productLd(a: { name: string; description?: string; image?: string; price?: any; currency?: string; inStock?: boolean; base?: string; brandName?: string }): any {
  const ld: any = clean({ '@context': 'https://schema.org', '@type': 'Product', name: a.name,
    description: a.description ? String(a.description).slice(0, 400) : undefined,
    image: a.image ? abs(a.base, a.image) : undefined,
    brand: a.brandName ? { '@type': 'Brand', name: a.brandName } : undefined });
  const price = Number(a.price);
  if (a.price != null && Number.isFinite(price) && price >= 0) ld.offers = clean({ '@type': 'Offer', price: price.toFixed(2), priceCurrency: a.currency || 'USD', availability: `https://schema.org/${a.inStock === false ? 'OutOfStock' : 'InStock'}` });
  return ld;
}

// a blog/news/recipe post → Article (rich cards, "top stories" eligibility). datePublished from the
// row's created_at; author + publisher when known.
export function articleLd(a: { headline: string; image?: string; datePublished?: string; author?: string; description?: string; base?: string; url?: string; publisher?: string }): any {
  const iso = a.datePublished ? new Date(a.datePublished) : null;
  return clean({ '@context': 'https://schema.org', '@type': 'Article',
    headline: String(a.headline).slice(0, 110),
    image: a.image ? abs(a.base, a.image) : undefined,
    datePublished: iso && !isNaN(+iso) ? iso.toISOString() : undefined,
    description: a.description ? String(a.description).replace(/\s+/g, ' ').slice(0, 300) : undefined,
    author: a.author ? { '@type': 'Person', name: String(a.author).slice(0, 80) } : undefined,
    publisher: a.publisher ? { '@type': 'Organization', name: a.publisher } : undefined,
    mainEntityOfPage: a.url ? abs(a.base, a.url) : undefined });
}

// LOCAL-BUSINESS detection from the brief (a physical-location service → LocalBusiness, else Organization).
const LOCAL_BIZ = /\b(barbershops?|barbers?|salons?|spas?|restaurants?|cafe|café|baker(?:y|ies)|pubs?|brewer(?:y|ies)|bistros?|diners?|pizzeria|taqueria|clinics?|dental|dentists?|doctors?|physio\w*|chiropract\w*|veterinar\w*|\bvet\b|gyms?|fitness|yoga|pilates|studios?|boutiques?|hotels?|motels?|florists?|repair\w*|garages?|mechanics?|plumb\w*|electrician\w*|hvac|contractors?|landscap\w*|laundr\w*|realtors?|realty|real estate|butchers?|grocer\w*|\bdeli\b|nail\s?salons?|hair\s?salons?|massage|tattoo\w*|opticians?|pharmac\w*|hardware stores?|booksh\w*|bookstores?)\b/i;
export const isLocalBusiness = (brief: string): boolean => LOCAL_BIZ.test(String(brief || ''));

// ARCHETYPE JSON-LD: map a brief → the most SPECIFIC schema.org @type for the business.
// This gives Google richer signals (a Restaurant in Maps vs a generic LocalBusiness). The tiers:
//   1. Specific schema.org subtype (restaurant/dentist/salon/…) — best ranking signal
//   2. LocalBusiness fallback for any physical-presence brief that matches LOCAL_BIZ
//   3. Organization for everything else (SaaS, portfolio, platform, agency)
// Order is exact-first (restaurant before LocalBusiness) to avoid over-broadening.
// Keep isLocalBusiness() working (back-compat) — it is the building block here.
const BIZ_TYPES: [RegExp, string][] = [
  [/\b(restaurants?|trattoria|pizzeria|cafe|café|bistro|osteria|diners?|taqueria|brasserie|cantina)\b/i, 'Restaurant'],
  [/\b(law\s*firm|attorney|lawyer|legal\s*service|solicitor|barrister)\b/i, 'LegalService'],
  [/\b(dentis[st]|dental)\b/i, 'Dentist'],
  [/\b(clinic|physio\w*|therapy|therapist|medical|chiropract\w*|psychiatr\w*|psycholog\w*|osteopath\w*)\b/i, 'MedicalBusiness'],
  [/\b(barber\w*|hair\s?salon|hair\s?dresser|salon)\b/i, 'HairSalon'],
  [/\b(gym|fitness|exercise\s?studio|crossfit|pilates|yoga)\b/i, 'ExerciseGym'],
  [/\b(hotels?|motels?|b&b|bed\s*and\s*breakfast|guesthouse|inn|hostel)\b/i, 'Hotel'],
  [/\b(shop|boutique|store)\b/i, 'Store'],
];
// Returns the most specific schema.org @type for the brief.
// Invariant: if isLocalBusiness() is true, this returns something ≠ 'Organization'.
export function bizTypeFor(brief: string): string {
  const s = String(brief || '');
  for (const [re, type] of BIZ_TYPES) if (re.test(s)) return type;
  if (LOCAL_BIZ.test(s)) return 'LocalBusiness';
  return 'Organization';
}

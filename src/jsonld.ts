// jsonld.ts — schema.org STRUCTURED DATA on every produced page. This is what makes Google show rich
// results: a business's name/logo in the knowledge panel (Organization / LocalBusiness), a sitelinks
// search box (WebSite), a price + availability on a product listing (Product), and breadcrumb trails.
// All DETERMINISTIC from data Relay already holds (brand, pages, the product row) — no LLM, no guessing.
// Emitted as <script type="application/ld+json">; values are escaped so a stray '</script>' or '&' in
// real data can never break out of the block.
// ARC G additions:
//   extractBusinessFacts(site) — pulls telephone/email/address/openingHours from the site model
//   faqPageLd(items)           — FAQPage block from a faq section's items[{q,a}]

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
// ARC G: also accepts telephone/email/address/openingHoursSpecification for richer local-business JSON-LD.
export function organizationLd(a: { name: string; base?: string; logo?: string; localBusiness?: boolean; bizType?: string; telephone?: string; email?: string; address?: any; openingHoursSpecification?: any[] }): any {
  const type = a.bizType || (a.localBusiness ? 'LocalBusiness' : 'Organization');
  return clean({ '@context': 'https://schema.org', '@type': type,
    name: a.name, url: a.base || undefined, logo: a.logo ? abs(a.base, a.logo) : undefined,
    telephone: a.telephone || undefined,
    email: a.email || undefined,
    address: a.address || undefined,
    openingHoursSpecification: (Array.isArray(a.openingHoursSpecification) && a.openingHoursSpecification.length) ? a.openingHoursSpecification : undefined,
  });
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

// FAQ PAGE schema: a FAQ section with real items → FAQPage (eligible for Google's "People also ask"
// rich results). Empty/missing items → null (no dead blocks). Items are escaped in ldScript so
// a stray </script> in a question/answer can never break out of the JSON-LD block.
export function faqPageLd(items: { q: string; a: string }[]): any | null {
  const valid = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.q === 'string' && it.q.trim() && typeof it.a === 'string' && it.a.trim());
  if (!valid.length) return null;
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: valid.map((it) => ({
      '@type': 'Question',
      name: String(it.q).trim().slice(0, 250),
      acceptedAnswer: { '@type': 'Answer', text: String(it.a).trim().slice(0, 600) },
    })),
  };
}

// PHONE regex: accepts common formats (+39 06 1234567, +1-800-555-0100, (02) 9999-0000, 06.1234567, …).
// Requires at least 7 digits. Strips formatting characters before storing so schema.org gets a clean value.
const PHONE_RE = /(\+?[\d][\d\s.\-()]{5,}[\d])/;
// EMAIL regex: conservative — local@domain.tld only (no quotes, no path).
const EMAIL_RE = /\b([\w.+\-]+@[\w\-]+\.[\w.]{2,})\b/;

// Italian day abbreviations → English names used in OpeningHoursSpecification.
const IT_DAYS: Record<string, string> = {
  lun: 'Monday', mar: 'Tuesday', mer: 'Wednesday', gio: 'Thursday',
  ven: 'Friday', sab: 'Saturday', dom: 'Sunday',
};
const EN_DAYS: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_MAP: Record<string, string> = { ...EN_DAYS, ...IT_DAYS };

// Expand a compact day range ("Mon-Fri", "Lun–Ven", "Mon", "Lun") → an array of day name strings.
// Returns [] when the token does not look like a day name or range.
function expandDays(token: string): string[] {
  const parts = token.trim().split(/[-–]/).map((p) => p.trim().toLowerCase().slice(0, 3));
  if (!parts.length || !DAY_MAP[parts[0]]) return [];
  if (parts.length === 1) return [DAY_MAP[parts[0]]];
  // range: from…to (inclusive), wrapping around Sun if needed
  const from = ALL_DAYS.indexOf(DAY_MAP[parts[0]]);
  const to = parts[1] && DAY_MAP[parts[1]] ? ALL_DAYS.indexOf(DAY_MAP[parts[1]]) : -1;
  if (from < 0 || to < 0) return DAY_MAP[parts[0]] ? [DAY_MAP[parts[0]]] : [];
  if (to >= from) return ALL_DAYS.slice(from, to + 1);
  // wrap (e.g. "Sat–Mon") — keep simple, just expand both ends
  return [...ALL_DAYS.slice(from), ...ALL_DAYS.slice(0, to + 1)];
}

// Parse a time token like "9:00", "09.00", "9", "21" → "HH:MM" or null.
function parseTime(t: string): string | null {
  const m = /^(\d{1,2})(?:[:.h](\d{2})?)?$/.exec(t.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Parse a single hours entry string such as:
//   "Mon-Fri 9:00-17:00"   "Lun–Ven 9–18"   "Tue–Sun 12–23"   "Sab 10:00-22.00"
//   "Mon 08:00–20:00, Tue–Fri 08:00–20:00"  (comma-joined entries handled at caller level)
// Returns an array of OpeningHoursSpecification objects (one per day-group).
function parseHoursEntry(entry: string): any[] {
  // each clause: <day-part> <time-range>
  // day-part: Day[-Day] (English or Italian abbreviations)
  // time-range: HH[:MM]-HH[:MM]  (dash or en-dash)
  const clauseRe = /((?:[A-Za-z]{2,3}[-–]?)+)\s+(\d{1,2}(?:[:.h]\d{2})?)\s*[-–]\s*(\d{1,2}(?:[:.h]\d{2})?)/g;
  const out: any[] = [];
  let m: RegExpExecArray | null;
  while ((m = clauseRe.exec(entry)) !== null) {
    const days = expandDays(m[1]);
    const opens = parseTime(m[2]);
    const closes = parseTime(m[3]);
    if (!days.length || !opens || !closes) continue;
    // schema.org allows one dayOfWeek array per spec — emit one spec per day name for maximum compatibility
    for (const day of days) {
      out.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: `https://schema.org/${day}`, opens, closes });
    }
  }
  return out;
}

// Walk an hours value from the site model — it may be a string, array of strings, or a plain object.
// Return [] (no guessing) when the data doesn't match any recognised shape.
function parseHoursValue(v: any): any[] {
  if (!v) return [];
  const raw = (typeof v === 'string') ? [v]
    : Array.isArray(v) ? v.filter((x) => typeof x === 'string')
    : (typeof v === 'object' && !Array.isArray(v)) ? Object.values(v).filter((x) => typeof x === 'string')
    : [];
  const specs: any[] = [];
  for (const entry of raw as string[]) {
    // each string may contain comma-separated clauses ("Mon-Fri 9-17, Sat 10-14")
    const clauses = entry.split(/,\s*/);
    for (const clause of clauses) specs.push(...parseHoursEntry(clause));
  }
  return specs;
}

// Walk a site model (params.site, as stored in the DB) and extract verifiable business facts that
// can enrich the LocalBusiness JSON-LD block. Only returns fields for which REAL data was found —
// absent data → absent fields (never invented). The caller feeds this into organizationLd.
// Data sources: brand fields (phone/email/address/hours) + any section that carries contact-like keys.
export function extractBusinessFacts(site: any): { telephone?: string; email?: string; address?: any; openingHours?: any[] } {
  if (!site || typeof site !== 'object') return {};
  const result: { telephone?: string; email?: string; address?: any; openingHours?: any[] } = {};

  // collect candidate phone/email/hours/address strings from multiple locations in the site model:
  // brand fields first (highest authority), then each page's sections (section-level contact data).
  const brand: any = (site.brand && typeof site.brand === 'object') ? site.brand : {};
  const pages: any[] = Array.isArray(site.pages) ? site.pages : [];

  // helper: look up a field from an object by a list of possible key names
  const pick = (obj: any, ...keys: string[]): string | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };

  // TELEPHONE — try brand first, then walk section content
  const rawPhone = pick(brand, 'phone', 'telephone', 'tel')
    || (() => {
      for (const page of pages) {
        for (const sec of (Array.isArray(page.sections) ? page.sections : [])) {
          const found = pick(sec, 'phone', 'telephone', 'tel') || pick(sec.content, 'phone', 'telephone', 'tel');
          if (found) return found;
        }
      }
      return undefined;
    })();
  if (rawPhone) {
    const m = PHONE_RE.exec(rawPhone);
    if (m) result.telephone = m[1].replace(/[\s.\-()]/g, (c) => c === '+' ? '+' : '').replace(/\s+/g, ' ').trim();
    // keep original when regex would strip too much (international + number with spaces is valid)
    if (!result.telephone) result.telephone = rawPhone.trim().slice(0, 30);
  }

  // EMAIL
  const rawEmail = pick(brand, 'email', 'contact_email', 'contactEmail')
    || (() => {
      for (const page of pages) {
        for (const sec of (Array.isArray(page.sections) ? page.sections : [])) {
          const found = pick(sec, 'email', 'contact_email') || pick(sec.content, 'email', 'contact_email');
          if (found) return found;
        }
      }
      return undefined;
    })();
  if (rawEmail) {
    const m = EMAIL_RE.exec(rawEmail);
    if (m) result.email = m[1];
  }

  // ADDRESS — look for a PostalAddress-shaped object, or street+city pair as separate fields.
  // Schema.org PostalAddress: streetAddress, addressLocality, addressCountry
  const rawAddr = brand.address || brand.postal_address || (() => {
    for (const page of pages) {
      for (const sec of (Array.isArray(page.sections) ? page.sections : [])) {
        const a = sec.address || (sec.content && sec.content.address);
        if (a) return a;
      }
    }
    return undefined;
  })();
  if (rawAddr && typeof rawAddr === 'object') {
    const street = pick(rawAddr, 'streetAddress', 'street', 'street_address', 'via');
    const city = pick(rawAddr, 'addressLocality', 'city', 'locality', 'città');
    const country = pick(rawAddr, 'addressCountry', 'country');
    if (street || city) {
      result.address = clean({ '@type': 'PostalAddress', streetAddress: street, addressLocality: city, addressCountry: country });
    }
  } else if (typeof rawAddr === 'string' && rawAddr.trim()) {
    // a raw "Via Roma 1, Napoli" string — street is before the last comma, city after
    const parts = rawAddr.trim().split(',');
    if (parts.length >= 2) {
      result.address = clean({ '@type': 'PostalAddress', streetAddress: parts.slice(0, -1).join(',').trim(), addressLocality: parts[parts.length - 1].trim() });
    } else {
      result.address = clean({ '@type': 'PostalAddress', streetAddress: rawAddr.trim() });
    }
  } else {
    // no address object — try street + city as separate brand fields
    const street = pick(brand, 'street', 'street_address', 'via');
    const city = pick(brand, 'city', 'locality', 'città');
    if (street || city) {
      result.address = clean({ '@type': 'PostalAddress', streetAddress: street, addressLocality: city, addressCountry: pick(brand, 'country') });
    }
  }

  // OPENING HOURS — brand.hours or brand.opening_hours or section content
  const rawHours = brand.hours || brand.opening_hours || brand.openingHours
    || (() => {
      for (const page of pages) {
        for (const sec of (Array.isArray(page.sections) ? page.sections : [])) {
          const h = sec.hours || sec.opening_hours || sec.openingHours
            || (sec.content && (sec.content.hours || sec.content.opening_hours));
          if (h) return h;
        }
      }
      return undefined;
    })();
  if (rawHours != null) {
    const specs = parseHoursValue(rawHours);
    if (specs.length) result.openingHours = specs;
  }

  return result;
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

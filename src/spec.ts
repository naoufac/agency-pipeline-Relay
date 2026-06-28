// src/spec.ts — the VALIDATED BUILD-SPEC CONTRACT (R1, from the Fable/Opus review).
// ONE deterministic boundary between the build agent's JSON spec and the renderer:
//   validate -> normalize -> repair known-bad shapes -> DROP the invalid -> REJECT the unfixable.
// This is "fix the generator + add a gate" applied to our OWN internals. Once a spec passes here the
// renderer can TRUST its input, so the scattered defensive patches (CTA object->text, collection
// table fallback, the runner's inline ">=2 sections" check + primaryTable injection) live in ONE place.
// Rejections feed the existing retry-with-feedback loop (the agent is told exactly what was wrong).
//
// Pure, synchronous, side-effect-free -> trivially unit-testable (see spec-test.ts / `npm run spec:check`).

export type SpecCtx = { slug?: string; tables?: string[]; forms?: Record<string, any[]>; primaryTable?: string };
export type SpecResult = { spec: any; repairs: string[]; errors: string[] };

// Extract the FIRST complete JSON object from an agent's text. STRING-AWARE: braces inside string
// values (and escaped quotes) don't desync the matcher — the old naive counter mis-parsed any copy
// containing a "{" or "}". Returns null if no balanced object parses (e.g. a truncated reply).
export function extractFirstJson(s: string): any {
  if (!s) return null;
  const t = s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const a = t.indexOf('{'); if (a < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = a; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      if (--depth === 0) {
        const slice = t.slice(a, i + 1);
        try { return JSON.parse(slice); } catch { /* fall through to lenient repair */ }
        // common LLM defects that strict JSON rejects: INVALID backslash escapes (\', \x, …) and trailing
        // commas. Strip any backslash NOT starting a valid JSON escape ("\\ / b f n r t u); keep real ones.
        try { return JSON.parse(slice.replace(/\\(?!["\\/bfnrtu])/g, '').replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
      }
    }
  }
  return null;
}

// the ONLY section types the renderer knows — mirror of SECTIONS in components.ts. Keep in sync.
const KNOWN = new Set(['hero', 'features', 'split', 'gallery', 'cta', 'pricing', 'testimonials', 'faq', 'stats', 'collection', 'feed', 'form']);
const CATALOG_PAGE = /^(index|home|shop|store|products?|listings?|menu|catalog|browse|directory|gallery|work)$/;

const str = (v: any): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const nonEmpty = (v: any) => str(v).length > 0;

// A CTA may arrive as a string OR an object ({text|label|title|cta|name, link|href|url|page}).
// Normalize to a plain string label on `.cta` (+ optional `.link`) so the renderer never sees [object Object].
function normCta(s: any): void {
  if (s.cta == null) { return; }
  if (typeof s.cta === 'object') {
    const o: any = s.cta;
    const t = str(o.text ?? o.label ?? o.title ?? o.cta ?? o.name);
    const link = o.link ?? o.href ?? o.url ?? o.page;
    if (t) { s.cta = t; if (link != null && s.link == null) s.link = link; }
    else delete s.cta;
  } else if (!nonEmpty(s.cta)) {
    delete s.cta;
  } else {
    s.cta = str(s.cta);
  }
}

// keep only array entries that carry real content in at least one of `keys`
function cleanItems(arr: any, keys: string[]): any[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter((it: any) => it && typeof it === 'object' && keys.some(k => nonEmpty(it[k])));
}

// returns the repaired section, or null to DROP it (with a reason pushed to `repairs`)
function repairSection(s: any, ctx: SpecCtx, repairs: string[]): any | null {
  if (!s || typeof s !== 'object' || !nonEmpty(s.type)) { repairs.push('dropped a section with no type'); return null; }
  const type = str(s.type).toLowerCase();
  if (!KNOWN.has(type)) { repairs.push(`dropped unknown section type "${type}"`); return null; }
  s.type = type;
  normCta(s);
  switch (type) {
    case 'hero':
      if (!nonEmpty(s.headline)) { repairs.push('dropped hero with no headline'); return null; }
      break;
    case 'cta':
      if (!nonEmpty(s.headline)) { repairs.push('dropped cta band with no headline'); return null; }
      break;
    case 'features':
      s.items = cleanItems(s.items, ['title', 'body']);
      if (s.items.length < 1) { repairs.push('dropped features with no items'); return null; }
      break;
    case 'testimonials':
      s.items = cleanItems(s.items, ['quote', 'name']);
      if (s.items.length < 1) { repairs.push('dropped testimonials with no items'); return null; }
      break;
    case 'faq':
      s.items = cleanItems(s.items, ['q', 'a']);
      if (s.items.length < 1) { repairs.push('dropped faq with no items'); return null; }
      break;
    case 'stats':
      s.items = cleanItems(s.items, ['value', 'label']);
      if (s.items.length < 1) { repairs.push('dropped stats with no items'); return null; }
      break;
    case 'pricing':
      s.plans = cleanItems(s.plans, ['name', 'price']);
      if (s.plans.length < 1) { repairs.push('dropped pricing with no plans'); return null; }
      break;
    case 'gallery':
      s.images = Array.isArray(s.images) ? s.images.filter(nonEmpty) : [];
      if (s.images.length < 1) { repairs.push('dropped gallery with no images'); return null; }
      break;
    case 'split':
      if (!nonEmpty(s.title) && !nonEmpty(s.body)) { repairs.push('dropped split with no title/body'); return null; }
      break;
    case 'collection': {
      // resolve against the project's REAL tables; fall back to the primary catalog table; else DROP
      // (a collection with no real table can only render empty — that is slop, not a page).
      const tables = ctx.tables || [];
      const real = (t: any) => nonEmpty(t) && tables.length > 0 && tables.includes(str(t));
      if (real(s.table)) s.table = str(s.table);
      else if (real(ctx.primaryTable)) { repairs.push(`collection table "${str(s.table) || '∅'}" -> primary "${ctx.primaryTable}"`); s.table = ctx.primaryTable; }
      else { repairs.push(`dropped collection with no resolvable table ("${str(s.table) || '∅'}")`); return null; }
      break;
    }
    case 'form':
      // a form always works: contact bucket by default, or a typed table IF it really exists.
      if (nonEmpty(s.table) && ctx.forms && !ctx.forms[str(s.table)]) { repairs.push(`form table "${str(s.table)}" not real -> contact bucket`); delete s.table; }
      break;
    case 'feed':
      break;  // reads public submissions; renderer defaults the form name to "listing"
  }
  return s;
}

// THE CONTRACT. Always returns a result; `errors.length > 0` means REJECT (caller throws -> retry-with-feedback).
export function normalizeSpec(raw: any, ctx: SpecCtx = {}): SpecResult {
  const repairs: string[] = []; const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { spec: null, repairs, errors: ['spec is not a JSON object'] };

  // ---- brand ----
  const brand: any = (raw.brand && typeof raw.brand === 'object' && !Array.isArray(raw.brand)) ? raw.brand : {};
  if (!nonEmpty(brand.name)) { brand.name = 'Studio'; repairs.push('brand.name missing -> "Studio"'); } else brand.name = str(brand.name);
  { const h: any = { cta: brand.cta, link: brand.ctaLink }; normCta(h); if (h.cta) { brand.cta = h.cta; if (h.link != null) brand.ctaLink = h.link; } else delete brand.cta; }
  if (!brand.tokens || typeof brand.tokens !== 'object' || Array.isArray(brand.tokens)) brand.tokens = {};  // render derives the WCAG-safe palette from whatever's here

  // ---- sections: repair/drop each ----
  const sections: any[] = Array.isArray(raw.sections) ? raw.sections.map((s: any) => repairSection(s, ctx, repairs)).filter(Boolean) : [];

  // GUARANTEE the catalog shows: on a main/catalog page, ensure a collection on the primary table.
  if (nonEmpty(ctx.primaryTable) && CATALOG_PAGE.test(str(ctx.slug))) {
    if (!sections.some((x) => x.type === 'collection' && x.table === ctx.primaryTable)) {
      sections.splice(Math.min(1, sections.length), 0, { type: 'collection', title: 'Browse', intro: '', table: ctx.primaryTable });
      repairs.push(`injected collection on primary table "${ctx.primaryTable}"`);
    }
  }

  // INVARIANT: every page opens with a hero. If one exists but isn't first, move it up.
  const hi = sections.findIndex((s) => s.type === 'hero');
  if (hi > 0) { const [h] = sections.splice(hi, 1); sections.unshift(h); repairs.push('moved hero to the top'); }

  // ---- REJECT the unfixable (this is what feeds retry-with-feedback) ----
  if (sections.length < 2) errors.push(`only ${sections.length} valid section(s) after repair (need >= 2)`);
  if (!sections.length || sections[0].type !== 'hero') errors.push('no valid hero (every page must open with a hero that has a headline)');

  return { spec: { brand, sections }, repairs, errors };
}

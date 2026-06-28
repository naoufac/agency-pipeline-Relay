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

// CONTENT-dept normaliser (R3): the content role serves TWO shapes (IA sitemap + page copy) under one
// department, and the model sometimes violates "one JSON object" by emitting two concatenated blocks — or
// puts a stray { } inside a copy string, which the json verify gate's naive brace counter can't parse.
// normalizeContent recovers BOTH: string-aware first pass, then a flat-merge of concatenated objects.
export type ContentResult = { ok: true; spec: any; repairs: string[] } | { ok: false; errors: string[] };
export function normalizeContent(raw: string): ContentResult {
  const repairs: string[] = []; const errors: string[] = [];
  if (!raw) { errors.push('empty content output'); return { ok: false, errors }; }
  // first pass: standard extractFirstJson
  const first = extractFirstJson(raw);
  if (first !== undefined && first !== null) return { ok: true, spec: first, repairs: [] };
  // second pass: try to merge two concatenated objects
  const blocks: any[] = [];
  const re = /\{[^{}]*\}/g;  // naive — top-level only
  let m; while ((m = re.exec(raw)) !== null) { try { blocks.push(JSON.parse(m[0])); } catch {} }
  if (blocks.length === 0) { errors.push('no valid JSON object in content output'); return { ok: false, errors }; }
  // merge if multiple
  if (blocks.length > 1) {
    repairs.push(`merged ${blocks.length} concatenated JSON objects`);
    const merged: any = {};
    for (const b of blocks) {
      if (b && typeof b === 'object') Object.assign(merged, b);
    }
    return { ok: true, spec: merged, repairs };
  }
  errors.push('content output has braces but no valid object');
  return { ok: false, errors };
}

// DATABASE-dept normaliser (R7): the database role emits a JSON DATA MODEL {entities:[{name,fields,seed}]}
// that appdb.provision() COMPILES into real Postgres. Two recurring model defects break provisioning, and
// the autopsy (a94d539a) shows BOTH in the same project across retries:
//   - "appdb: no tables in the data model" — the JSON is truncated / fenced / emitted as TWO concatenated
//     blocks, so schema.parseModel (indexOf{ .. lastIndexOf}) can't parse it -> no entities[] -> no DDL.
//   - "integer out of range" — a seed integer (e.g. a One Piece bounty 3_989_000_000) exceeds PG INT4.
// normalizeDataModel recovers the model (string-aware first object, then a tables->entities coercion, then
// a concatenated-blocks fallback) and CLAMPS oversized seed integers into INT4 range, or REJECTS the
// unfixable (truncated) into the existing retry-with-feedback loop. Same shape as normalizeContent (R3).
export type DataModelResult = { ok: true; model: any; repairs: string[] } | { ok: false; errors: string[] };
export function normalizeDataModel(raw: string): DataModelResult {
  const repairs: string[] = []; const errors: string[] = [];
  if (!raw) { errors.push('empty database output'); return { ok: false, errors }; }
  // first pass: the FIRST complete, balanced JSON object (string-aware; survives fences + a trailing block).
  const first = extractFirstJson(raw);
  if (first && Array.isArray(first.entities)) return { ok: true, model: clampSeedPks(first, repairs), repairs };
  // first pass (coercion): the model used `tables:[...]` instead of `entities:[...]` — extractFirstJson
  // parses nested objects the regex fallback below cannot, so coerce here too.
  if (first && Array.isArray(first.tables)) {
    repairs.push('coerced: tables → entities');
    return { ok: true, model: clampSeedPks({ ...first, entities: first.tables }, repairs), repairs };
  }
  // second pass: scan top-level blocks and take the first that carries a real model (concatenated output).
  const blocks: any[] = [];
  const re = /\{[^{}]*\}/g;
  let m; while ((m = re.exec(raw)) !== null) { try { blocks.push(JSON.parse(m[0])); } catch {} }
  const withEntities = blocks.find(b => b && Array.isArray(b.entities));
  if (withEntities) {
    repairs.push('merged: extracted entities from concatenated blocks');
    return { ok: true, model: clampSeedPks(withEntities, repairs), repairs };
  }
  // third pass: a concatenated block that used `tables:[...]` instead of `entities:[...]`.
  const withTables = blocks.find(b => b && Array.isArray(b.tables));
  if (withTables) {
    repairs.push('coerced: tables → entities');
    return { ok: true, model: clampSeedPks({ ...withTables, entities: withTables.tables }, repairs), repairs };
  }
  errors.push('database output has no entities[] or coercible tables[]');
  return { ok: false, errors };
}

// CLAMP every seed integer into PostgreSQL INT4 range (max 2,147,483,647) so a giant real-world value (a
// bounty, a population) can't fail provisioning with "integer out of range". Floats (money/prices) are
// left untouched. Each clamp is recorded as a repair so the runner can log what it changed.
const INT4_MAX = 2_147_483_647;
function clampSeedPks(model: any, repairs: string[] = []): any {
  for (const e of model.entities || []) {
    for (const s of e.seed || []) {
      if (!s || typeof s !== 'object') continue;
      for (const k of Object.keys(s)) {
        const v = s[k];
        if (typeof v === 'number' && Number.isInteger(v) && v > INT4_MAX) {
          s[k] = Math.floor(v % INT4_MAX);
          repairs.push(`clamped seed ${e.name ?? '?'}.${k} ${v} → ${s[k]} (int4)`);
        }
      }
    }
  }
  return model;
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

// ---- project-wide BRAND LOCK ----
// Every page is built by a separate agent call, so each invents its own brand name + colours -> the
// logo and palette drift page to page. Fix: the FIRST page locks a canonical brand; every page renders
// with it. brandIdentity() extracts it from a spec; applyBrand() forces a spec to use the canonical one.
export type Brand = { name: string; cta: string | null; tokens: any };
export function brandIdentity(spec: any): Brand {
  const b = (spec && spec.brand && typeof spec.brand === 'object') ? spec.brand : {};
  return {
    name: (typeof b.name === 'string' && b.name.trim()) ? b.name.trim() : 'Studio',
    cta: (typeof b.cta === 'string' && b.cta.trim()) ? b.cta.trim() : null,
    tokens: (b.tokens && typeof b.tokens === 'object' && !Array.isArray(b.tokens)) ? b.tokens : {},
  };
}
// Last-resort palette — only used if a canonical brand somehow carries no tokens. Never the page's own.
const DEFAULT_TOKENS = { bg: '#ffffff', primary: '#4f46e5' };
export function applyBrand(spec: any, canon: Brand): void {
  if (!spec.brand || typeof spec.brand !== 'object') spec.brand = {};
  spec.brand.name = canon.name;                                            // identical logo on every page
  // FORCE the nav button label + DROP any per-page ctaLink so its target is resolved deterministically from
  // the (now identical) label + shared page list — the whole nav is the same on every page, not just the logo.
  if (canon.cta) { spec.brand.cta = canon.cta; delete spec.brand.ctaLink; }
  // FORCE the palette unconditionally — the renderer reads spec.brand.tokens, so a page must NEVER keep its
  // own invented colours. canon.tokens is guaranteed complete by resolveBrand(); DEFAULT_TOKENS is a floor so
  // an empty canon can't open a leak. This is what makes "one palette per site" a guarantee, not a request.
  spec.brand.tokens = (canon.tokens && Object.keys(canon.tokens).length) ? canon.tokens : { ...DEFAULT_TOKENS };
}

// The ONE nav button for the whole site, chosen deterministically from the archetype (no per-page LLM label).
export function navCtaFor(archetype?: string): string {
  const a = String(archetype || 'site').toLowerCase();
  return a === 'store' ? 'Shop now' : a === 'app' ? 'Get started' : 'Get in touch';
}

// THE single deterministic site identity, derived ONLY from the Branding department's output (the one
// upstream source every page build shares). ALWAYS returns a COMPLETE palette (bg + primary at minimum) so
// applyBrand() can force it onto every page. No LLM trust, no per-page fallback. Pure + unit-tested.
export function resolveBrand(brandingContent: string, fallbackName = 'Studio', archetype?: string): Brand {
  let o: any = null;
  try { o = extractFirstJson(brandingContent); } catch {}
  const isHex = (v: any) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim());
  const p = (o && (o.palette || o)) || {};
  const name = (o && typeof o.name === 'string' && o.name.trim()) ? o.name.trim() : (fallbackName || 'Studio');
  const bg = isHex(p.bg) ? p.bg.trim() : DEFAULT_TOKENS.bg;
  const primary = isHex(p.primary) ? p.primary.trim()
    : isHex(p.accent) ? p.accent.trim()
    : isHex(p.text) ? p.text.trim() : DEFAULT_TOKENS.primary;
  const tokens: any = { bg, primary };
  if (isHex(p.accent)) tokens.accent = p.accent.trim();
  return { name, cta: navCtaFor(archetype), tokens };
}

// ---- SITE MODEL (the CMS): ONE composition for the WHOLE website ----
// The site is generated ONCE as a single model — every page's sections in one object — instead of one LLM
// call per page. brand/theme/nav are single sources owned elsewhere (branding lock + planner). normalizeSite
// validates the composed model against the planner's page list: every declared page must be present and pass
// the per-page spec contract (hero-first, >=2 real sections, catalog injection). Pages render deterministically
// from this. Returns the normalized pages, or REJECTS the unfixable into retry-with-feedback.
export type SiteResult = { site: { pages: { slug: string; title: string; sections: any[] }[] }; repairs: string[]; errors: string[] };
export function normalizeSite(raw: any, pages: { slug: string; title: string }[], base: { tables?: string[]; forms?: Record<string, any[]>; primaryTable?: string } = {}): SiteResult {
  const repairs: string[] = []; const errors: string[] = [];
  const out: { slug: string; title: string; sections: any[] }[] = [];
  const rawPages: any[] = (raw && Array.isArray(raw.pages)) ? raw.pages : [];
  if (!rawPages.length) { errors.push('site model has no pages[]'); return { site: { pages: [] }, repairs, errors }; }
  const bySlug = new Map<string, any>();
  for (const p of rawPages) { const s = str(p && p.slug).toLowerCase(); if (s) bySlug.set(s, p); }
  for (const pg of (pages || [])) {
    const composed = bySlug.get(pg.slug.toLowerCase())
      || rawPages.find((p: any) => str(p.title).toLowerCase() === pg.title.toLowerCase());
    if (!composed) { errors.push(`page "${pg.slug}" missing from the composed site model`); continue; }
    const { spec, repairs: r, errors: e } = normalizeSpec({ sections: composed.sections }, { slug: pg.slug, tables: base.tables, forms: base.forms, primaryTable: base.primaryTable });
    for (const x of r) repairs.push(`${pg.slug}: ${x}`);
    if (e.length) { errors.push(`page "${pg.slug}": ${e.join('; ')}`); continue; }
    out.push({ slug: pg.slug, title: pg.title, sections: spec.sections });
  }
  if (out.length < (pages || []).length) errors.push(`only ${out.length}/${(pages || []).length} pages composed cleanly`);
  return { site: { pages: out }, repairs, errors };
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

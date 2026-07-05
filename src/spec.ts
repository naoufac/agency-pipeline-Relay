// src/spec.ts — the VALIDATED BUILD-SPEC CONTRACT (R1, from the Fable/Opus review).
// ONE deterministic boundary between the build agent's JSON spec and the renderer:
//   validate -> normalize -> repair known-bad shapes -> DROP the invalid -> REJECT the unfixable.
// This is "fix the generator + add a gate" applied to our OWN internals. Once a spec passes here the
// renderer can TRUST its input, so the scattered defensive patches (CTA object->text, collection
// table fallback, the runner's inline ">=2 sections" check + primaryTable injection) live in ONE place.
// Rejections feed the existing retry-with-feedback loop (the agent is told exactly what was wrong).
//
// Pure, synchronous, side-effect-free -> trivially unit-testable (see spec-test.ts / `npm run spec:check`).

import { PRIVATE_READ } from './schema.ts';   // FS0: visitor-record tables are never publicly rendered
import { isTheme, paletteFor } from './themes.ts';   // PQ1: brand palettes come from the theme pool, never LLM whim

export type SpecCtx = { slug?: string; tables?: string[]; forms?: Record<string, any[]>; primaryTable?: string; actionTable?: string };

// FS4 — a data-archetype model must contain the app's CORE: at least one real, fillable entity
// beyond identity plumbing (users/clients/accounts/sessions). Truncation once ate 'deliveries' and
// a delivery app shipped as a sign-up shell that passed review — a gutted model rejects into retry.
export function modelHasCore(model: any): boolean {
  return ((model && model.entities) || []).some((e: any) =>
    Array.isArray(e?.fields) && e.fields.length >= 2 &&
    !/^(_relay_\w+|users?|accounts?|sessions?|tokens?|customers?|clients?|profiles?)$/i.test(String(e?.name || '').trim()));
}

// FS1 — which tables may the PUBLIC write? Exactly the ones the composed site model targets with a
// form section, nothing else (a produced app's catalog is the owner's — a visitor must never be able
// to insert services/products through the raw data API). Pure; the server route enforces it.
export function publicWriteTables(site: any): string[] {
  const out = new Set<string>();
  for (const p of ((site && site.pages) || []))
    for (const s of (p.sections || []))
      if (s && s.type === 'form' && typeof s.table === 'string' && s.table.trim()) out.add(s.table.trim());
  return [...out];
}
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

// A REQUIRED ref from a visitor-writable entity into a PUBLIC catalog entity with NO seed rows is
// unbuildable: the form renders a required dropdown with nothing to offer and the core action can
// never submit (a real law build shipped empty `attorneys`/`services` and failed its own form).
// Rejecting here feeds the existing retry-with-feedback loop, where the model adds real seeds.
// (Refs into PRIVATE targets are separately forced nullable + hidden by the schema compiler.)
function unseededRequiredRefs(model: any): string[] {
  const errs: string[] = [];
  const sn = (v: any) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const ents: any[] = Array.isArray(model?.entities) ? model.entities : [];
  const byName = new Map(ents.map((e: any) => [sn(e?.name), e]));
  for (const e of ents) {
    if (!PRIVATE_READ.test(sn(e?.name))) continue;
    for (const f of (e?.fields || [])) {
      const refSpec = f?.ref || (typeof f?.type === 'string' && /^ref:/i.test(f.type) ? f.type.slice(4) : null);
      if (!refSpec || !f?.required) continue;
      const target = byName.get(sn(refSpec));
      if (!target || PRIVATE_READ.test(sn(target?.name))) continue;
      if (!Array.isArray(target.seed) || target.seed.length === 0)
        errs.push(`"${target.name}" has NO seed rows but the visitor form requires it ("${e.name}.${f.name}") — the dropdown would have nothing to offer; seed 3-6 realistic ${target.name}`);
    }
  }
  return errs;
}

// FS5 floor — booking time is ONE timestamp field, never a slot-inventory table: a barbershop model
// shipped time_slots rows + an FK, and hour-level availability went blind (the system computes
// availability itself; a slots table is the LLM re-implementing the system, badly).
function slotInventoryErrors(model: any): string[] {
  const sn = (v: any) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const ents: any[] = Array.isArray(model?.entities) ? model.entities : [];
  return ents.filter((e: any) => /^(time_?slots?|slots)$/.test(sn(e?.name)))
    .map((e: any) => `entity "${e.name}" is a slot-inventory table — do NOT model available times as rows. Put ONE timestamp field on the booking entity itself (e.g. appointment_at, type datetime); the system computes availability from it`);
}

// PQ2 · a store must be able to SELL every product: each product needs a price of its own OR at
// least one PRICED variant (compile backfills from the cheapest). A priceless product = a card
// with no Add-to-cart — a real canary build failed review exactly this way.
function pricelessProductErrors(model: any): string[] {
  const sn = (v: any) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const ents: any[] = Array.isArray(model?.entities) ? model.entities : [];
  const prods = ents.find((e: any) => sn(e?.name) === 'products');
  const va = ents.find((e: any) => /^(product_)?variants$/.test(sn(e?.name)));
  if (!prods || (prods.fields || []).some((f: any) => /^(price|amount|cost)$/.test(sn(f?.name)))) return [];
  // only SELLING shapes need prices — a products showcase (no orders, no variants) is honest without
  const sellsy = !!va || ents.some((e: any) => sn(e?.name) === 'orders');
  if (!sellsy) return [];
  if (!va) return ['entity "products" has no price field — add one (type: money) and price every seed'];
  const vseeds: any[] = va.seed || [];
  const bad = (prods.seed || []).map((row: any, i: number) => ({ row, i }))
    .filter(({ i }) => !vseeds.some((v: any) => Number(v?.product ?? v?.product_id) === i + 1 && Number(v?.price) > 0))
    .map(({ row, i }) => String(row?.title || row?.name || '#' + (i + 1)));
  return bad.length ? [`products ${bad.join(', ')} have NO price anywhere — give the product a price field, or give at least one of its variants a price`] : [];
}

// a PUBLIC catalog table (products/services/menu…) with ZERO seeds launches a hollow site —
// an empty grid that a review can miss (M3 flight 2026-07-05 shipped a barbershop with no
// barbers). The floor: catalog-ish public tables must carry seeds; the LLM retries with this.
const CATALOG_TABLE = /product|service|dish|menu_item|menu|item|treatment|class|course|package|offering|scent|flavor|listing/i;
export function catalogSeedErrors(ents: any[]): string[] {
  const out: string[] = [];
  for (const e of (ents || [])) {
    if (!e || e.public !== true || !CATALOG_TABLE.test(String(e.name || ''))) continue;
    if (!Array.isArray(e.seed) || e.seed.length === 0)
      out.push(`public catalog "${e.name}" has NO seed rows — a live site must not launch empty; seed 4-8 realistic rows`);
  }
  return out;
}

export function normalizeDataModel(raw: string, archetype?: string): DataModelResult {
  const repairs: string[] = []; const errors: string[] = [];
  if (!raw) { errors.push('empty database output'); return { ok: false, errors }; }
  // every recovery path funnels here: clamp seeds, canonicalize the store contract, then reject
  // the unbuildable shapes into retry
  const finish = (m: any): DataModelResult => {
    const model = clampSeedPks(m, repairs);
    // A STORE model must be able to STORE ORDERS — a canary build shipped only catalog tables
    // (categories/products/variants) and its checkout had nowhere to write. The canonical selling
    // tables are fully deterministic, so a missing one is INJECTED, never a retry.
    if (archetype === 'store' && Array.isArray(model?.entities)) {
      const sn = (v: any) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const has = (n: string) => model.entities.some((e: any) => sn(e?.name) === n);
      if (has('products') && !has('orders')) {
        model.entities.push({ name: 'orders', fields: [
          { name: 'customer_name', type: 'text', required: true }, { name: 'email', type: 'email' },
          { name: 'phone', type: 'text' }, { name: 'notes', type: 'text' },
          { name: 'status', type: 'status' }, { name: 'total', type: 'money' }] });
        repairs.push('injected canonical orders (a store must be able to store orders)');
      }
      if (has('products') && !has('order_items')) {
        model.entities.push({ name: 'order_items', fields: [
          { name: 'order', type: 'ref:orders', required: true }, { name: 'product', type: 'ref:products', required: true },
          { name: 'qty', type: 'int', required: true }, { name: 'unit_price', type: 'money' }] });
        repairs.push('injected canonical order_items');
      }
    }
    const errs = [...unseededRequiredRefs(model), ...slotInventoryErrors(model), ...pricelessProductErrors(model), ...catalogSeedErrors((model as any).entities || [])];
    return errs.length ? { ok: false, errors: errs } : { ok: true, model, repairs };
  };
  // first pass: the FIRST complete, balanced JSON object (string-aware; survives fences + a trailing block).
  const first = extractFirstJson(raw);
  if (first && Array.isArray(first.entities)) return finish(first);
  // first pass (coercion): the model used `tables:[...]` instead of `entities:[...]` — extractFirstJson
  // parses nested objects the regex fallback below cannot, so coerce here too.
  if (first && Array.isArray(first.tables)) {
    repairs.push('coerced: tables → entities');
    return finish({ ...first, entities: first.tables });
  }
  // second pass: scan top-level blocks and take the first that carries a real model (concatenated output).
  const blocks: any[] = [];
  const re = /\{[^{}]*\}/g;
  let m; while ((m = re.exec(raw)) !== null) { try { blocks.push(JSON.parse(m[0])); } catch {} }
  const withEntities = blocks.find(b => b && Array.isArray(b.entities));
  if (withEntities) {
    repairs.push('merged: extracted entities from concatenated blocks');
    return finish(withEntities);
  }
  // third pass: a concatenated block that used `tables:[...]` instead of `entities:[...]`.
  const withTables = blocks.find(b => b && Array.isArray(b.tables));
  if (withTables) {
    repairs.push('coerced: tables → entities');
    return finish({ ...withTables, entities: withTables.tables });
  }
  // fourth pass (TRUNCATION recovery): a max_tokens cut mid-model leaves one unbalanced object whose
  // LEADING entities are complete (seen live: a big delivery model — users/deliveries/shipments/
  // tracking — arrived valid but unterminated and was rejected wholesale). Salvage every balanced
  // entity object and build with those; the missing tail is recoverable by M3 migration on a rebuild.
  const entKey = raw.indexOf('"entities"');
  const arrStart = entKey >= 0 ? raw.indexOf('[', entKey) : -1;
  if (arrStart > 0) {
    const ents: any[] = [];
    let i = arrStart + 1;
    while (i < raw.length) {
      const objStart = raw.indexOf('{', i);
      if (objStart < 0) break;
      let depth = 0, j = objStart, inStr = false, escd = false;
      for (; j < raw.length; j++) {
        const ch = raw[j];
        if (inStr) { if (escd) escd = false; else if (ch === '\\') escd = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) break;   // cut mid-object — keep only the complete ones before it
      try { const o = JSON.parse(raw.slice(objStart, j + 1)); if (o && o.name && Array.isArray(o.fields)) ents.push(o); } catch {}
      i = j + 1;
    }
    if (ents.length) {
      repairs.push(`recovered ${ents.length} complete entities from a truncated model`);
      return finish({ entities: ents } as any);
    }
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
const KNOWN = new Set(['hero', 'features', 'split', 'gallery', 'cta', 'pricing', 'testimonials', 'faq', 'stats', 'collection', 'feed', 'form', 'logos', 'offer', 'products', 'cart', 'checkout']);
const CATALOG_PAGE = /^(index|home|shop|store|products?|listings?|menu|catalog|browse|directory|gallery|work)$/;

const str = (v: any): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const nonEmpty = (v: any) => str(v).length > 0;
const humanTitle = (t: string) => str(t).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Register-aware catalog title: the injected section reads like the business, not like a webshop.
// Closed set keyed by the primary table; unknown tables humanize (practice_areas -> "Practice areas").
export function catalogTitle(table: string): string {
  const t = String(table || '').toLowerCase();
  const MAP: [RegExp, string][] = [
    [/^products?$/, 'Browse'],
    [/^services?$/, 'Our services'],
    [/^(menu(_items)?|dishes)$/, 'The menu'],
    [/^classes$/, 'Classes'],
    [/^rooms?$/, 'Rooms'],
    [/^(posts?|articles?|news)$/, 'Latest'],
    [/^listings?$/, 'Listings'],
    [/^events?$/, 'Upcoming events'],
    [/^(portfolio|projects?|work)$/, 'Selected work'],
    [/^(team|staff|barbers|stylists|attorneys|doctors)$/, 'The team'],
  ];
  for (const [re, title] of MAP) if (re.test(t)) return title;
  const h = t.replace(/_/g, ' ').trim();
  return h ? h.charAt(0).toUpperCase() + h.slice(1) : 'Browse';
}

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
    case 'logos':
      // social-proof band: plain text names (never external images — gate-safe by construction)
      s.items = Array.isArray(s.items) ? s.items.filter(nonEmpty).map(str) : [];
      if (s.items.length < 2) { repairs.push('dropped logos with <2 names'); return null; }
      break;
    case 'offer':
      // the conversion core of a landing page: deliverable + risk reversal + one action
      if (!nonEmpty(s.title)) { repairs.push('dropped offer with no title'); return null; }
      s.bullets = Array.isArray(s.bullets) ? s.bullets.filter(nonEmpty).map(str) : [];
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
      // FS0: a collection over a PRIVATE visitor-record table (bookings/orders/messages…) is a privacy
      // hole dressed as a feature — dropped, never rendered (the read API answers [] for it anyway).
      const tables = ctx.tables || [];
      const real = (t: any) => nonEmpty(t) && tables.length > 0 && tables.includes(str(t)) && !PRIVATE_READ.test(str(t));
      if (nonEmpty(s.table) && (ctx.tables || []).includes(str(s.table)) && PRIVATE_READ.test(str(s.table))) {
        repairs.push(`dropped collection over private table "${str(s.table)}" — visitor records are never publicly listed`); return null;
      }
      if (real(s.table)) s.table = str(s.table);
      else if (real(ctx.primaryTable)) { repairs.push(`collection table "${str(s.table) || '∅'}" -> primary "${ctx.primaryTable}"`); s.table = ctx.primaryTable; }
      else { repairs.push(`dropped collection with no resolvable table ("${str(s.table) || '∅'}")`); return null; }
      break;
    }
    case 'form':
      // M2: the LLM often names the table in "form" but omits "table" — bind it when it IS a real table.
      if (!nonEmpty(s.table) && nonEmpty(s.form) && ctx.tables && ctx.tables.includes(str(s.form))) {
        s.table = str(s.form); repairs.push(`form "${str(s.form)}" bound to its real table`);
      }
      // FS1: an UNBOUND form with ACTION intent (its copy or page says book/reserve/order/apply…)
      // binds to the schema's real action table — a booking form that writes to the contact bucket is
      // a broken product. Contact-intent forms stay contact (never hijacked into bookings).
      if (!nonEmpty(s.table) && nonEmpty(ctx.actionTable) && ctx.forms && ctx.forms[str(ctx.actionTable)]) {
        const intent = /book|reserv|appoint|order|apply|regist|join|rsvp|request|enrol|sign\s?up|schedul/i;
        if (intent.test(str(s.form)) || intent.test(str(s.title)) || intent.test(str(s.cta)) || intent.test(str(ctx.slug))) {
          s.table = str(ctx.actionTable);
          repairs.push(`action-intent form bound to the real action table "${s.table}"`);
        }
      }
      // a form always works: contact bucket by default, or a typed table IF it really exists.
      if (nonEmpty(s.table) && ctx.forms && !ctx.forms[str(s.table)]) { repairs.push(`form table "${str(s.table)}" not real -> contact bucket`); delete s.table; }
      break;
    case 'products': {
      // the shop grid must point at the real products table (or the primary catalog table)
      const tabs = ctx.tables || [];
      if (!nonEmpty(s.table) || !tabs.includes(str(s.table))) s.table = tabs.includes('products') ? 'products' : (ctx.primaryTable || 'products');
      break;
    }
    case 'cart':
    case 'checkout':
      break;  // fully deterministic components — copy fields only
    case 'feed':
      break;  // reads public submissions; renderer defaults the form name to "listing"
  }
  return s;
}

// ---- project-wide BRAND LOCK ----
// Every page is built by a separate agent call, so each invents its own brand name + colours -> the
// logo and palette drift page to page. Fix: the FIRST page locks a canonical brand; every page renders
// with it. brandIdentity() extracts it from a spec; applyBrand() forces a spec to use the canonical one.
export type Brand = { name: string; cta: string | null; tokens: any; design?: any };
export function brandIdentity(spec: any): Brand {
  const b = (spec && spec.brand && typeof spec.brand === 'object') ? spec.brand : {};
  return {
    name: (typeof b.name === 'string' && b.name.trim()) ? b.name.trim() : 'Studio',
    cta: (typeof b.cta === 'string' && b.cta.trim()) ? b.cta.trim() : null,
    tokens: (b.tokens && typeof b.tokens === 'object' && !Array.isArray(b.tokens)) ? b.tokens : {},
    // FIGMA → REALITY: an external design source rides on the brand so it's identical on every page
    design: (b.design && typeof b.design === 'object' && !Array.isArray(b.design)) ? b.design : undefined,
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
  if (canon.design) spec.brand.design = canon.design;   // the external design identity, identical per page
}

// DOMAINS — every produced site gets a first-level subdomain: <slug>.naples.agency. The slug is
// derived from the LOCKED brand name (never the LLM's whim twice), collision-safe via a suffix.
// Reserved names guard the platform's own hosts.
export const RESERVED_SLUGS = /^(board|api|email|cms|sites|www|mail|admin|app|status|relay|ns\d*|mx\d*|smtp|imap|pop3?|ftp|dev|staging|test)$/;
export function brandSlug(name: string): string {
  const s = String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return (!s || RESERVED_SLUGS.test(s)) ? (s ? s + '-site' : '') : s;
}

// The ONE nav button for the whole site, chosen deterministically from the archetype (no per-page LLM label).
export function navCtaFor(archetype?: string): string {
  const a = String(archetype || 'site').toLowerCase();
  return a === 'store' ? 'Shop now' : a === 'app' ? 'Get started' : 'Get in touch';
}

// THE single deterministic site identity, derived ONLY from the Branding department's output (the one
// upstream source every page build shares). ALWAYS returns a COMPLETE palette (bg + primary at minimum) so
// applyBrand() can force it onto every page. No LLM trust, no per-page fallback. Pure + unit-tested.
// PALETTE DISTINCTNESS (PQ1): when the caller passes the project's theme + brief, bg/primary come from
// the theme's hand-built BRAND POOL (brief-hash rotated, colour-word aware) — LLM-invented palettes
// CLUSTER (a law firm and a skate shop drew twin greens the same day). The LLM still names the brand
// and may propose an accent (the renderer AA-validates it); it never owns the identity colours.
// THE CLIENT NAMES THE BUSINESS — a brief that opens "Relay — an autonomous web agency…" or
// "Mario's Pizzeria — a family restaurant…" has STATED the name; the model may only style
// around it, never invent a new one (a real dogfood catch: the agency's own site shipped
// branded "Passa"). Conservative extraction: the leading Name-—-description pattern, valid
// only when every word is capitalized (so "A barbershop booking app — …" stays a sentence).
export function briefStatedName(brief: any): string | null {
  const m = String(brief || '').match(/^\s*([A-Za-z0-9][\w&'’.\- ]{0,40}?)\s+—\s+/u);
  if (!m) return null;
  const cand = m[1].trim();
  if (cand.length < 2 || cand.length > 40) return null;
  if (!/^([A-Z0-9][\w&'’.]*)( (?:[A-Z0-9&][\w&'’.]*|[&+]))*$/u.test(cand)) return null;   // every word capitalized = a NAME, not a sentence
  return cand;
}

export function resolveBrand(brandingContent: string, fallbackName = 'Studio', archetype?: string, theme?: string, brief?: string): Brand {
  let o: any = null;
  try { o = extractFirstJson(brandingContent); } catch {}
  const isHex = (v: any) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim());
  const p = (o && (o.palette || o)) || {};
  const stated = briefStatedName(brief);
  const name = stated || ((o && typeof o.name === 'string' && o.name.trim()) ? o.name.trim() : (fallbackName || 'Studio'));
  let bg: string, primary: string;
  if (isTheme(theme)) {
    const pal = paletteFor(theme, String(brief || ''));
    bg = pal.bg; primary = pal.primary;
  } else {
    bg = isHex(p.bg) ? p.bg.trim() : DEFAULT_TOKENS.bg;
    primary = isHex(p.primary) ? p.primary.trim()
      : isHex(p.accent) ? p.accent.trim()
      : isHex(p.text) ? p.text.trim() : DEFAULT_TOKENS.primary;
  }
  const tokens: any = { bg, primary };
  if (isHex(p.accent)) tokens.accent = p.accent.trim();
  return { name, cta: navCtaFor(archetype), tokens };
}

// ---- COPY-SPECIFICITY GATE (moved here from verify.ts so it can run at COMPOSE, the retryable stage) ----
// High-precision scan for UNAMBIGUOUS template slop — every pattern is residue that never appears in real
// marketing copy, so it can't false-fail genuine writing. Pure + exported (re-exported by verify.ts).
export function copySlop(html: string): string | null {
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const SLOP: [RegExp, string][] = [
    [/lorem ipsum|dolor sit amet/i, 'lorem ipsum filler'],
    [/\byour (tagline|headline|sub-?headline|company|business|brand|slogan|name|text|content|product|service)s? here\b/i, '"your … here" placeholder'],
    [/\b(tagline|headline|sub-?headline|content|copy|description|text|name|slogan)s? goes? here\b/i, '"… goes here" placeholder'],
    [/\b(insert|add|enter|type) (your |the )?(tagline|headline|name|text|content|copy|description|details|logo)\b[^.]{0,16}\bhere\b/i, '"insert … here" placeholder'],
    [/\{\{\s*[\w.]+\s*\}\}/, 'unrendered template token ({{…}})'],
    [/\b(todo|tbd|fixme)\b/i, 'TODO/TBD left in copy'],
    [/@example\.(com|org|net)\b/i, 'placeholder example.com email'],
    [/\bexample\.(com|org)\b/i, 'placeholder example.com link'],
  ];
  for (const [re, why] of SLOP) { const m = visible.match(re); if (m) return `${why}: "${m[0].trim().slice(0, 40)}"`; }
  return null;
}

// Deep-collect every copy string from a page's sections (headlines, bodies, items, plans, faqs, …).
function collectText(v: any, out: string[]): void {
  if (v == null) return;
  if (typeof v === 'string') { out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) collectText(x, out); return; }
  if (typeof v === 'object') { for (const k of Object.keys(v)) collectText(v[k], out); }
}
// Slop check for the COMPOSED site copy. CRITICAL: strip {{brand}} (and any {{…}}) first — those are the
// system's intended brand token, filled deterministically at render, NOT slop. Returns a reason, or null.
export function siteCopySlop(pages: { sections: any[] }[]): string | null {
  const out: string[] = [];
  for (const p of (pages || [])) collectText(p.sections, out);
  const text = out.join(' \n ').replace(/\{\{[^}]*\}\}/g, ' ');   // legit brand tokens are NOT slop
  const s = copySlop(text);
  if (s) return s;
  const ph = text.match(/\[[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}\]/);   // [Bracketed Placeholder]
  if (ph) return `unfilled placeholder "${ph[0]}"`;
  // PAYMENTS honesty: on pages that SELL (checkout/cart/products sections), copy must never promise
  // card processing the checkout does not provide ("We accept all major cards and PayPal" shipped on
  // a real store whose checkout takes payment instructions). A brick-and-mortar page may say it; a
  // selling page may not — the store's own words must match its own machinery.
  for (const p of (pages || [])) {
    if (!(p.sections || []).some((x: any) => ['checkout', 'cart', 'products'].includes(String(x?.type)))) continue;
    const pt: string[] = []; collectText(p.sections, pt);
    const lie = pt.join(' ').match(/\b(we )?accepts? [^.!?]{0,40}(credit cards?|debit cards?|major cards?|paypal|visa|mastercard|amex)|pay (securely )?(online )?(by|with) card/i);
    if (lie) return `selling page promises card processing the checkout does not provide: "${lie[0].trim().slice(0, 60)}" — describe the real flow (order now, pay per the payment instructions)`;
  }
  return null;
}

// ---- SITE MODEL (the CMS): ONE composition for the WHOLE website ----
// The site is generated ONCE as a single model — every page's sections in one object — instead of one LLM
// call per page. brand/theme/nav are single sources owned elsewhere (branding lock + planner). normalizeSite
// validates the composed model against the planner's page list: every declared page must be present and pass
// the per-page spec contract (hero-first, >=2 real sections, catalog injection). Pages render deterministically
// from this. Returns the normalized pages, or REJECTS the unfixable into retry-with-feedback.
export type SiteResult = { site: { pages: { slug: string; title: string; sections: any[] }[] }; repairs: string[]; errors: string[] };
export function normalizeSite(raw: any, pages: { slug: string; title: string }[], base: { tables?: string[]; forms?: Record<string, any[]>; primaryTable?: string; actionTable?: string; archetype?: string } = {}): SiteResult {
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
    const { spec, repairs: r, errors: e } = normalizeSpec({ sections: composed.sections }, { slug: pg.slug, tables: base.tables, forms: base.forms, primaryTable: base.primaryTable, actionTable: base.actionTable });
    for (const x of r) repairs.push(`${pg.slug}: ${x}`);
    if (e.length) { errors.push(`page "${pg.slug}": ${e.join('; ')}`); continue; }
    out.push({ slug: pg.slug, title: pg.title, sections: spec.sections });
  }
  if (out.length < (pages || []).length) errors.push(`only ${out.length}/${(pages || []).length} pages composed cleanly`);
  // GUARANTEE THE CORE ACTION (M2): an app/store site whose schema has a primary table MUST carry a
  // typed form somewhere — a booking/ordering app without its form is decoration. If the model forgot
  // one, inject it deterministically on the best-fitting page (never trust, always force).
  // FS1: the core action targets the ACTION table (the private visitor-record table — appointments/
  // orders/requests) when the schema has one; the catalog primary table is only the fallback. A
  // booking app whose "core action" adds catalog rows is a facade with extra steps.
  const at = str(base.actionTable);
  const pt = (at && base.forms && Array.isArray(base.forms[at]) && base.forms[at].length) ? at : str(base.primaryTable);
  if (pt && base.forms && Array.isArray(base.forms[pt]) && base.forms[pt].length && out.length) {
    const hasTypedForm = at
      ? out.some(p => p.sections.some((s: any) => s.type === 'form' && str(s.table) === at))
      : out.some(p => p.sections.some((s: any) => s.type === 'form' && nonEmpty(s.table)));
    // a STORE's core action is the CHECKOUT — relayCheckout writes the orders row server-side.
    // Injecting a raw "Orders" form next to a working cart+checkout stacked a second, uglier
    // way to buy onto the homepage (seen live on the hearth canary — a real drift catch).
    const checkoutCovers = /^orders?$/i.test(pt) && out.some(p => p.sections.some((s: any) => s.type === 'checkout'));
    if (!hasTypedForm && !checkoutCovers) {
      const ACTION_PAGE = /book|reserv|order|sign|apply|join|start|quote|contact/;
      // never stack a second form onto a page that already has one (dogfood tests one form per page)
      const noForm = (p: any) => !p.sections.some((s: any) => s.type === 'form');
      const target = out.find(p => ACTION_PAGE.test(p.slug) && noForm(p)) || out.find(noForm) || out[0];
      target.sections.push({ type: 'form', title: humanTitle(pt), intro: '', table: pt, form: pt });
      repairs.push(`injected the missing typed form on "${target.slug}" (table "${pt}") — an app's core action must be a real form${at ? ' on the ACTION table' : ''}`);
    }
  }
  // GUARANTEE THE STORE (PQ2): a store model must actually SELL — a products grid somewhere, a cart
  // section on the cart page, a checkout section on the checkout page. Injected deterministically
  // when the model forgot them (never trust, always force); the site_model gate then asserts it.
  if ((base as any).archetype === 'store' && out.length) {
    const hasProducts = out.some(p => p.sections.some((x: any) => x.type === 'products'));
    if (!hasProducts) {
      const shop = out.find(p => /shop|store|product|catalog|menu/.test(p.slug)) || out[0];
      shop.sections.splice(Math.min(1, shop.sections.length), 0, { type: 'products', title: 'Shop', intro: '', table: (base.tables || []).includes('products') ? 'products' : (base.primaryTable || 'products') });
      repairs.push(`injected the products grid on "${shop.slug}"`);
    }
    const cartPage = out.find(p => /cart|basket|bag/.test(p.slug));
    if (cartPage && !cartPage.sections.some((x: any) => x.type === 'cart')) { cartPage.sections.push({ type: 'cart', title: 'Your cart' }); repairs.push('injected the cart on "' + cartPage.slug + '"'); }
    const coPage = out.find(p => /checkout|order/.test(p.slug));
    if (coPage && !coPage.sections.some((x: any) => x.type === 'checkout')) { coPage.sections.push({ type: 'checkout', title: 'Checkout', intro: '' }); repairs.push('injected the checkout on "' + coPage.slug + '"'); }
  }
  // COPY GATE at the RETRYABLE stage: reject slop/placeholders now (compose retries with feedback) instead of
  // letting it reach the deterministic render, where a retry can't fix it. {{brand}} is ignored (not slop).
  const slop = siteCopySlop(out);
  if (slop) errors.push(`slop/placeholder copy — ${slop}. Write real, specific copy for THIS brief: no lorem ipsum, no [Placeholders], no "… here", no example.com.`);
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
  // FS0: never inject over a private visitor-record table — no catalog is better than a leak.
  if (nonEmpty(ctx.primaryTable) && !PRIVATE_READ.test(str(ctx.primaryTable)) && CATALOG_PAGE.test(str(ctx.slug))) {
    if (!sections.some((x) => x.type === 'collection' && x.table === ctx.primaryTable)) {
      sections.splice(Math.min(1, sections.length), 0, { type: 'collection', title: catalogTitle(str(ctx.primaryTable)), intro: '', table: ctx.primaryTable });
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

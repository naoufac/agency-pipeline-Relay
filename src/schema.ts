// schema.ts — the deterministic DATA-MODEL COMPILER. The database analog of the page renderer:
// the model describes WHAT (entities, fields, relations); this compiles HOW — flawless, consistent
// Postgres DDL every time. Every table gets a serial PK and a created_at timestamptz default now();
// money becomes numeric(12,2); relations become real FK constraints WITH indexes; required/unique/
// defaults are honoured. Correct by construction — the model never hand-writes SQL, so the schema is
// always well-formed regardless of the LLM's SQL skill. A raw-SQL fallback keeps older output working.

export type Field = { name: string; type?: string; required?: boolean; unique?: boolean; default?: any; ref?: string };
export type Entity = { name: string; label?: string; public?: boolean; display?: string; fields?: Field[]; seed?: Record<string, any>[] };
export type DataModel = { entities: Entity[] };

const IDENT = /^[a-z][a-z0-9_]*$/;
const snake = (s: any) => String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);

// FS0 — PRIVATE-BY-DEFAULT visitor records. Rows a visitor SUBMITS about themselves (bookings,
// orders, messages, sign-ups…) are never publicly listable; catalog content (products, services,
// menu…) is. Coarse, name-based closed set so it protects every ALREADY-BUILT site the moment the
// server deploys; FS1 replaces it with a classification declared per-entity in the data model.
export const PRIVATE_READ = /^(_relay_\w+|orders?|order_items|bookings?|appointments?|consultations?|callbacks?|intakes?|enrollments?|reservations?|\w*_?requests?|submissions?|messages?|enquir(?:y|ies)|inquir(?:y|ies)|leads?|registrations?|signups?|sign_ups?|subscribers?|newsletter_signups?|rsvps?|applications?|waitlists?|waivers?|customers?|clients?|members?|patients?|guests?|attendees?|preorders?|pre_orders?|deliveries|shipments?|tracking_events?|users?|accounts?|sessions?|tokens?|payments?|invoices?|subscriptions?|donations?)$/i;

// FS3 — the ACTION tables that carry a real visitor-facing LIFECYCLE, and its closed status set.
// pending → confirmed/declined/cancelled is the owner↔visitor loop; 'new'/'completed' keep the store
// contract (placeOrder writes 'new') inside the same CHECK. The status is system-owned: forced to
// default 'pending' in the compiler (an LLM default of 'confirmed' auto-confirms strangers — a lie),
// hidden from public forms (SYSTEM_COLS), flipped only by the owner through the closed set.
export const LIFECYCLE_TABLE = /^(bookings?|appointments?|reservations?|reservation_requests?|orders?|rsvps?|requests?|applications?|registrations?|preorders?|pre_orders?|deliveries|enquir(?:y|ies)|inquir(?:y|ies))$/i;
export const STATUS_SET = ['pending', 'confirmed', 'declined', 'cancelled', 'new', 'completed'];

// SERVER-DERIVED action-table columns. A booking's price/duration/total are attributes of the chosen
// SERVICE, never a visitor input — a produced barber form asked customers to TYPE the price (a tamper
// vector, and nonsense that made every booking fail its NOT NULL). When a lifecycle table references a
// catalog carrying these, its own copies are made nullable, kept OFF the public form, and DERIVED at
// insert from the referenced row. (live-caught on the lather barbershop flight, 2026-07-05)
// word-boundary (not fully anchored): the LLM names money columns variably — price, total_price,
// unit_price, service_cost, subtotal. A fully anchored regex let 'total_price' slip back onto a
// booking form (live-caught on the cutline re-flight). Boundaries catch the prefixed/suffixed forms.
export const DERIVED_MONEY = /(^|_)(price|amount|cost|fee|subtotal|total|charge)(_|$)/i;
export const DERIVED_DURATION = /(^|_)(duration|minutes|mins)(_|$)/i;
export const DERIVED_COL = /(^|_)(price|amount|cost|fee|subtotal|total|charge|duration|minutes|mins)(_|$)/i;
// the END time of a booking is DERIVED (start + service duration) — never a second time-picker the
// customer fills. Detected among the table's time columns; excluded from the form, filled at insert.
export const END_TIME_COL = /(^|_)(end|ends|finish|until)(_|$)/i;

// THE EVENT-TIME COLUMN of a lifecycle row (the calendar feed and reminders both need it). Picking
// "the first date/timestamp column" is WRONG — a booking table may also carry date_of_birth, and a
// reminder keyed on that never fires (audit 2026-07-05). Exclude personal/bookkeeping dates, then
// prefer an obvious appointment column, else fall back to the first remaining dated column.
const WHEN_EXCLUDE = /(^|_)(birth|dob|created|updated|modified|expire[sd]?|deleted|joined|hired|since|anniversar|end|ends|finish|until)/i;
const WHEN_PREFER = /(scheduled|starts?_|start_at|appointment|booking|reserv|slot|due|when|_at$|_date$|_time$|^date$|^time$)/i;
export function pickWhenColumn(cols: { name: string; type: string }[]): string | null {
  const dated = cols.filter((c) => /timestamp|date|time/.test(String(c.type)) && !WHEN_EXCLUDE.test(c.name));
  return dated.find((c) => WHEN_PREFER.test(c.name))?.name ?? dated[0]?.name ?? null;
}
// slot-shaped tables where double-booking semantics apply (strict set — never forced onto tables
// that legitimately allow duplicates, like orders)
export const SLOT_TABLE = /^(bookings?|appointments?|reservations?)$/i;
// PQ2 · VARIANTS — the canonical options table: product_variants(product ref, name, price?, stock?).
// price null = inherits the product's; stock null = untracked. 'variants' normalizes to this name.
export const VARIANT_TABLE = /^(product_)?variants$/i;

// closed type vocabulary -> Postgres column type (everything the model can ask for)
const TYPE: Record<string, string> = {
  text: 'text', string: 'text', longtext: 'text', richtext: 'text', email: 'text', url: 'text', phone: 'text',
  slug: 'text', image: 'text', color: 'text', enum: 'text', status: 'text',
  int: 'integer', integer: 'integer', number: 'numeric', float: 'numeric', decimal: 'numeric',
  money: 'numeric(12,2)', price: 'numeric(12,2)', currency: 'numeric(12,2)',
  bool: 'boolean', boolean: 'boolean', checkbox: 'boolean',
  date: 'date', datetime: 'timestamptz', timestamp: 'timestamptz', time: 'time',
  json: 'jsonb', jsonb: 'jsonb', uuid: 'uuid',
};
const pgType = (t: any) => TYPE[String(t || 'text').toLowerCase()] || 'text';
const RESERVED = new Set(['id', 'created_at', 'updated_at']);

export function lit(v: any, type: string): string {
  if (v === null || v === undefined) return 'null';
  if (type === 'boolean') return v === true || v === 'true' ? 'true' : 'false';
  if (/^(integer|numeric)/.test(type)) { const n = Number(v); return Number.isFinite(n) ? String(n) : 'null'; }
  if (type === 'jsonb') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

// Detect whether `content` is a JSON data-model (compile it) or raw SQL (caller uses the SQL fallback).
export function parseModel(content: string): DataModel | null {
  const t = content.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  let obj: any; try { obj = JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  if (!obj || !Array.isArray(obj.entities) || !obj.entities.length) return null;
  return obj as DataModel;
}

// Per-table artifacts, exposed for the MIGRATION planner (M3): resolved column specs, the CREATE,
// its indexes and its seeds — so a rebuild can create ONLY missing tables / add ONLY missing columns.
export type ResolvedCol = { name: string; type: string; required: boolean; unique: boolean; def: any; ref?: string };
export type Resolved = { order: string[]; cols: Record<string, ResolvedCol[]>; createSql: Record<string, string>; indexSql: Record<string, string[]>; seedSql: Record<string, string[]> };

// Compile a data-model into perfect Postgres DDL + the table list. Deterministic and self-contained.
export function compile(model: DataModel): { ddl: string; tables: string[]; warnings: string[]; resolved: Resolved } {
  const warnings: string[] = [];
  // normalize + de-dupe entities by snake name
  const ents: Entity[] = [];
  for (const raw of model.entities) {
    const name = snake(raw?.name);
    if (!IDENT.test(name) || ents.some(e => e.name === name)) { if (raw?.name) warnings.push('dropped entity ' + raw?.name); continue; }
    ents.push({ ...raw, name });
  }
  // PQ2 · VARIANTS — normalize the options table to its canonical name, and give order_items the
  // variant SNAPSHOT columns (name + id, like unit_price) so a receipt line reads "Tee — XL" forever
  // even if the variant is later renamed or deleted.
  if (!ents.some(x => x.name === 'product_variants')) {
    const va = ents.find(e2 => VARIANT_TABLE.test(e2.name));
    if (va) { warnings.push(`renamed entity ${va.name} → product_variants (canonical options table)`); va.name = 'product_variants'; }
  }
  // CATALOG CANON — a store may model its sellables as anything ('categories' of candle scents —
  // a real canary catch: no products table existed, the grid rendered category cards, nothing was
  // purchasable). If variants exist WITHOUT products, the variants' parent entity IS the catalog:
  // rename it to products, rewrite every ref, canonicalize the variants' FK column and seed keys.
  if (ents.some(e2 => e2.name === 'product_variants') && !ents.some(e2 => e2.name === 'products')) {
    const pv = ents.find(e2 => e2.name === 'product_variants')!;
    const parentField = (pv.fields || []).find(f => f?.ref && ents.some(e2 => e2.name === snake(f.ref!) && e2.name !== 'product_variants'));
    const parent = parentField ? ents.find(e2 => e2.name === snake(parentField.ref!)) : null;
    if (parent) {
      const old = parent.name;
      const oldCol = snake(parentField!.name);
      parent.name = 'products';
      for (const e2 of ents) for (const f of (e2.fields || [])) if (f?.ref && snake(f.ref) === old) f.ref = 'products';
      if (oldCol !== 'product_id') {
        parentField!.name = 'product_id';
        for (const row of (pv.seed || [])) if (row && typeof row === 'object' && oldCol in row) { (row as any).product_id = (row as any)[oldCol]; delete (row as any)[oldCol]; }
      }
      warnings.push(`renamed entity ${old} → products (variants existed without a catalog — nothing was purchasable)`);
    }
  }
  if (ents.some(e2 => e2.name === 'product_variants')) {
    const oi = ents.find(e2 => e2.name === 'order_items');
    if (oi) {
      oi.fields = oi.fields || [];
      // the LLM spells the variant FK many ways (product_variant_id NOT NULL — a real canary
      // catch: placeOrder writes the CANONICAL variant_id, the alien column stayed null and NO
      // order could ever land). Canonicalize the spelling FIRST, then force it optional: a line
      // item without options is legal by contract.
      for (const f of oi.fields) {
        if (/^(product_)?variants?_id$/.test(snake(f?.name)) && snake(f?.name) !== 'variant_id') {
          warnings.push(`order_items.${snake(f.name)} → variant_id (canonical line-item variant column)`);
          f.name = 'variant_id';
        }
      }
      if (!oi.fields.some(f => snake(f?.name) === 'variant_name')) oi.fields.push({ name: 'variant_name', type: 'text' });
      if (!oi.fields.some(f => snake(f?.name) === 'variant_id')) oi.fields.push({ name: 'variant_id', type: 'int' });
      for (const f of oi.fields) if (['variant_id', 'variant_name'].includes(snake(f?.name))) { f.required = false; }
      // a variants-first model links line items to the VARIANT and skips the product entirely
      // (order_items.product_variant_id, no product_id — a real canary catch: placeOrder's store
      // contract needs product_id and the store could not sell). Canonicalize: product_id always exists.
      if (!oi.fields.some(f => /^product(_id)?$/.test(snake(f?.name)))) {
        oi.fields.push({ name: 'product_id', type: 'int' });
        warnings.push('order_items.product_id injected (line items referenced only the variant)');
      }
      if (!oi.fields.some(f => /^(qty|quantity)$/.test(snake(f?.name)))) {
        oi.fields.push({ name: 'qty', type: 'int' });
        warnings.push('order_items.qty injected (the store contract needs a quantity)');
      }
    }
    // A model may price the VARIANTS and not the products ('scents in three sizes' — a real canary
    // catch: no products.price → no Add-to-cart → the store cannot sell). The store contract needs
    // products.price: inject it and BACKFILL each product seed with its cheapest variant's price
    // (variant seeds reference products by seed position, 1-based). Underivable models are rejected
    // upstream (normalizeDataModel) with exact feedback.
    const prods = ents.find(e2 => e2.name === 'products');
    const va2 = ents.find(e2 => e2.name === 'product_variants');
    if (prods && va2 && !(prods.fields || []).some(f => /^(price|amount|cost)$/.test(snake(f?.name)))) {
      prods.fields = prods.fields || [];
      prods.fields.push({ name: 'price', type: 'money' });
      const vseeds = va2.seed || [];
      (prods.seed || []).forEach((row: any, i: number) => {
        const mine = vseeds.filter((v: any) => Number(v?.product ?? v?.product_id) === i + 1)
          .map((v: any) => Number(v?.price)).filter((n: number) => Number.isFinite(n) && n > 0);
        if (mine.length && row && typeof row === 'object') row.price = Math.min(...mine);
      });
      warnings.push('products.price injected from the cheapest variant (variants carried the pricing)');
    }
  }
  // SEED HYGIENE (two canary catches on one build):
  // (1) the LLM seeded FAKE ORDERS ('Emma Rodriguez, $64') — visitor-record rows are the visitors'
  //     to create, never the model's. Private-table seeds are fiction: stripped, loudly.
  // (2) every variant seeded stock 0 — the store was BORN SOLD OUT and could never sell anything.
  //     A seeded zero is invented scarcity (the auto-confirm lie's twin): coerced to untracked;
  //     the owner sets real counts in the Content tab.
  for (const e2 of ents) {
    if (PRIVATE_READ.test(e2.name) && Array.isArray(e2.seed) && e2.seed.length) {
      warnings.push(`${e2.name}: stripped ${e2.seed.length} seeded visitor record(s) — visitors create these, never the model`);
      e2.seed = [];
    }
    if (/^(products|product_variants)$/.test(e2.name)) {
      for (const row of (e2.seed || [])) {
        if (row && typeof row === 'object' && Number(row.stock) === 0) {
          delete row.stock;
          warnings.push(`${e2.name}: seeded stock 0 coerced to untracked (a store must not be born sold out)`);
        }
      }
    }
  }
  // PAYMENTS v1 — every store carries owner-editable PAYMENT INSTRUCTIONS: an injected public
  // payment_options table (rendered at checkout, edited in the Content tab, read live). The LLM
  // never invents an IBAN — the one safe seed is "pay on pickup"; the owner types real details.
  if (ents.some(e => /^orders$/i.test(e.name)) && !ents.some(e => /^payment_\w+$/i.test(e.name))) {
    ents.push({ name: 'payment_options', public: true, display: 'name', fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'details', type: 'text' },
      { name: 'active', type: 'boolean', default: true },
    ], seed: [{ name: 'Pay on pickup', details: 'Pay when you collect your order — cash or card at the counter.', active: true }] } as Entity);
    warnings.push('injected payment_options (owner-editable payment instructions; safe default: pay on pickup)');
  }
  const names = new Set(ents.map(e => e.name));

  // resolve fields per entity (skip reserved/invalid; resolve refs to known entities)
  type Col = { name: string; type: string; required: boolean; unique: boolean; def: any; ref?: string };
  const cols = new Map<string, Col[]>();
  for (const e of ents) {
    const list: Col[] = [];
    for (const f of (e.fields || [])) {
      const fname = snake(f?.name);
      if (!IDENT.test(fname) || RESERVED.has(fname) || list.some(c => c.name === fname)) continue;
      const refSpec = f.ref || (typeof f.type === 'string' && /^ref:/i.test(f.type) ? f.type.slice(4) : null);
      if (refSpec) {
        const ref = snake(refSpec);
        if (!names.has(ref)) { warnings.push(`${e.name}.${fname} -> unknown ref ${refSpec}`); continue; }
        const col = fname.endsWith('_id') ? fname : fname + '_id';
        list.push({ name: col, type: 'integer', required: !!f.required, unique: false, def: undefined, ref });
      } else {
        list.push({ name: fname, type: pgType(f.type), required: !!f.required, unique: !!f.unique, def: f.default });
      }
    }
    cols.set(e.name, list);
  }

  // emit tables in dependency order (referenced first); break cycles by demoting the FK to a plain int
  const order: string[] = []; const seen = new Set<string>(); const stack = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return; if (stack.has(n)) return; stack.add(n);
    for (const c of cols.get(n) || []) if (c.ref && c.ref !== n) visit(c.ref);
    stack.delete(n); seen.add(n); order.push(n);
  };
  ents.forEach(e => visit(e.name));

  const tables: string[] = []; const ddl: string[] = []; const indexes: string[] = []; const seeds: string[] = [];
  const resolved: Resolved = { order: [], cols: {}, createSql: {}, indexSql: {}, seedSql: {} };
  for (const name of order) {
    const e = ents.find(x => x.name === name)!; const list = cols.get(name)!;
    // FS5 floor — ONE canonical booking-time shape. The LLM draws split date+time columns on booking
    // tables ('reservation_date' date + 'reservation_time' text) — the slot guard and hour-level
    // availability both need ONE timestamp. Merge: the date column BECOMES the timestamp, the time
    // column is dropped, and seed rows are merged below (date + 'T' + time). Loud, deterministic.
    let mergedTime: { dateCol: string; timeCol: string } | null = null;
    if (SLOT_TABLE.test(name)) {
      const dcol = list.find(c => !c.ref && /(^|_)(date|day)$/.test(c.name) && /^(date|timestamp)/.test(c.type));
      const tcol = list.find(c => !c.ref && c !== dcol && /(^|_)time$/.test(c.name));
      if (dcol && tcol) {
        dcol.type = 'timestamptz';
        list.splice(list.indexOf(tcol), 1);
        mergedTime = { dateCol: dcol.name, timeCol: tcol.name };
        warnings.push(`${name}: split ${dcol.name}+${tcol.name} merged into one timestamp "${dcol.name}" (canonical booking-time shape)`);
      }
    }
    // FS1 — every private (visitor-record) entity carries a nullable receipt token: generated
    // server-side on insert, unique when present. Nullable by design — pre-receipt rows stay null
    // (an '' default would collide on the unique index and make old rows "findable" by nothing).
    if (PRIVATE_READ.test(name) && !list.some(c => c.name === 'ref_token'))
      list.push({ name: 'ref_token', type: 'text', required: false, unique: false, def: undefined });
    // FS2 floor — a visitor-writable table must carry the visitor's own contact identity: an LLM
    // that models a normalized CRM (identity on a separate private `clients` table) strips email
    // from the action row, and receipts-by-mail / claim-on-verify / My-bookings all die (a real law
    // build failed its act-probe exactly this way). Nullable, injected only when absent; the
    // server-written / account-system tables are exempt.
    if (PRIVATE_READ.test(name) && !/^(order_items|users?|accounts?|sessions?|tokens?|payments?)$/i.test(name)
        && !list.some(c => /^e[-_]?mail(_address)?$/i.test(c.name)))
      list.push({ name: 'email', type: 'text', required: false, unique: false, def: undefined });
    // A visitor-writable table may not REQUIRE a reference into a private table: public reads of the
    // target are sealed, so a public form could never offer real options (the empty-dropdown class a
    // reviewer caught on a real cafe build). The column survives — the owner links records in the
    // Content tab — it just can't be `not null`. Server-written order_items keeps its NOT NULL FK.
    if (PRIVATE_READ.test(name) && name !== 'order_items')
      for (const c of list) if (c.ref && PRIVATE_READ.test(c.ref) && c.required) { c.required = false; warnings.push(`${name}.${c.name}: required ref into private ${c.ref} made nullable (public form can never fill it)`); }
    // FS3 — lifecycle tables carry a SYSTEM-OWNED status: default 'pending' (an LLM default of
    // 'confirmed' would auto-confirm strangers), values bound to the closed set by a CHECK.
    if (LIFECYCLE_TABLE.test(name)) {
      const st = list.find(c => c.name === 'status');
      if (st) { st.type = 'text'; st.def = 'pending'; st.required = true; }
      else list.push({ name: 'status', type: 'text', required: true, unique: false, def: 'pending' });
      // a lifecycle table that references a PRICED catalog (a service/product with price or duration)
      // derives its own money/duration/total from that catalog at insert — so they must be nullable
      // (the public form omits them; the server fills them). Otherwise a NOT NULL price blocks every
      // booking a customer can't type. (live-caught, 2026-07-05)
      const pricedRef = list.some(c => c.ref && (ents.find(x => x.name === c.ref)?.fields || []).some((f: any) => DERIVED_MONEY.test(f.name) || DERIVED_DURATION.test(f.name)));
      if (pricedRef) for (const c of list) if (!c.ref && DERIVED_COL.test(c.name) && c.required) {
        c.required = false; warnings.push(`${name}.${c.name}: server-derived from a priced ref — made nullable + kept off the public form`);
      }
      // a booking's END time is start + duration, never a second picker the customer fills: when the
      // table has a START event column AND an END column, the end is made nullable + derived at insert.
      const timeCols = list.filter(c => !c.ref && /^(timestamp|date|time)/.test(String(c.type)) && c.name !== 'created_at');
      const endCol = timeCols.find(c => END_TIME_COL.test(c.name));
      const startCol = timeCols.find(c => c !== endCol && !END_TIME_COL.test(c.name));
      if (endCol && startCol && endCol.required) {
        endCol.required = false; warnings.push(`${name}.${endCol.name}: derived end time (start + duration) — made nullable + kept off the public form`);
      }
    }
    const perTableIndexes: string[] = [];
    const lines = ['  id serial primary key'];
    for (const c of list) {
      const refOk = !c.ref || order.indexOf(c.ref) < order.indexOf(name) || c.ref === name; // only real FK if target precedes
      let line = `  "${c.name}" ${c.type}`;
      if (c.required) line += ' not null';
      if (c.unique) line += ' unique';
      if (c.def !== undefined && !c.ref) line += ' default ' + lit(c.def, c.type);
      if (c.ref && refOk) { line += ` references "${c.ref}"(id) on delete set null`; indexes.push(`create index "${name}_${c.name}_idx" on "${name}" ("${c.name}");`); perTableIndexes.push(indexes[indexes.length - 1]); }
      else if (c.ref) warnings.push(`${name}.${c.name}: FK to ${c.ref} demoted (cycle/forward-ref)`);
      if (c.name === 'ref_token') { indexes.push(`create unique index "${name}_ref_token_uq" on "${name}" ("ref_token") where "ref_token" is not null;`); perTableIndexes.push(indexes[indexes.length - 1]); }
      if (c.name === 'status' && LIFECYCLE_TABLE.test(name)) line += ` check ("status" in (${STATUS_SET.map(s => `'${s}'`).join(',')}))`;
      lines.push(line);
    }
    lines.push('  created_at timestamptz not null default now()');
    ddl.push(`create table "${name}" (\n${lines.join(',\n')}\n);`);
    tables.push(name);
    resolved.order.push(name);
    resolved.cols[name] = list;
    resolved.createSql[name] = ddl[ddl.length - 1];
    resolved.indexSql[name] = perTableIndexes;
    resolved.seedSql[name] = [];
    // seeds: scalar columns by name; FK columns by the field name OR <field>_id, when given an integer id
    const colByKey = (k: string) => list.find(c => !c.ref && c.name === k) || list.find(c => c.ref && (c.name === k || c.name === k + '_id'));
    // "6 PM" / "18:30" / "18:30:00" → HH:MM for the canonical-shape seed merge; garbage → midday
    const timeish = (v: any): string => {
      const m = String(v ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/i);
      if (!m) return '12:00';
      let h = Number(m[1]) % 24; const ap = (m[3] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
      return String(h).padStart(2, '0') + ':' + (m[2] || '00');
    };
    for (const raw0 of (e.seed || []).slice(0, 12)) {
      let row: any = raw0 || {};
      // canonical booking-time shape: a seed carrying split date+time keys is merged the same way
      if (mergedTime) {
        const dk = Object.keys(row).find(k => snake(k) === mergedTime!.dateCol);
        const tk = Object.keys(row).find(k => snake(k) === mergedTime!.timeCol);
        if (dk && tk && /^\d{4}-\d{2}-\d{2}/.test(String(row[dk]))) {
          row = { ...row, [dk]: String(row[dk]).slice(0, 10) + 'T' + timeish(row[tk]) + ':00' };
          delete row[tk];
        }
      }
      const used = Object.keys(row || {})
        .map(k => ({ col: colByKey(snake(k)), v: (row as any)[k] }))
        .filter((x): x is { col: NonNullable<ReturnType<typeof colByKey>>; v: any } => !!x.col && (!x.col.ref || Number.isInteger(Number(x.v))));
      // FS3: seed statuses are coerced into the closed set (the CHECK would reject the model's own
      // seeds — a build must never die on a seed row saying 'preparing')
      for (const x of used) if (x.col.name === 'status' && LIFECYCLE_TABLE.test(name)) {
        const lv = String(x.v ?? '').toLowerCase().trim();
        x.v = STATUS_SET.includes(lv) ? lv : 'pending';
      }
      if (!used.length) continue;
      const cols2 = used.map(x => x.col.name);
      const vals = used.map(x => lit(x.col.ref ? Number(x.v) : x.v, x.col.type));
      seeds.push(`insert into "${name}" (${cols2.map(c => `"${c}"`).join(', ')}) values (${vals.join(', ')});`);
      resolved.seedSql[name].push(seeds[seeds.length - 1]);
    }
  }
  return { ddl: [...ddl, ...indexes, ...seeds].join('\n'), tables, warnings, resolved };
}

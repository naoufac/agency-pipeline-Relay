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
export const PRIVATE_READ = /^(_relay_\w+|orders?|order_items|bookings?|appointments?|consultations?|callbacks?|intakes?|enrollments?|reservations?|\w*_?requests?|submissions?|messages?|enquir(?:y|ies)|inquir(?:y|ies)|leads?|registrations?|signups?|sign_ups?|rsvps?|applications?|waitlists?|waivers?|customers?|clients?|members?|patients?|guests?|attendees?|preorders?|pre_orders?|deliveries|shipments?|tracking_events?|users?|accounts?|sessions?|tokens?|payments?|invoices?|subscriptions?|donations?)$/i;

// FS3 — the ACTION tables that carry a real visitor-facing LIFECYCLE, and its closed status set.
// pending → confirmed/declined/cancelled is the owner↔visitor loop; 'new'/'completed' keep the store
// contract (placeOrder writes 'new') inside the same CHECK. The status is system-owned: forced to
// default 'pending' in the compiler (an LLM default of 'confirmed' auto-confirms strangers — a lie),
// hidden from public forms (SYSTEM_COLS), flipped only by the owner through the closed set.
export const LIFECYCLE_TABLE = /^(bookings?|appointments?|reservations?|reservation_requests?|orders?|rsvps?|requests?|applications?|registrations?|preorders?|pre_orders?|deliveries|enquir(?:y|ies)|inquir(?:y|ies))$/i;
export const STATUS_SET = ['pending', 'confirmed', 'declined', 'cancelled', 'new', 'completed'];
// slot-shaped tables where double-booking semantics apply (strict set — never forced onto tables
// that legitimately allow duplicates, like orders)
export const SLOT_TABLE = /^(bookings?|appointments?|reservations?)$/i;

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
    for (const row of (e.seed || []).slice(0, 12)) {
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

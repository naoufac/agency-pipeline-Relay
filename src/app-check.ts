// app:check — THE FS0 GATE (an app must be HONEST before it can be full-stack). Deterministic,
// no LLM, no live server:
//   PRIVACY layer: visitor-record tables (bookings/orders/messages/…) are never publicly listable —
//     the public read API answers [] / null for them exactly as for tables that don't exist, while
//     the owner's gated content admin still reads them and visitors can still SUBMIT to them.
//   SURFACE layer: no facade pages (dashboard/portal/track…) on data archetypes — the planner drops
//     them, site_model rejects them, collections can never target a private table, and the catalog
//     injection never picks one.
// Exit 1 on any failure. Run: npm run app:check.
import { randomUUID } from 'node:crypto';
import { makePool } from './db.ts';
import * as appdb from './appdb.ts';
import { PRIVATE_READ } from './schema.ts';
import { FACADE_PAGE } from './archetype.ts';
import { normalizeSpec, normalizeSite } from './spec.ts';
import { verify } from './verify.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

// ---- closed sets ----
for (const t of ['bookings', 'orders', 'order_items', 'appointments', 'reservations', 'messages', 'enquiries', 'leads', 'registrations', 'rsvps', 'customers', 'users', 'sessions', 'waitlist', 'waivers', 'deliveries', 'shipments', 'tracking_events', 'payments',
  // 2026-07-03: 'consultations' was blind (a law build served it publicly + broke its own form) —
  // same class as the 'bookings' plural blind spot; visitor-action nouns + any *_requests table
  'consultations', 'consultation', 'callbacks', 'intakes', 'enrollments', 'requests', 'quote_requests', 'service_requests', 'booking_requests',
  'subscribers', 'newsletter_signups'])
  ok(`private: ${t}`, PRIVATE_READ.test(t));
for (const t of ['products', 'services', 'menu_items', 'listings', 'posts', 'barbers', 'categories', 'events', 'rooms', 'classes'])
  ok(`public: ${t}`, !PRIVATE_READ.test(t));
for (const s of ['dashboard', 'admin', 'portal', 'client-portal', 'my-account', 'track', 'tracking', 'login', 'sign-in'])
  ok(`facade page: ${s}`, FACADE_PAGE.test(s));
for (const s of ['index', 'shop', 'book', 'services', 'about', 'contact', 'menu', 'checkout', 'cart'])
  ok(`honest page: ${s}`, !FACADE_PAGE.test(s));

// the classifier is the FLOOR: an LLM-declared 'site' can never strip a bookings brief of its app
{
  const { archetypeFor } = await import('./archetype.ts');
  ok("LLM 'site' cannot downgrade a bookings brief", archetypeFor('site', 'a neighborhood cafe with weekend brunch bookings') === 'app');
  ok("LLM 'store' honoured on a plain brief", archetypeFor('store', 'a portfolio for a painter') === 'store');
  ok('junk archetype falls back to the classifier', archetypeFor('spaceship', 'an online store for hats') === 'store');
  // "boutique" is a shop only as a NOUN — as an adjective it forced a law firm into a store whose
  // empty shop grid failed review (the reviewer's store-broken finding on a real rebuild)
  ok("'boutique law firm … by appointment' is an app, never a store",
    archetypeFor(undefined, 'a boutique law firm in Naples — estate and family law, consultations by appointment') === 'app');
  ok("'a boutique consultancy' is not a store", archetypeFor(undefined, 'a boutique consultancy for family offices') !== 'store');
  ok("'a fashion boutique' is a store", archetypeFor(undefined, 'a fashion boutique in Milan') === 'store');
  ok("'a boutique selling …' is a store", archetypeFor(undefined, 'a boutique selling vintage dresses') === 'store');
}

// ---- primary catalog table (machine tables are furniture) ----
{
  const { choosePrimaryTable } = await import('./runner.ts');
  ok('time_slots with most rows loses to a content table', choosePrimaryTable([{table:'time_slots',rows:40},{table:'practice_areas',rows:4}]) === 'practice_areas');
  ok('named content beats row count', choosePrimaryTable([{table:'misc',rows:50},{table:'services',rows:3}]) === 'services');
  ok('ONLY machine tables with rows → no catalog', choosePrimaryTable([{table:'time_slots',rows:40},{table:'schedules',rows:9}]) === '');
  ok('lookup tables still excluded', choosePrimaryTable([{table:'settings',rows:10},{table:'products',rows:2}]) === 'products');
}

// ---- SURFACE layer (pure) ----
{
  // a collection over a private table is DROPPED, never rendered
  const r = normalizeSpec({ sections: [
    { type: 'hero', headline: 'Fresh fades, zero waiting around' },
    { type: 'collection', title: 'Upcoming appointments', table: 'bookings' },
    { type: 'features', items: [{ title: 'Walk-ins', body: 'welcome any day' }] }] },
    { slug: 'index', tables: ['bookings', 'services'], forms: { bookings: [{ name: 'name', type: 'text', nullable: false }] }, primaryTable: 'services' });
  ok('collection over a private table is dropped', !!r.spec && !r.spec.sections.some((s: any) => s.type === 'collection' && s.table === 'bookings'), JSON.stringify(r.repairs));
  ok('the drop is loud (repair note)', r.repairs.some((x: string) => /private table "bookings"/.test(x)));
  // the catalog injection never picks a private primary table
  const r2 = normalizeSpec({ sections: [
    { type: 'hero', headline: 'Fresh fades, zero waiting around' },
    { type: 'features', items: [{ title: 'Walk-ins', body: 'welcome any day' }] }] },
    { slug: 'index', tables: ['bookings'], forms: {}, primaryTable: 'bookings' });
  ok('catalog injection skips a private primary table', !!r2.spec && !r2.spec.sections.some((s: any) => s.type === 'collection'));
  // …and still fires for a public one
  const r3 = normalizeSpec({ sections: [
    { type: 'hero', headline: 'Fresh fades, zero waiting around' },
    { type: 'features', items: [{ title: 'Walk-ins', body: 'welcome any day' }] }] },
    { slug: 'index', tables: ['services'], forms: {}, primaryTable: 'services' });
  ok('catalog injection still fires for a public table', !!r3.spec && r3.spec.sections.some((s: any) => s.type === 'collection' && s.table === 'services'));
  // the core action stays guaranteed for apps (M2 injection unchanged)
  const model = { pages: [{ slug: 'index', title: 'Home', sections: [{ type: 'hero', headline: 'Fresh fades, zero waiting' }, { type: 'features', items: [{ title: 'A', body: 'b' }] }] }] };
  const rs = normalizeSite(model, [{ slug: 'index', title: 'Home' }], { archetype: 'app', tables: ['bookings', 'services'], forms: { bookings: [{ name: 'name', type: 'text', nullable: false }] }, primaryTable: 'bookings' });
  ok('core action form still injected for apps', rs.site.pages[0].sections.some((s: any) => s.type === 'form' && s.table === 'bookings'), JSON.stringify(rs.repairs));
  // FS1 · the ACTION-TABLE class (a booking app whose form adds catalog rows is a facade with extra steps):
  const both = { bookings: [{ name: 'customer_name', type: 'text', nullable: false }], services: [{ name: 'name', type: 'text', nullable: false }] };
  const rs2 = normalizeSite(model, [{ slug: 'index', title: 'Home' }], { archetype: 'app', tables: ['bookings', 'services'], forms: both, primaryTable: 'services', actionTable: 'bookings' });
  ok('injection targets the ACTION table over the catalog primary', rs2.site.pages[0].sections.some((s: any) => s.type === 'form' && s.table === 'bookings'), JSON.stringify(rs2.site.pages[0].sections.map((s: any) => s.type + ':' + (s.table || ''))));
  const m3 = { pages: [{ slug: 'book', title: 'Book', sections: [{ type: 'hero', headline: 'Grab a slot today' }, { type: 'form', title: 'Book your appointment', form: 'booking' }] }] };
  const rs3 = normalizeSite(m3, [{ slug: 'book', title: 'Book' }], { archetype: 'app', tables: ['bookings', 'services'], forms: both, primaryTable: 'services', actionTable: 'bookings' });
  ok('an unbound action-intent form binds to the action table', rs3.site.pages[0].sections.some((s: any) => s.type === 'form' && s.table === 'bookings'), JSON.stringify(rs3.repairs));
  const m4 = { pages: [{ slug: 'contact', title: 'Contact', sections: [{ type: 'hero', headline: 'Say hello anytime' }, { type: 'form', title: 'Send us a message', form: 'contact' }] }] };
  const rs4 = normalizeSite(m4, [{ slug: 'contact', title: 'Contact' }], { archetype: 'app', tables: ['bookings'], forms: { bookings: both.bookings }, primaryTable: '', actionTable: 'bookings' });
  const contactForm = rs4.site.pages[0].sections.find((s: any) => s.type === 'form' && s.form === 'contact');
  ok('a contact-intent form is never hijacked into a booking form', !!contactForm && !contactForm.table, JSON.stringify(rs4.site.pages[0].sections.map((s: any) => s.type + ':' + (s.table || ''))));
  // FS1 · the public may write ONLY form-target tables (catalog vandalism closed)
  const { publicWriteTables } = await import('./spec.ts');
  ok('publicWriteTables = exactly the form targets', JSON.stringify(publicWriteTables({ pages: [{ sections: [{ type: 'form', table: 'bookings' }, { type: 'collection', table: 'services' }] }] })) === '["bookings"]');
}

// ---- a TRUNCATED data model salvages its complete entities (the delivery-app killer) ----
{
  const { modelHasCore } = await import('./spec.ts');
  ok('a users+clients-only model is a GUTTED app', !modelHasCore({ entities: [{ name: 'users', fields: [{ name: 'email' }, { name: 'password_hash' }] }, { name: 'clients', fields: [{ name: 'name' }, { name: 'email' }] }] }));
  ok('a model with a real action entity has its core', modelHasCore({ entities: [{ name: 'users', fields: [{ name: 'email' }, { name: 'x' }] }, { name: 'deliveries', fields: [{ name: 'pickup' }, { name: 'dropoff' }] }] }));
  ok('a public directory model (listings) has its core', modelHasCore({ entities: [{ name: 'listings', fields: [{ name: 'title' }, { name: 'city' }] }] }));
  const { normalizeDataModel } = await import('./spec.ts');
  const truncated = '{"entities":[{"name":"users","fields":[{"name":"email","type":"email"}]},{"name":"deliveries","fields":[{"name":"pickup_address","type":"text"},{"name":"status","type":"status"}]},{"name":"tracking_events","fields":[{"name":"note","ty';
  const r = normalizeDataModel(truncated);
  ok('truncated model: complete entities recovered', (r as any).ok === true && (r as any).model.entities.length === 2, JSON.stringify((r as any).errors || (r as any).repairs));
  ok('truncated model: the cut-off entity is dropped, not guessed', (r as any).ok === true && !(r as any).model.entities.some((e: any) => e.name === 'tracking_events'));
  const hopeless = normalizeDataModel('Sorry, I cannot produce a data model.');
  ok('prose is still rejected honestly', (hopeless as any).ok === false);
}

// ---- CTA -> the form itself (the "everything collapses to home" class) ----
{
  const { renderPage, formPageSlug } = await import('./render.ts');
  const site = { pages: [
    { slug: 'index', title: 'Home', sections: [{ type: 'hero', headline: 'Fresh fades' }, { type: 'form', table: 'bookings' }] },
    { slug: 'barbers', title: 'Barbers', sections: [{ type: 'hero', headline: 'The team' }] }] };
  ok('formPageSlug finds the page carrying the form', formPageSlug(site) === 'index');
  const barbers = renderPage(
    { brand: { name: 'Chop', tokens: {}, cta: 'Book now' }, sections: [
      { type: 'hero', headline: 'Meet the barbers', cta: 'Book now' },
      { type: 'cta', headline: 'Ready for a fresh cut?', cta: 'Book your slot' }] },
    { pages: site.pages.map(p => ({ slug: p.slug, title: p.title })), slug: 'barbers', title: 'Barbers', formSlug: 'index' });
  ok('cross-page CTAs land AT the form (anchor), never a bare home reload', barbers.includes('href="index.html#contact-form"') && !/class="btn" href="index\.html"/.test(barbers), (barbers.match(/class="btn" href="[^"]*"/g) || []).join(' '));
  // the page HOSTING the form: its own CTAs scroll to the form, never bounce to another page
  const book = renderPage(
    { brand: { name: 'Chop', tokens: {}, cta: 'Book now' }, sections: [
      { type: 'hero', headline: 'Your chair is ready', cta: 'Book now' },
      { type: 'form', table: 'bookings', form: 'bookings' },
      { type: 'cta', headline: 'Walk-ins welcome', cta: 'Reserve a slot' }] },
    { pages: [{ slug: 'index', title: 'Home' }, { slug: 'book', title: 'Book' }], slug: 'book', title: 'Book',
      forms: { bookings: [{ name: 'customer_name', type: 'text', nullable: false }] }, formSlug: 'book' });
  ok('the form page\'s own CTAs anchor to its form (no bounce to home)', book.includes('class="btn" href="#contact-form"') && !/class="btn" href="index\.html/.test(book), (book.match(/class="btn" href="[^"]*"/g) || []).join(' '));
}

// ---- PRIVACY layer (real scratch schema) ----
const pool = makePool();
const id = randomUUID();
const schema = appdb.schemaName(id);
const MODEL = JSON.stringify({ entities: [
  { name: 'services', public: true, display: 'name', fields: [{ name: 'name', type: 'text', required: true }, { name: 'price', type: 'money' }],
    seed: [{ name: 'Cut', price: 30 }, { name: 'Shave', price: 22 }] },
  { name: 'reservations', fields: [{ name: 'customer_name', type: 'text', required: true }] },
  { name: 'bookings', fields: [{ name: 'customer_name', type: 'text', required: true }, { name: 'email', type: 'email' }, { name: 'service', type: 'ref:services' }, { name: 'reservation', type: 'ref:reservations', required: true }, { name: 'at', type: 'datetime' }] },
] });
try {
  await appdb.provision(pool, id, MODEL);
  await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Ada Visitor', email: 'ada@example.com', service_id: 1 });
  ok('visitors can still SUBMIT to a private table', (await pool.query(`select count(*)::int n from "${schema}"."bookings"`)).rows[0].n === 1);
  ok('public read of a private table answers [] (like an unknown table)', (await appdb.readRows(pool, id, 'bookings')).length === 0);
  ok('public read-by-id of a private row answers null', (await appdb.readRow(pool, id, 'bookings', 1)) === null);
  ok('the OWNER still reads the bookings (content admin)', (await appdb.readRows(pool, id, 'bookings', 200, 'owner')).length === 1);
  ok('public catalog tables still list', (await appdb.readRows(pool, id, 'services')).length === 2);
  ok('store orders are covered by the same guard', (await appdb.readRows(pool, id, 'orders')).length === 0 && PRIVATE_READ.test('orders'));

  // ---- SYSTEM-OWNED columns: lifecycle state is never the visitor's to set ----
  // (FS3: the compiler itself now injects status on lifecycle tables — default 'pending', CHECK-bound)
  const pubCols = (await appdb.formColumns(pool, id, 'bookings')).map(c => c.name);
  ok('public form never offers "status"', !pubCols.includes('status'), pubCols.join(','));
  const ownCols = (await appdb.formColumns(pool, id, 'bookings', 'owner')).map(c => c.name);
  ok('the owner form keeps "status"', ownCols.includes('status'), ownCols.join(','));

  // ---- refs into PRIVATE tables (the empty-dropdown class a reviewer caught on a real cafe build):
  // a public form can never fill options from a sealed read, so the field must not render publicly —
  // and the compiler must have made the column nullable so the public write path stays valid.
  ok('public form omits a ref into a private table', !pubCols.includes('reservation_id'), pubCols.join(','));
  ok('a ref into a PUBLIC table still renders publicly', pubCols.includes('service_id'), pubCols.join(','));
  ok('the owner form keeps the private ref (Content tab links records)', ownCols.includes('reservation_id'), ownCols.join(','));
  const rnul = (await pool.query(`select is_nullable from information_schema.columns where table_schema=$1 and table_name='bookings' and column_name='reservation_id'`, [schema])).rows[0];
  ok('a REQUIRED ref into a private table compiles NULLABLE', rnul?.is_nullable === 'YES', JSON.stringify(rnul));
  {
    const { parseModel, compile } = await import('./schema.ts');
    const m = compile(parseModel(JSON.stringify({ entities: [
      { name: 'orders', fields: [{ name: 'customer_name', type: 'text', required: true }] },
      { name: 'order_items', fields: [{ name: 'order', type: 'ref:orders', required: true }, { name: 'qty', type: 'int', required: true }] },
    ] })));
    ok('order_items keeps its server-written NOT NULL FK', /"order_id" integer not null references/.test(m.ddl), m.ddl.slice(0, 300));
    // FS2 floor: a visitor-writable table without an email column gets one injected (nullable) —
    // the normalized-CRM shape (identity only on `clients`) must never strip the visitor's identity
    const m3 = compile(parseModel(JSON.stringify({ entities: [
      { name: 'attorneys', public: true, fields: [{ name: 'full_name', type: 'text', required: true }] },
      { name: 'appointments', fields: [{ name: 'attorney', type: 'ref:attorneys', required: true }, { name: 'appointment_date', type: 'datetime', required: true }] },
    ] })));
    ok('visitor-writable table without email gets one injected', /create table "appointments"[\s\S]*?"email" text/.test(m3.ddl), m3.ddl.slice(0, 400));
    ok('order_items never gets an injected email', !/create table "order_items"[\s\S]*?"email" text/.test(m.ddl));
    const m4 = compile(parseModel(JSON.stringify({ entities: [
      { name: 'bookings', fields: [{ name: 'customer_name', type: 'text', required: true }, { name: 'email', type: 'email', required: true }] },
    ] })));
    ok('a table that already has email is untouched (no duplicate)', (m4.ddl.match(/"email"/g) || []).length === 1, m4.ddl.slice(0, 300));
    const m2 = compile(parseModel(JSON.stringify({ entities: [
      { name: 'reservations', fields: [{ name: 'customer_name', type: 'text', required: true }] },
      { name: 'preorders', fields: [{ name: 'reservation', type: 'ref:reservations', required: true }, { name: 'item', type: 'text', required: true }] },
    ] })));
    ok('the nullable demotion is loud (compile warning)', m2.warnings.some((w: string) => /reservation_id.*nullable/.test(w)), JSON.stringify(m2.warnings));
    // FS5 floor: split date+time on a booking table merges into ONE timestamp (fields AND seeds)
    const m5 = compile(parseModel(JSON.stringify({ entities: [
      { name: 'reservations', fields: [
        { name: 'customer_name', type: 'text', required: true },
        { name: 'reservation_date', type: 'date', required: true },
        { name: 'reservation_time', type: 'text', required: true },
        { name: 'party_size', type: 'int' }],
        seed: [{ customer_name: 'Seed Guest', reservation_date: '2030-05-04', reservation_time: '6 PM', party_size: 2 }] },
    ] })));
    ok('split date+time merges into one timestamp column', /"reservation_date" timestamptz/.test(m5.ddl) && !/"reservation_time"/.test(m5.ddl), m5.ddl.slice(0, 400));
    // seed hygiene supersedes the seed-merge: reservations is a visitor-record table, so its seeds
    // are STRIPPED entirely (visitors create bookings — the model may not invent them)
    ok('private-table seeds are stripped (nothing to merge)', !(m5.resolved.seedSql['reservations'] || []).length && m5.warnings.some((w: string) => /stripped .*visitor record/.test(w)), JSON.stringify(m5.warnings));
    ok('the merge is loud (compile warning)', m5.warnings.some((w: string) => /canonical booking-time/.test(w)), JSON.stringify(m5.warnings));
    const m6 = compile(parseModel(JSON.stringify({ entities: [
      { name: 'posts', fields: [{ name: 'title', type: 'text', required: true }, { name: 'published_date', type: 'date' }, { name: 'read_time', type: 'text' }] },
    ] })));
    ok('non-booking tables keep their date+time columns untouched', /"published_date" date/.test(m6.ddl) && /"read_time" text/.test(m6.ddl), m6.ddl.slice(0, 300));
  }
  await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Mallory', status: 'confirmed' });
  const mal = (await pool.query(`select status from "${schema}"."bookings" where customer_name='Mallory'`)).rows[0];
  ok("a crafted public POST cannot set status — the row is born 'pending'", !!mal && mal.status === 'pending', String(mal?.status));

  // ---- FS1: the receipt loop, end to end on the real scratch schema ----
  const mk = (slugs: string[], formTable = 'bookings') => ({
    archetype: 'app', shape: 'multi', theme: 'warm',
    brand: { name: 'Chop', tokens: { bg: '#ffffff', primary: '#7a1f1f' } },
    schema_forms: { actionTable: 'bookings' },
    pages: slugs.map(s => ({ slug: s, title: s === 'index' ? 'Home' : s[0].toUpperCase() + s.slice(1) })),
    site: { pages: slugs.map(s => ({ slug: s, title: s, sections: [
      { type: 'hero', headline: 'Fresh fades, zero waiting' },
      s === 'book' ? { type: 'form', table: formTable, form: formTable } : { type: 'features', items: [{ title: 'A', body: 'b' }] }] })) } });
  await pool.query(`insert into projects(id, brief, status, params) values ($1,'app gate scratch','done',$2)`, [id, JSON.stringify(mk(['index', 'book']))]);
{
  const ins = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Rex Receipt', email: 'rex@example.com' });
  ok('insert returns the generated receipt token', ins.ok === true && typeof ins.ref === 'string' && ins.ref.length === 32, JSON.stringify(ins));
  const scoped = await appdb.readScoped(pool, id, 'bookings', 'ref_token', ins.ref!);
  ok('readScoped finds the row by its token', scoped.length === 1 && scoped[0].customer_name === 'Rex Receipt', JSON.stringify(scoped));
  ok('the token itself is stripped from the read (a secret)', !('ref_token' in (scoped[0] || {})));
  ok('a wrong token finds nothing', (await appdb.readScoped(pool, id, 'bookings', 'ref_token', '0'.repeat(32))).length === 0);
  ok('readScoped refuses email scoping on a private table (no enumeration)', (await appdb.readScoped(pool, id, 'bookings', 'email', 'rex@example.com')).length === 0);
  const hit = await appdb.findByToken(pool, id, ins.ref!);
  ok('findByToken resolves the table from just the code', !!hit && hit.table === 'bookings');
  ok('receiptLinksByEmail lists the mailed links (server-internal only)', (await appdb.receiptLinksByEmail(pool, id, 'REX@example.com')).some(l => l.ref === ins.ref));
  ok('the public read API still hides the whole table', (await appdb.readRows(pool, id, 'bookings')).length === 0);
  const { renderLiveReceipt, renderLiveFind } = await import('./cms/live.ts');
  const lr = await renderLiveReceipt(pool, id, 'bookings', ins.ref!);
  ok('receipt page renders the record + code + one nav chrome', !!lr && lr.includes('Rex Receipt') && lr.includes(ins.ref!) && (lr!.match(/class="nav-brand"/g) || []).length === 1, lr ? 'content' : 'null');
  ok('receipt page answers null for a wrong token', (await renderLiveReceipt(pool, id, 'bookings', '0'.repeat(32))) === null);
  const lf = await renderLiveFind(pool, id);
  ok('find page renders paste-code + email-me forms', !!lf && lf.includes('relayFindCode') && lf.includes('relayFindMail'));
  // migration: a pre-receipt table gains the token SAFELY (nullable, no '' backfill, unique-when-present)
  await pool.query(`alter table "${schema}"."bookings" drop column ref_token`);
  await pool.query(`insert into "${schema}"."bookings" (customer_name) values ('Old Row')`);
  const mig = await appdb.migrate(pool, id, MODEL, await appdb.listTables(pool, id));
  ok('migrate adds ref_token to a pre-receipt table', mig.applied.some((a: string) => /ref_token/.test(a)), JSON.stringify(mig.applied));
  const oldRow = (await pool.query(`select ref_token from "${schema}"."bookings" where customer_name='Old Row'`)).rows[0];
  ok("pre-existing rows stay null — never '' backfilled", !!oldRow && oldRow.ref_token === null, String(oldRow?.ref_token));
  ok('new rows on the migrated table get tokens again', !!(await appdb.insertRow(pool, id, 'bookings', { customer_name: 'New Row' })).ref);
}

  // ---- FS2: visitor accounts — magic link, sessions in the app's OWN schema, isolation ----
{
  const V = await import('./visitors.ts');
  const rq = await V.requestVisitorMagic(pool, id, 'ada@example.com');
  ok('magic token minted for a valid email', typeof rq.token === 'string' && rq.token!.length === 32, JSON.stringify(rq));
  ok('junk email refused', !(await V.requestVisitorMagic(pool, id, 'not-an-email')).token);
  const s1 = await V.verifyVisitorMagic(pool, id, rq.token!);
  ok('magic verifies into a session for the right visitor', !!s1 && s1!.visitor.email === 'ada@example.com');
  ok('a magic token is SINGLE-use', (await V.verifyVisitorMagic(pool, id, rq.token!)) === null);
  const who = await V.visitorFromSession(pool, id, s1!.session);
  ok('the session validates server-side', !!who && who!.email === 'ada@example.com');
  ok('a made-up session validates to nobody', (await V.visitorFromSession(pool, id, '0'.repeat(32))) === null);
  const mine = await V.visitorRecords(pool, id, 'ada@example.com');
  ok('My bookings scopes to the verified email — pre-account rows attach', mine.some(r => r.row.customer_name === 'Ada Visitor'), JSON.stringify(mine.map(m => m.row.customer_name)));
  const rqB = await V.requestVisitorMagic(pool, id, 'bob@example.com');
  const sB = await V.verifyVisitorMagic(pool, id, rqB.token!);
  ok('visitor B signs in cleanly', !!sB);
  ok("visitor B sees NONE of A's records (SQL-scoped)", (await V.visitorRecords(pool, id, 'bob@example.com')).length === 0);
  const id2 = randomUUID();
  await appdb.provision(pool, id2, MODEL);
  ok('a session from app A is WORTHLESS on app B', (await V.visitorFromSession(pool, id2, s1!.session)) === null);
  ok('per-app cookie names never collide', V.visitorCookieName(id) !== V.visitorCookieName(id2));
  await pool.query(`drop schema if exists "${appdb.schemaName(id2)}" cascade`).catch(() => {});
  const { renderLiveAccount } = await import('./cms/live.ts');
  const outp = await renderLiveAccount(pool, id, null);
  ok('account page signed out = the sign-in form', !!outp && outp!.includes('relayVisitorRequest'), outp ? 'content' : 'null');
  const inp = await renderLiveAccount(pool, id, s1!.visitor);
  ok('account page signed in = My bookings with the visitor rows + sign out', !!inp && inp!.includes('Ada Visitor') && inp!.includes('relayVisitorLogout'));
  ok('receipt-enabled sites carry the account doors in the footer', !!inp && inp!.includes('href="account.html"') && inp!.includes('href="find.html"'));
  ok('_relay_ tables hidden from the owner content tab', !(await appdb.contentTables(pool, id)).some(t => t.table.startsWith('_relay_')));
  ok('_relay_ tables invisible to the public read API', (await appdb.readRows(pool, id, '_relay_visitors')).length === 0);
}

  // ---- FS3: real booking semantics — truth in the data, not the copy ----
{
  const stat = (await pool.query(`select column_default, is_nullable from information_schema.columns where table_schema='${schema}' and table_name='bookings' and column_name='status'`)).rows[0];
  ok("status compiled in: default 'pending', not null", !!stat && /pending/.test(String(stat.column_default)) && stat.is_nullable === 'NO', JSON.stringify(stat));
  ok('a value outside the closed set cannot even be STORED (CHECK)', !(await pool.query(`insert into "${schema}"."bookings" (customer_name, status) values ('X','sneaky')`).then(() => true).catch(() => false)));
  const rexId = Number((await pool.query(`select id from "${schema}"."bookings" where customer_name='Rex Receipt'`)).rows[0].id);
  ok('the owner confirms a booking through the closed set', await appdb.updateRow(pool, id, 'bookings', rexId, { status: 'confirmed' }));
  ok('the owner cannot set a status outside the closed set', !(await appdb.updateRow(pool, id, 'bookings', rexId, { status: 'yolo' })));
  const past = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Past P', at: '2020-01-01T10:00:00Z' });
  ok('a booking in the past is refused with an actionable message', past.ok === false && /past/.test(past.error || ''), JSON.stringify(past));
  const f1 = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'S1', service_id: 1, at: '2027-01-01T10:00:00Z' });
  ok('first booking of a slot succeeds', f1.ok === true, JSON.stringify(f1));
  const f2 = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'S2', service_id: 1, at: '2027-01-01T10:00:00Z' });
  ok('double-booking the same slot is REFUSED by the server', f2.ok === false && /taken|booked/.test(f2.error || ''), JSON.stringify(f2));
  const f3 = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'S3', service_id: 2, at: '2027-01-01T10:00:00Z' });
  ok('a different resource at the same time books fine', f3.ok === true, JSON.stringify(f3));
  const s1id = Number((await pool.query(`select id from "${schema}"."bookings" where customer_name='S1'`)).rows[0].id);
  await appdb.updateRow(pool, id, 'bookings', s1id, { status: 'cancelled' });
  ok('a cancelled booking frees its slot', (await appdb.insertRow(pool, id, 'bookings', { customer_name: 'S4', service_id: 1, at: '2027-01-01T10:00:00Z' })).ok === true);
  await pool.query(`alter table "${schema}"."services" add column capacity integer`);
  await pool.query(`update "${schema}"."services" set capacity=2 where id=2`);
  ok('capacity 2: the second booking is accepted', (await appdb.insertRow(pool, id, 'bookings', { customer_name: 'C2', service_id: 2, at: '2027-01-01T10:00:00Z' })).ok === true);
  const c3 = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'C3', service_id: 2, at: '2027-01-01T10:00:00Z' });
  ok('capacity 2: the third booking is refused as fully booked', c3.ok === false && /full/.test(c3.error || ''), JSON.stringify(c3));
  // migration resets a legacy auto-confirm default to 'pending' (data untouched)
  await pool.query(`alter table "${schema}"."bookings" alter column "status" set default 'confirmed'`);
  const migS = await appdb.migrate(pool, id, MODEL, await appdb.listTables(pool, id));
  ok("migrate resets a legacy auto-confirm default to 'pending'", migS.applied.some((a: string) => /status.*pending/.test(a)), JSON.stringify(migS.applied));
  const defNow = (await pool.query(`select column_default from information_schema.columns where table_schema='${schema}' and table_name='bookings' and column_name='status'`)).rows[0]?.column_default;
  ok("new rows on migrated tables are born 'pending'", /pending/.test(String(defNow)), String(defNow));
  // seeds with out-of-set statuses are coerced, never a fatal provision (caught on the bakery redemption)
  const id3 = randomUUID();
  await appdb.provision(pool, id3, JSON.stringify({ entities: [
    { name: 'orders', fields: [{ name: 'customer_name', type: 'text' }, { name: 'status', type: 'status' }],
      seed: [{ customer_name: 'Seeded', status: 'preparing' }, { customer_name: 'Seeded2', status: 'Confirmed' }] }] }));
  const seeded = (await pool.query(`select status from "${appdb.schemaName(id3)}"."orders" order by id`)).rows.map((r: any) => r.status);
  // the seed-hygiene floor supersedes status coercion here: ORDERS ARE NEVER SEEDED AT ALL — a
  // canary build shipped three invented customers ('Emma Rodriguez') with fake revenue
  ok('visitor-record seeds never reach the database (fake customers are fiction)', JSON.stringify(seeded) === '[]', JSON.stringify(seeded));
  await pool.query(`drop schema if exists "${appdb.schemaName(id3)}" cascade`).catch(() => {});
  const insN = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Notify N', email: 'notify@example.com' });
  const nid = Number((await pool.query(`select id from "${schema}"."bookings" where customer_name='Notify N'`)).rows[0].id);
  const rc = await appdb.rowContact(pool, id, 'bookings', nid);
  ok('rowContact finds the visitor address + receipt for lifecycle notifications', !!rc && rc!.email === 'notify@example.com' && rc!.ref === insN.ref, JSON.stringify(rc));

  // ---- FS5 · REAL AVAILABILITY: freeSlots is the READ the slot guard always implied ----
  {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Slot Taker', service_id: 1, at: tomorrow + 'T10:00:00' });
    const s1 = await appdb.freeSlots(pool, id, 'bookings', tomorrow, { service_id: 1 });
    ok('freeSlots: the deterministic business grid (09:00–16:00 hourly)', Array.isArray(s1) && s1!.length === 8 && s1![0].t === '09:00' && s1![7].t === '16:00');
    ok('freeSlots: a booked hour is not free', s1!.find(s => s.t === '10:00')?.free === false, JSON.stringify(s1));
    ok('freeSlots: an open hour is free', s1!.find(s => s.t === '11:00')?.free === true);
    const s2 = await appdb.freeSlots(pool, id, 'bookings', tomorrow, { service_id: 2 });
    ok('freeSlots: another resource keeps the hour free', s2!.find(s => s.t === '10:00')?.free === true);
    await pool.query(`update "${schema}"."bookings" set status='cancelled' where customer_name='Slot Taker'`);
    const s3 = await appdb.freeSlots(pool, id, 'bookings', tomorrow, { service_id: 1 });
    ok('freeSlots: a cancelled booking frees its slot', s3!.find(s => s.t === '10:00')?.free === true);
    const past = await appdb.freeSlots(pool, id, 'bookings', '2020-01-01', { service_id: 1 });
    ok('freeSlots: past days offer nothing', !!past && past.every(s => !s.free));
    ok('freeSlots: aggregate availability only (no names, no rows)', JSON.stringify(s1).indexOf('Slot Taker') < 0);
    ok('freeSlots: unknown table → null', (await appdb.freeSlots(pool, id, 'nope', tomorrow, {})) === null);
    ok('freeSlots: a non-slot table → null', (await appdb.freeSlots(pool, id, 'services', tomorrow, {})) === null);
    ok('freeSlots: junk date → null', (await appdb.freeSlots(pool, id, 'bookings', 'tuesday-ish', {})) === null);
    // the renderer side: a timestamp field on a slot table becomes the picker (hidden carries the name)
    const { SECTIONS } = await import('./components.ts');
    const fhtml = SECTIONS.form({ table: 'bookings', form: 'bookings' }, { forms: { bookings: [{ name: 'customer_name', type: 'text', nullable: false }, { name: 'at', type: 'timestamp with time zone', nullable: false }] } } as any);
    ok('slot table form: timestamp renders as date + slot chips', fhtml.includes('data-slotdate="at"') && fhtml.includes('class="slotchips"'), fhtml.slice(0, 200));
    ok('slot table form: the hidden input carries the real field name', fhtml.includes('name="at" data-slot="at"'));
    const nhtml = SECTIONS.form({ table: 'services', form: 'services' }, { forms: { services: [{ name: 'name', type: 'text', nullable: false }, { name: 'available_from', type: 'date', nullable: true }] } } as any);
    ok('non-slot tables keep the plain date input', !nhtml.includes('slotchips'));

    // hours-aware: the grid comes from the model's OWN opening-hours table; a closed day offers nothing
    const id4 = randomUUID();
    await appdb.provision(pool, id4, JSON.stringify({ entities: [
      { name: 'bookings', fields: [{ name: 'customer_name', type: 'text', required: true }, { name: 'at', type: 'datetime', required: true }, { name: 'table_number', type: 'int' }] },
      { name: 'business_hours', public: true, display: 'day', fields: [{ name: 'day', type: 'text', required: true }, { name: 'opens_at', type: 'text' }, { name: 'closes_at', type: 'text' }],
        seed: [{ day: 'Tuesday', opens_at: '10:00', closes_at: '2 PM' }, { day: 'Saturday', opens_at: '9:00', closes_at: '13:00' }] },
    ] }));
    const nextDow = (dow: number) => { const d = new Date(); do { d.setDate(d.getDate() + 1); } while (d.getDay() !== dow); return d.toISOString().slice(0, 10); };
    const tue = await appdb.freeSlots(pool, id4, 'bookings', nextDow(2), {});
    ok('hours table drives the grid (Tue 10:00–2 PM → 10..13)', !!tue && tue.length === 4 && tue[0].t === '10:00' && tue[3].t === '13:00', JSON.stringify(tue));
    const sun = await appdb.freeSlots(pool, id4, 'bookings', nextDow(0), {});
    ok('a closed day offers NOTHING (honest empty, not the default grid)', Array.isArray(sun) && sun.length === 0, JSON.stringify(sun));
    await pool.query(`drop schema if exists "${appdb.schemaName(id4)}" cascade`).catch(() => {});
  }
}

  // ---- site_model gate: a facade page on a data archetype is REJECTED ----
  await pool.query('update projects set params=$2 where id=$1', [id, JSON.stringify(mk(['index', 'book', 'dashboard']))]);
  const bad = await verify(pool, { verify: 'site_model', project_id: id }, '');
  ok('site_model REJECTS a facade page on an app', bad.ok === false && /cannot power/.test(bad.log), bad.log);
  await pool.query('update projects set params=$2 where id=$1', [id, JSON.stringify(mk(['index', 'book'], 'services'))]);
  const wrongT = await verify(pool, { verify: 'site_model', project_id: id }, '');
  ok('site_model REJECTS an app whose only form writes the catalog, not the action table', wrongT.ok === false && /bookings/.test(wrongT.log), wrongT.log);
  await pool.query('update projects set params=$2 where id=$1', [id, JSON.stringify(mk(['index', 'book']))]);
  const good = await verify(pool, { verify: 'site_model', project_id: id }, '');
  ok('site_model accepts the honest app', good.ok === true, good.log);
} catch (e: any) {
  fail++; console.error('  ✗ threw:', e?.message ?? e);
} finally {
  await pool.query(`drop schema if exists "${schema}" cascade`).catch(() => {});
  await pool.query('delete from projects where id=$1', [id]).catch(() => {});
}
// ---- PIPELINE DEPTH (owner: '14 steps are not enough') — policies · calendar · confirmation ----
{
  const id3 = randomUUID();
  const schema3 = 'app_' + id3.replace(/-/g, '').slice(0, 32);
  try {
    // a scratch booking app with a slot table + LOCKED policies (as the policies step would store)
    await pool.query(`insert into projects(id, brief, status, params) values ($1,'depth scratch','done',$2)`,
      [id3, JSON.stringify({ slug: 'depth-scratch-x', policies: { min_notice_hours: 24, cancellation_hours: 24, capacity_per_slot: 2, max_party_size: 8 }, schema_forms: { actionTable: 'appointments' } })]);
    await appdb.provision(pool, id3, JSON.stringify({ entities: [
      { name: 'barbers', public: true, display: 'name', fields: [{ name: 'name', type: 'text', required: true }], seed: [{ name: 'Gino' }] },
      { name: 'appointments', public: false, fields: [
        { name: 'customer_name', type: 'text', required: true },
        { name: 'barber', type: 'ref:barbers', required: true },
        { name: 'starts_at', type: 'datetime', required: true }] },
    ] }));
    // POLICIES: min-notice rejected in the SITE's terms; far-future accepted
    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    const far = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const r1 = await appdb.insertRow(pool, id3, 'appointments', { customer_name: 'A', email: 'a@b.co', barber_id: 1, starts_at: soon });
    ok('policies: a booking inside the min-notice window is REJECTED with the localized rule', !r1.ok && /24h|24 /.test(String(r1.error)), String(r1.error));
    const r2 = await appdb.insertRow(pool, id3, 'appointments', { customer_name: 'B', email: 'b@b.co', barber_id: 1, starts_at: far });
    ok('policies: a compliant booking lands', r2.ok === true, String(r2.error || ''));
    // capacity_per_slot=2: the SAME slot accepts a second booking, rejects the third
    const r3 = await appdb.insertRow(pool, id3, 'appointments', { customer_name: 'C', email: 'c@b.co', barber_id: 1, starts_at: far });
    const r4 = await appdb.insertRow(pool, id3, 'appointments', { customer_name: 'D', email: 'd@b.co', barber_id: 1, starts_at: far });
    ok('policies: capacity_per_slot=2 admits two, rejects the third', r3.ok === true && r4.ok === false, JSON.stringify({ r3: r3.ok, r4: r4.error }));
    // CALENDAR: key mints once, feed carries the real bookings
    const { calKeyFor, buildIcs } = await import('./ics.ts');
    const k1 = await calKeyFor(pool, id3); const k2 = await calKeyFor(pool, id3);
    ok('calendar: the key mints once and is stable', k1 === k2 && /^[0-9a-f]{32}$/.test(k1));
    const ics = await buildIcs(pool, id3);
    ok('calendar: the ICS feed carries exactly the two landed bookings', !!ics && ics.startsWith('BEGIN:VCALENDAR') && (ics.match(/BEGIN:VEVENT/g) || []).length === 2, `events=${(String(ics).match(/BEGIN:VEVENT/g) || []).length}`);
    // CAPACITY RACE (adversarial audit 2026-07-05): three CONCURRENT bookings on one capacity-2 slot must
    // land EXACTLY two — the advisory-locked transaction serializes count-then-insert. Without the lock all
    // three count queries interleave, see room, and all insert (over-booking).
    const raceAt = new Date(Date.now() + 96 * 3_600_000).toISOString();
    const conc = await Promise.all([1, 2, 3].map((n) =>
      appdb.insertRow(pool, id3, 'appointments', { customer_name: 'Race' + n, email: `race${n}@b.co`, barber_id: 1, starts_at: raceAt })));
    ok('capacity race: 3 concurrent bookings on a capacity-2 slot land exactly 2 (advisory lock)', conc.filter((x) => x.ok).length === 2, `landed=${conc.filter((x) => x.ok).length}`);
    // ICS RFC 5545 folding: a long value must fold to ≤75-octet lines with space-prefixed continuations
    const longName = 'Verylongcustomernameengineeredtoforceicalendarcontentlinefoldingpastseventyfiveoctets Smith';
    await appdb.insertRow(pool, id3, 'appointments', { customer_name: longName, email: 'ln@b.co', barber_id: 1, starts_at: new Date(Date.now() + 120 * 3_600_000).toISOString() });
    const ics2 = String(await buildIcs(pool, id3)).split('\r\n');
    ok('ics: every content line is folded to ≤75 octets (RFC 5545 §3.1)', ics2.every((l) => Buffer.byteLength(l, 'utf8') <= 75), 'max=' + Math.max(...ics2.map((l) => Buffer.byteLength(l, 'utf8'))));
    ok('ics: long values continue on space-prefixed fold lines', ics2.some((l) => l.startsWith(' ')));
  } finally {
    await pool.query(`drop schema if exists "${schema3}" cascade`).catch(() => {});
    await pool.query('delete from projects where id=$1', [id3]).catch(() => {});
  }
}
{
  // the DAG grows: an app plan (LLM-less fallback path) must include the two new steps
  process.env.RELAY_PLAN_FALLBACK_TEST = '1';
  const { planTasksForTest } = await import('./planner.ts').catch(() => ({ planTasksForTest: null } as any));
  const server = (await import('node:fs')).readFileSync(new URL('./planner.ts', import.meta.url), 'utf8');
  ok('planner: app plans grow the policies + integrations steps (deterministic injection)', server.includes("department: 'policies'") && server.includes("department: 'integrations'") && server.includes("verify: 'calendar_feed'"));
  const runnerSrc = (await import('node:fs')).readFileSync(new URL('./runner.ts', import.meta.url), 'utf8');
  ok('runner: integrations is a DETERMINISTIC department (no LLM call)', /department === 'integrations'[\s\S]{0,300}deterministic wiring/.test(runnerSrc));
  const serverSrc = (await import('node:fs')).readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  ok('server: calendar.ics route is key-auth\'d + rate-capped', serverSrc.includes('calendar\\.ics') && /wantKey !== haveKey/.test(serverSrc) && /icsM && req\.method === 'GET'[\s\S]{0,200}readLimited/.test(serverSrc));
  ok('server: visitor confirmation mail rides the insert (localized, receipt link)', serverSrc.includes('mail_confirm_subject') && serverSrc.includes("receipt-${dataM[2]}-${r.ref}"));
  ok('server: QA probes never receive real email (caught live: qa@example.com got a confirmation)', serverSrc.includes('!isQaProbe(data)'));
  const mailSrc = (await import('node:fs')).readFileSync(new URL('./mail.ts', import.meta.url), 'utf8').toString();
  ok('mail: ONE probe detector shared by leads and confirmations', mailSrc.includes('export const isQaProbe'));

  // ---- ADVERSARIAL AUDIT 2026-07-05: the newest surfaces (chat rebuild, ICS, twins, probe, race) ----
  const { isQaProbe } = await import('./mail.ts');
  ok('probe: the exact QA marker (probe fields) is caught', isQaProbe({ message: 'Automated QA check — please ignore.' }) === true && isQaProbe({ customer: 'QA Test 3' }) === true);
  ok('probe: a REAL note that only CONTAINS the phrase mid-string is NOT a probe (anchored)', isQaProbe({ notes: 'Loved it — this was not an automated QA check — please ignore situation' }) === false);

  const rebuildSrc = (await import('node:fs')).readFileSync(new URL('./rebuild.ts', import.meta.url), 'utf8');
  ok('rebuild: ONE safe helper — plan BEFORE sweep, never sweep when paused, per-project lock',
    rebuildSrc.includes('REBUILDING.add') && /RELAY_BUILD === '0'[\s\S]{0,80}started: false/.test(rebuildSrc) &&
    rebuildSrc.indexOf('await replan(') < rebuildSrc.indexOf('sweepHtml(projectId)') && rebuildSrc.indexOf('await replan(') > 0);
  ok('rebuild: all three trigger surfaces route through startRebuild (chat, /api/rebuild, tg-door)',
    serverSrc.includes('startRebuild(pool, projectId, amended)') && serverSrc.includes('startRebuild(pool, id, brief || pr.brief)') &&
    (await import('node:fs')).readFileSync(new URL('./tg-door.ts', import.meta.url), 'utf8').includes('startRebuild(pool, pr.id, amended)'));
  ok('server: session creation is rate-capped (no unbounded row spam)', /chat\/sessions'[\s\S]{0,160}limited\(CHAT_HITS/.test(serverSrc));
  ok('server: the rate-limit maps are swept so they cannot grow unbounded', serverSrc.includes('purgeRateMaps') && serverSrc.includes('setInterval(purgeRateMaps'));

  const appdbSrc = (await import('node:fs')).readFileSync(new URL('./appdb.ts', import.meta.url), 'utf8');
  ok('appdb: the slot insert is transactional + advisory-locked (count/insert cannot race)',
    appdbSrc.includes('pg_advisory_xact_lock') && appdbSrc.includes("client.query('commit')") &&
    appdbSrc.indexOf('pg_advisory_xact_lock') < appdbSrc.indexOf("client.query('commit')") &&
    /pg_advisory_xact_lock[\s\S]{0,300}slotGuard\(/.test(appdbSrc));
  ok('appdb: a new column only twins an existing one the model is DROPPING (not one it keeps)', appdbSrc.includes('!wanted.has(hn)'));
  const icsSrc = (await import('node:fs')).readFileSync(new URL('./ics.ts', import.meta.url), 'utf8');
  ok('ics: date-only columns emit VALUE=DATE all-day events', icsSrc.includes('VALUE=DATE') && icsSrc.includes('foldLine'));
}

console.log(`\napp:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

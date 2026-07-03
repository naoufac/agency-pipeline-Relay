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
for (const t of ['bookings', 'orders', 'order_items', 'appointments', 'reservations', 'messages', 'enquiries', 'leads', 'registrations', 'rsvps', 'customers', 'users', 'sessions', 'waitlist', 'waivers', 'deliveries', 'shipments', 'tracking_events', 'payments'])
  ok(`private: ${t}`, PRIVATE_READ.test(t));
for (const t of ['products', 'services', 'menu_items', 'listings', 'posts', 'barbers', 'categories', 'events', 'rooms', 'classes'])
  ok(`public: ${t}`, !PRIVATE_READ.test(t));
for (const s of ['dashboard', 'admin', 'portal', 'client-portal', 'my-account', 'track', 'tracking', 'login', 'sign-in'])
  ok(`facade page: ${s}`, FACADE_PAGE.test(s));
for (const s of ['index', 'shop', 'book', 'services', 'about', 'contact', 'menu', 'checkout', 'cart'])
  ok(`honest page: ${s}`, !FACADE_PAGE.test(s));

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
  { name: 'bookings', fields: [{ name: 'customer_name', type: 'text', required: true }, { name: 'email', type: 'email' }, { name: 'service', type: 'ref:services' }, { name: 'at', type: 'datetime' }] },
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
  await pool.query(`alter table "${schema}"."bookings" add column status text default 'new'`);
  const pubCols = (await appdb.formColumns(pool, id, 'bookings')).map(c => c.name);
  ok('public form never offers "status"', !pubCols.includes('status'), pubCols.join(','));
  const ownCols = (await appdb.formColumns(pool, id, 'bookings', 'owner')).map(c => c.name);
  ok('the owner form keeps "status"', ownCols.includes('status'), ownCols.join(','));
  await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Mallory', status: 'confirmed' });
  const mal = (await pool.query(`select status from "${schema}"."bookings" where customer_name='Mallory'`)).rows[0];
  ok('a crafted public POST cannot set status', mal && mal.status !== 'confirmed', String(mal?.status));

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
console.log(`\napp:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

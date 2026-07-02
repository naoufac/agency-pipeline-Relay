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

  // ---- site_model gate: a facade page on a data archetype is REJECTED ----
  const mk = (slugs: string[]) => ({
    archetype: 'app', shape: 'multi', theme: 'warm',
    pages: slugs.map(s => ({ slug: s, title: s === 'index' ? 'Home' : s[0].toUpperCase() + s.slice(1) })),
    site: { pages: slugs.map(s => ({ slug: s, title: s, sections: [
      { type: 'hero', headline: 'Fresh fades, zero waiting' },
      s === 'book' ? { type: 'form', table: 'bookings', form: 'bookings' } : { type: 'features', items: [{ title: 'A', body: 'b' }] }] })) } });
  await pool.query(`insert into projects(id, brief, status, params) values ($1,'app gate scratch','done',$2)`, [id, JSON.stringify(mk(['index', 'book', 'dashboard']))]);
  const bad = await verify(pool, { verify: 'site_model', project_id: id }, '');
  ok('site_model REJECTS a facade page on an app', bad.ok === false && /cannot power/.test(bad.log), bad.log);
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

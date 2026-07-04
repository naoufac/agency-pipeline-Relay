// content:check — THE PQ3 GATE (a CMS a client can actually use). Proves the content-editing engine
// on a REAL scratch schema: the editable collections are surfaced (system tables hidden), a record
// UPDATE changes the live-read value, a DELETE removes it, ADD inserts, and every unsafe input is
// refused (bad table, secret column, id/created_at immutable, non-existent row). Ownership is proven
// separately in auth:check (a non-owner PATCH is 404). Torn down after. Run: npm run content:check.
import { randomUUID } from 'node:crypto';
import { makePool } from './db.ts';
import * as appdb from './appdb.ts';

const pool = makePool();
const id = randomUUID();
const schema = appdb.schemaName(id);
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

const MODEL = JSON.stringify({ entities: [
  { name: 'products', public: true, display: 'title', fields: [
    { name: 'title', type: 'text', required: true }, { name: 'price', type: 'money', required: true }, { name: 'in_stock', type: 'bool', default: true }],
    seed: [{ title: 'Mug', price: 24, in_stock: true }, { title: 'Bowl', price: 38.5, in_stock: true }] },
  { name: 'orders', fields: [{ name: 'customer_name', type: 'text' }, { name: 'total', type: 'money' }], seed: [{ customer_name: 'Prior Buyer', total: 24 }] },
  { name: 'order_items', fields: [{ name: 'order', type: 'ref:orders' }, { name: 'product', type: 'ref:products' }, { name: 'qty', type: 'int' }] },
] });

try {
  await appdb.provision(pool, id, MODEL);

  // (1) editable collections: products IS content; orders/order_items are hidden system tables
  const colls = await appdb.contentTables(pool, id);
  const names = colls.map(c => c.table);
  ok('products surfaced as editable content', names.includes('products'));
  ok('orders hidden (transactional, not client content)', !names.includes('orders'));
  ok('order_items hidden (join table)', !names.includes('order_items'));
  ok('collection carries a human label + display + count', !!colls.find(c => c.table === 'products' && c.label === 'Products' && c.display === 'title' && c.rows === 2));

  // (2) EDIT a record — the phone check: change a price, read it back changed
  const before = (await appdb.readRows(pool, id, 'products', 50)).find((r: any) => r.title === 'Mug');
  ok('read a product before editing', !!before && Number(before.price) === 24);
  ok('update the price', await appdb.updateRow(pool, id, 'products', before.id, { price: 30 }));
  const after = await appdb.getRow(pool, id, 'products', before.id);
  ok('price is now 30 (edit persisted)', after && Number(after.price) === 30, JSON.stringify(after));
  ok('coerces types on edit (bool from "false")', (await appdb.updateRow(pool, id, 'products', before.id, { in_stock: 'false' })) && (await appdb.getRow(pool, id, 'products', before.id)).in_stock === false);

  // (3) immutable/secret/unknown are refused
  ok('cannot write id', !(await appdb.updateRow(pool, id, 'products', before.id, { id: 999 })));
  ok('cannot write created_at', !(await appdb.updateRow(pool, id, 'products', before.id, { created_at: '2000-01-01' })));
  ok('unknown table refused', !(await appdb.updateRow(pool, id, 'ghosts', 1, { x: 1 })));
  ok('non-existent row → false', !(await appdb.updateRow(pool, id, 'products', 99999, { price: 1 })));
  ok('non-integer id refused', !(await appdb.updateRow(pool, id, 'products', NaN as any, { price: 1 })));

  // (4) ADD + DELETE
  ok('add a record', (await appdb.insertRow(pool, id, 'products', { title: 'Vase', price: 64 })).ok);
  const rowsNow = await appdb.readRows(pool, id, 'products', 50);
  ok('added record is live-readable', rowsNow.some((r: any) => r.title === 'Vase'));
  const vase = rowsNow.find((r: any) => r.title === 'Vase');
  ok('delete a record', await appdb.deleteRow(pool, id, 'products', vase.id));
  ok('deleted record is gone', !(await appdb.getRow(pool, id, 'products', vase.id)));
  ok('delete unknown row → false', !(await appdb.deleteRow(pool, id, 'products', 99999)));

  // (5) a store with only system tables: orders stays hidden, but PAYMENTS v1 means the owner
  // always has exactly ONE editable collection — their payment instructions (injected at compile)
  const bare = randomUUID();
  await appdb.provision(pool, bare, JSON.stringify({ entities: [{ name: 'orders', fields: [{ name: 'customer_name', type: 'text' }] }] }));
  const bareTabs = await appdb.contentTables(pool, bare);
  ok('orders-only store: payment instructions are the one editable collection', bareTabs.length === 1 && bareTabs[0].table === 'payment_options', JSON.stringify(bareTabs));
  ok('orders itself stays hidden from the Content tab', !bareTabs.some((t) => t.table === 'orders'));
  await pool.query(`drop schema if exists "${appdb.schemaName(bare)}" cascade`).catch(() => {});

  // ---- CSV EXPORT: quoting, injection guard, sensitive strip, honest nulls ----
  await appdb.insertRow(pool, id, 'products', { title: 'Comma, "Quoted"', price: 9.5 });
  await appdb.insertRow(pool, id, 'products', { title: '=SUM(A1:A9)', price: 1 });
  const csv = await appdb.exportCsv(pool, id, 'products');
  ok('csv: exports with a BOM + header row', !!csv && csv.charCodeAt(0) === 0xfeff && csv.includes('title'), csv?.slice(0, 40));
  ok('csv: commas and quotes are RFC-quoted', !!csv && csv.includes('"Comma, ""Quoted"""'));
  ok("csv: formula injection is disarmed", !!csv && csv.includes("'=SUM(A1:A9)"));
  ok('csv: sensitive columns never export', !!csv && !/ref_token|password|secret/i.test(csv.split('\r\n')[0]));
  ok('csv: unknown table -> null', (await appdb.exportCsv(pool, id, 'nope')) === null);
  ok('csv: system tables refuse', (await appdb.exportCsv(pool, id, '_relay_visitors')) === null);

  // ---- BLOG: every article gets its own LIVE page (the PDP pattern for content) ----
  const blogId = randomUUID();
  await appdb.provision(pool, blogId, JSON.stringify({ entities: [
    { name: 'posts', public: true, display: 'title', fields: [
      { name: 'title', type: 'text', required: true }, { name: 'body', type: 'longtext' },
      { name: 'excerpt', type: 'text' }, { name: 'author', type: 'text' }],
      seed: [{ title: 'How we roast', body: 'First paragraph about roasting.\n\nSecond paragraph with <script>alert(1)</script> inside.', excerpt: 'Roasting, explained.', author: 'Nao' }] },
    { name: 'subscribers', fields: [{ name: 'full_name', type: 'text' }, { name: 'email', type: 'email', required: true }] },
  ] }));
  await pool.query(`insert into projects(id, brief, status, params) values ($1,'blog gate scratch','done',$2)`, [blogId, JSON.stringify({
    archetype: 'app', theme: 'editorial',
    brand: { name: 'Roastlog', tokens: { bg: '#fbfaf7', primary: '#1c2a3a' } },
    site: { pages: [{ slug: 'index', title: 'Home', sections: [{ type: 'hero', headline: 'Notes' }, { type: 'collection', table: 'posts', title: 'Latest' }] }] },
  })]);
  try {
    const { renderLivePost } = await import('./cms/live.ts');
    const ph = await renderLivePost(pool, blogId, 1);
    ok('blog: the article page renders live from the row', !!ph && ph.includes('How we roast'), String(ph?.length));
    ok('blog: FULL body as paragraphs (never the card slice)', !!ph && ph.includes('First paragraph about roasting.') && ph.includes('Second paragraph'));
    ok('blog: body is textContent-safe (markup stays escaped)', !!ph && !ph.includes('<script>alert') && ph.includes('&lt;script&gt;'));
    ok('blog: byline renders', !!ph && ph.includes('By Nao'));
    ok('blog: back link to the page carrying the collection', !!ph && ph.includes('index.html'));
    ok('blog: unknown post → null (honest 404)', (await renderLivePost(pool, blogId, 999)) === null);
    await appdb.insertRow(pool, blogId, 'subscribers', { full_name: 'R', email: 'reader@example.com' });
    ok('blog: the newsletter list is SEALED from public reads', (await appdb.readRows(pool, blogId, 'subscribers')).length === 0);
    ok('blog: posts stay publicly readable', (await appdb.readRows(pool, blogId, 'posts')).length === 1);
  } finally {
    await pool.query(`drop schema if exists "${appdb.schemaName(blogId)}" cascade`).catch(() => {});
    await pool.query('delete from projects where id=$1', [blogId]).catch(() => {});
  }
} catch (e: any) {
  fail++; console.error('  ✗ threw:', e?.message ?? e);
} finally {
  await pool.query(`drop schema if exists "${schema}" cascade`).catch(() => {});
}
console.log(`\ncontent:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

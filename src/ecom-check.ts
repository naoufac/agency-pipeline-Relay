// ecom:check — THE PQ2 GATE (a store must actually SELL). Deterministic, no LLM, no live server:
//   RENDER layer: products/cart/checkout sections produce the real primitives (shop grid wired to the
//     data API, cart runtime, checkout posting to /api/site/:id/order) and the store guarantee injects
//     them when a composed model forgot.
//   ORDER layer: against a REAL scratch schema — placeOrder writes order + line items in one
//     transaction with SERVER-side pricing (client prices ignored), snapshots unit prices, and
//     rejects bad input (empty cart, unknown product, qty 0, missing name). Torn down after.
// Exit 1 on any failure. Run: npm run ecom:check.
import { randomUUID } from 'node:crypto';
import { makePool } from './db.ts';
import * as appdb from './appdb.ts';
import { renderPage } from './render.ts';
import { normalizeSite } from './spec.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

// ---- RENDER layer ----
const pages = [{ slug: 'index', title: 'Home' }, { slug: 'shop', title: 'Shop' }, { slug: 'cart', title: 'Cart' }, { slug: 'checkout', title: 'Checkout' }];
const shop = renderPage({ brand: { name: 'Kiln', tokens: { bg: '#ffffff', primary: '#7a1f1f' } }, sections: [
  { type: 'hero', headline: 'Handmade ceramics' }, { type: 'products', title: 'The collection', table: 'products' }] },
  { pages, slug: 'shop', title: 'Shop' });
ok('shop grid wired to the products table', shop.includes('data-products="products"'));
ok('shop grid loads via the data API + add-to-cart runtime', shop.includes("'.products[data-products]'") && shop.includes('relayCartAdd'));
const cart = renderPage({ brand: { name: 'Kiln', tokens: {} }, sections: [{ type: 'hero', headline: 'Cart' }, { type: 'cart', title: 'Your cart' }] }, { pages, slug: 'cart', title: 'Cart' });
ok('cart section renders the cart container', cart.includes('data-cart="full"'));
const co = renderPage({ brand: { name: 'Kiln', tokens: {} }, sections: [{ type: 'hero', headline: 'Checkout' }, { type: 'checkout', title: 'Checkout' }] }, { pages, slug: 'checkout', title: 'Checkout' });
ok('checkout renders buyer form + summary', co.includes('data-cart="summary"') && co.includes('relayCheckout') && co.includes('name="customer_name"'));
ok('checkout posts to the ORDER endpoint (server-priced)', co.includes("/order'"));
// the render gate's wiring regex must accept the checkout form (regression: a live store build
// blocked because site_renders only knew relaySubmit)
ok('checkout form counts as WIRED for the render gate', /<form\b[^>]*onsubmit="return relay(submit|checkout)/i.test(co));

// ---- PAYMENTS v1: payment instructions at checkout, owner-editable, LLM never invents details ----
{
  const { parseModel, compile } = await import('./schema.ts');
  const store = compile(parseModel(JSON.stringify({ entities: [
    { name: 'products', public: true, fields: [{ name: 'title', type: 'text', required: true }, { name: 'price', type: 'money', required: true }], seed: [{ title: 'Mug', price: 24 }] },
    { name: 'orders', fields: [{ name: 'customer_name', type: 'text', required: true }, { name: 'email', type: 'email' }] },
  ] })));
  ok('payments: a store model gets payment_options injected', store.tables.includes('payment_options'), store.tables.join(','));
  ok('payments: the one safe seed is pay-on-pickup (never an invented IBAN)', store.ddl.includes('Pay on pickup') && !/iban|bank account \d/i.test(store.ddl));
  ok('payments: the injection is loud', store.warnings.some((w: string) => /payment_options/.test(w)));
  const own = compile(parseModel(JSON.stringify({ entities: [
    { name: 'orders', fields: [{ name: 'customer_name', type: 'text', required: true }] },
    { name: 'payment_methods', public: true, fields: [{ name: 'name', type: 'text', required: true }], seed: [{ name: 'Bank transfer' }] },
  ] })));
  ok("payments: a model's OWN payment table is respected (no duplicate injection)", !own.tables.includes('payment_options'), own.tables.join(','));
  const plain = compile(parseModel(JSON.stringify({ entities: [
    { name: 'bookings', fields: [{ name: 'customer_name', type: 'text', required: true }] },
  ] })));
  ok('payments: non-store models are untouched', !plain.tables.includes('payment_options'));
  ok('payments: checkout carries the "How you\'ll pay" box', co.includes('data-payopts') && co.includes("How you'll pay"));
  ok('payments: the page runtime fills it from payment_options (live read)', co.includes("/data/payment_options'"));
  ok('payments: the box stays hidden when the store has no options', /<div class="payopts" data-payopts hidden>/.test(co));
}

// ---- PDP render layer: one real row -> a full product detail page ----
const pdp = renderPage({ brand: { name: 'Kiln', tokens: { bg: '#ffffff', primary: '#7a1f1f' } }, sections: [
  { type: 'product', row: { id: 3, title: 'Terracotta Mug', price: 24, description: 'Hand-thrown, dishwasher-safe.', material: 'stoneware', weight_grams: 0, _image: '/sites/x/assets/row-abc.jpg' }, back: { slug: 'shop', title: 'Shop' }, cartSlug: 'cart' }] },
  { pages, slug: 'product-3', title: 'Terracotta Mug' });
ok('pdp renders the product name as the page heading', pdp.includes('<h1>Terracotta Mug</h1>'));
ok('pdp shows the server-formatted price', pdp.includes('$24.00'));
ok('pdp shows the FULL description (not the 120-char card slice)', pdp.includes('Hand-thrown, dishwasher-safe.'));
ok('pdp renders the product photo', pdp.includes('src="/sites/x/assets/row-abc.jpg"'));
ok('pdp add-to-cart carries id+title+price into the client cart', pdp.includes('relayCartAdd') && pdp.includes('&quot;id&quot;:3'));
ok('pdp links back to the shop + the cart', pdp.includes('href="shop.html"') && pdp.includes('href="cart.html"'));
ok('pdp extra fields render as labelled meta', pdp.includes('Material') && pdp.includes('stoneware'));
ok('pdp hides zero-valued numeric meta (spec noise)', !pdp.includes('Weight Grams'));
const pdpNoImg = renderPage({ brand: { name: 'Kiln', tokens: {} }, sections: [{ type: 'product', row: { id: 4, title: 'Vase', price: 64 } }] }, { pages, slug: 'product-4', title: 'Vase' });
ok('pdp without a photo shows the branded panel, never a void', pdpNoImg.includes('pdp-noimg'));
ok('shop grid links each card to its product page (products table only)', shop.includes("'product-'+o.id+'.html'") && shop.includes("tbl==='products'"));
// PQ2 stock — render-layer checks (d/e/f)
const pdpSoldOut = renderPage({ brand: { name: 'Kiln', tokens: { bg: '#ffffff', primary: '#7a1f1f' } }, sections: [
  { type: 'product', row: { id: 3, title: 'Vase', price: 64, stock: 0 }, back: { slug: 'shop', title: 'Shop' }, cartSlug: 'cart' }] },
  { pages, slug: 'product-3', title: 'Vase' });
ok('pdp stock-0 renders disabled Sold out button (no add-to-cart onclick)', pdpSoldOut.includes('Sold out') && pdpSoldOut.includes('p-soldout') && !pdpSoldOut.includes('onclick="relayCartAdd'));
const pdpLowStock = renderPage({ brand: { name: 'Kiln', tokens: { bg: '#ffffff', primary: '#7a1f1f' } }, sections: [
  { type: 'product', row: { id: 1, title: 'Mug', price: 24, stock: 3 }, back: { slug: 'shop', title: 'Shop' }, cartSlug: 'cart' }] },
  { pages, slug: 'product-1', title: 'Mug' });
ok('pdp stock 1..5 renders low-stock note', pdpLowStock.includes('Only 3 left'));
ok('shop-grid JS has the sold-out branch', shop.includes('p-soldout') && shop.includes('Sold out'));

// store guarantee: a composed model that FORGOT the store sections gets them injected
{
  const model = { pages: [
    { slug: 'index', title: 'Home', sections: [{ type: 'hero', headline: 'Hi there friend' }, { type: 'features', items: [{ title: 'A', body: 'b' }] }] },
    { slug: 'cart', title: 'Cart', sections: [{ type: 'hero', headline: 'Your cart page' }, { type: 'split', body: 'why buy' }] },
    { slug: 'checkout', title: 'Checkout', sections: [{ type: 'hero', headline: 'Nearly done now' }, { type: 'split', body: 'checkout info' }] },
  ] };
  const r = normalizeSite(model, model.pages.map(p => ({ slug: p.slug, title: p.title })), { archetype: 'store', tables: ['products', 'orders', 'order_items'], forms: { products: [{ name: 'title', type: 'text', nullable: false }] }, primaryTable: 'products' });
  ok('store guarantee: products grid injected', r.site.pages[0].sections.some((s: any) => s.type === 'products'));
  ok('store guarantee: cart injected on cart page', r.site.pages[1].sections.some((s: any) => s.type === 'cart'));
  ok('store guarantee: checkout injected on checkout page', r.site.pages[2].sections.some((s: any) => s.type === 'checkout'));
}

// ---- ORDER layer (real scratch schema) ----
const pool = makePool();
const id = randomUUID();
const schema = appdb.schemaName(id);
const MODEL = JSON.stringify({ entities: [
  { name: 'products', public: true, display: 'title', fields: [{ name: 'title', type: 'text', required: true }, { name: 'price', type: 'money', required: true }, { name: 'stock', type: 'int' }],
    seed: [{ title: 'Mug', price: 24, stock: 3 }, { title: 'Bowl', price: 38.5 }, { title: 'Vase', price: 64, stock: 0 }] },
  { name: 'orders', fields: [{ name: 'customer_name', type: 'text', required: true }, { name: 'email', type: 'email' }, { name: 'phone', type: 'text' }, { name: 'notes', type: 'longtext' }, { name: 'status', type: 'status' }, { name: 'total', type: 'money' }] },
  { name: 'order_items', fields: [{ name: 'order', type: 'ref:orders', required: true }, { name: 'product', type: 'ref:products', required: true }, { name: 'qty', type: 'int', required: true }, { name: 'unit_price', type: 'money' }] },
] });
try {
  await appdb.provision(pool, id, MODEL);
  // the happy path: 2× Mug + 1× Bowl = 2*24 + 38.5 = 86.5 — computed SERVER-side
  const r = await appdb.placeOrder(pool, id, { customer_name: 'Ada Buyer', email: 'ada@example.com', phone: '123', notes: 'gift wrap' }, [{ id: 1, qty: 2 }, { id: 2, qty: 1 }]);
  ok('order placed', r.ok === true, JSON.stringify(r));
  const mugStk = (await pool.query(`select stock from "${schema}"."products" where id=1`)).rows[0];
  ok('successful order decrements stock', Number(mugStk.stock) === 1, String(mugStk.stock));
  ok('total computed server-side (86.5)', r.total === 86.5, String(r.total));
  const orow = (await pool.query(`select customer_name, email, status, total::numeric from "${schema}"."orders" where id=$1`, [r.order])).rows[0];
  ok('order row real (name/email/status/total)', orow && orow.customer_name === 'Ada Buyer' && orow.email === 'ada@example.com' && orow.status === 'new' && Number(orow.total) === 86.5, JSON.stringify(orow));
  const items = (await pool.query(`select product_id, qty, unit_price::numeric from "${schema}"."order_items" where order_id=$1 order by product_id`, [r.order])).rows;
  ok('2 line items with unit-price snapshots', items.length === 2 && Number(items[0].unit_price) === 24 && items[0].qty === 2 && Number(items[1].unit_price) === 38.5, JSON.stringify(items));
  // zero trust in the client: rejects garbage
  ok('rejects empty cart', !(await appdb.placeOrder(pool, id, { customer_name: 'A', email: 'a@b.co' }, [])).ok);
  ok('rejects qty 0', !(await appdb.placeOrder(pool, id, { customer_name: 'A', email: 'a@b.co' }, [{ id: 1, qty: 0 }])).ok);
  ok('rejects unknown product', !(await appdb.placeOrder(pool, id, { customer_name: 'A', email: 'a@b.co' }, [{ id: 999, qty: 1 }])).ok);
  ok('rejects missing name', !(await appdb.placeOrder(pool, id, { email: 'a@b.co' }, [{ id: 1, qty: 1 }])).ok);
  ok('rejects bad email', !(await appdb.placeOrder(pool, id, { customer_name: 'A', email: 'nope' }, [{ id: 1, qty: 1 }])).ok);
  ok('nothing partially written on rejects', Number((await pool.query(`select count(*)::int n from "${schema}"."orders"`)).rows[0].n) === 1);
  // (b) over-stock: Mug now has stock=1, ordering 5 must be rejected with a friendly message
  const rOver = await appdb.placeOrder(pool, id, { customer_name: 'B', email: 'b@b.co' }, [{ id: 1, qty: 5 }]);
  ok('over-stock order rejected with friendly message', rOver.ok === false && /only \d+ of/.test(rOver.error || ''), rOver.error);
  ok('over-stock writes nothing (count and stock unchanged)',
    Number((await pool.query(`select count(*)::int n from "${schema}"."orders"`)).rows[0].n) === 1 &&
    Number((await pool.query(`select stock from "${schema}"."products" where id=1`)).rows[0].stock) === 1);
  // (c) stock-0: Vase is sold out
  const rSold = await appdb.placeOrder(pool, id, { customer_name: 'B', email: 'b@b.co' }, [{ id: 3, qty: 1 }]);
  ok('stock-0 order rejected as sold out', rSold.ok === false && /is sold out/.test(rSold.error || ''), rSold.error);
  // (g) null-stock: Bowl (id=2) has no stock column — must behave exactly as before (unlimited)
  const rNull = await appdb.placeOrder(pool, id, { customer_name: 'B', email: 'b@b.co' }, [{ id: 2, qty: 5 }]);
  ok('product without stock is unlimited (null = untracked)', rNull.ok === true, JSON.stringify(rNull));
  // a non-store schema answers honestly
  const other = randomUUID();
  await appdb.provision(pool, other, JSON.stringify({ entities: [{ name: 'notes', fields: [{ name: 'body', type: 'text' }] }] }));
  ok('non-store site refuses orders honestly', /no store/.test((await appdb.placeOrder(pool, other, { customer_name: 'A', email: 'a@b.co' }, [{ id: 1, qty: 1 }])).error || ''));
  await pool.query(`drop schema if exists "${appdb.schemaName(other)}" cascade`).catch(() => {});
  // ---- ROW IMAGE ENRICHMENT (agency-grade cards) ----
{
  const { rowQuery, localRowImage } = await import('./rowmedia.ts');
  ok('rowQuery uses the product name', rowQuery('products', { title: 'Terracotta Mug' }) === 'terracotta mug');
  ok('rowQuery falls back to the table noun', rowQuery('menu_items', {}) === 'menu items');
  // an already-real image column suppresses enrichment (no override)
  ok('existing image URL wins (no _image override)', localRowImage(id, 'products', { title: 'X', image: '/sites/x/assets/a.jpg' }) === null);
  // no cached file on disk -> no _image (readRows stays clean)
  ok('no cached photo -> no _image attached', localRowImage(id, 'products', { title: 'Nonexistent Widget 9j2' }) === null);
  // write a cached file where localRowImage expects it, then prove attach + readRows surfacing
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const SITES2 = new URL('../sites/', import.meta.url);
  const hashName = (localRowImage as any); // recompute via the module's own naming by reading the returned path
  // insert a product, compute its expected asset path from rowQuery, drop a file there, re-read
  await appdb.insertRow(pool, id, 'products', { title: 'CachedShot Mug', price: 12 });
  const prod = (await appdb.readRows(pool, id, 'products', 50)).find((r) => r.title === 'CachedShot Mug');
  ok('fresh product has no _image yet', !prod._image);
  // derive the asset dir + drop a byte file at the deterministic name (mirror rowmedia: assets/row-<fnv>.jpg)
  function fnv(x){let h=0x811c9dc5;for(let i=0;i<x.length;i++){h^=x.charCodeAt(i);h=Math.imul(h,0x01000193)}return (h>>>0).toString(36)}
  const rel = 'assets/row-' + fnv('cachedshot mug') + '.jpg';
  const dir = fileURLToPath(new URL(id + '/assets/', SITES2)); mkdirSync(dir, { recursive: true });
  writeFileSync(fileURLToPath(new URL(id + '/' + rel, SITES2)), Buffer.alloc(2000, 7));
  const prod2 = (await appdb.readRows(pool, id, 'products', 50)).find((r) => r.title === 'CachedShot Mug');
  ok('readRows attaches _image when the cached file exists', prod2._image === '/sites/' + id + '/' + rel, String(prod2._image));
  await pool.query(`delete from "${schema}"."products" where title='CachedShot Mug'`).catch(()=>{});
}
  // ---- PDP live layer: single-row read + the full detail page from the REAL schema ----
{
  const one = await appdb.readRow(pool, id, 'products', 1);
  ok('readRow returns the product by id (decorated like a card)', !!one && one.title === 'Mug' && Number(one.price) === 24, JSON.stringify(one));
  ok('readRow answers null for an unknown id', (await appdb.readRow(pool, id, 'products', 424242)) === null);
  ok('readRow refuses a bad id honestly', (await appdb.readRow(pool, id, 'products', -1)) === null && (await appdb.readRow(pool, id, 'products', 1.5 as any)) === null);
  const { renderLivePdp } = await import('./cms/live.ts');
  await pool.query(`insert into projects(id, brief, status, params) values ($1,'pdp gate scratch','done',$2)`, [id, JSON.stringify({
    archetype: 'store', theme: 'warm',
    brand: { name: 'Kiln', tokens: { bg: '#ffffff', primary: '#7a1f1f' } },
    site: { pages: [
      { slug: 'index', title: 'Home', sections: [{ type: 'hero', headline: 'Kiln' }] },
      { slug: 'shop', title: 'Shop', sections: [{ type: 'products', table: 'products' }] },
      { slug: 'cart', title: 'Cart', sections: [{ type: 'cart' }] }] } })]);
  const lp = await renderLivePdp(pool, id, 1);
  ok('renderLivePdp serves a full page from the live row', !!lp && lp.includes('<h1>Mug</h1>') && lp.includes('$24.00') && lp.includes('relayCartAdd'), lp ? 'missing content' : 'null');
  ok('renderLivePdp keeps the site chrome (nav + one logo)', !!lp && (lp.match(/class="nav-brand"/g) || []).length === 1 && lp.includes('>Shop<'));
  ok('renderLivePdp back-links to the page carrying the shop grid', !!lp && lp.includes('href="shop.html"'));
  ok('renderLivePdp answers null for a product that does not exist', (await renderLivePdp(pool, id, 424242)) === null);

  // ---- a store the system marks buildable MUST be able to SELL (the checkout-eviction class) ----
  // site_model is the deterministic gate every composed model passes through — prove it rejects a
  // store whose checkout page is missing (the planner cap once evicted it: Proceed button 404'd,
  // buy-probe silently skipped, a store that cannot sell shipped "clean") and accepts a complete one.
  const { verify } = await import('./verify.ts');
  const mkPages = (withCheckout: boolean) => {
    const p = [
      { slug: 'index', title: 'Home', sections: [{ type: 'hero', headline: 'Kiln' }, { type: 'form', table: 'products' }] },
      { slug: 'shop', title: 'Shop', sections: [{ type: 'hero', headline: 'Shop' }, { type: 'products', table: 'products' }] },
      { slug: 'cart', title: 'Cart', sections: [{ type: 'hero', headline: 'Cart' }, { type: 'cart' }] },
    ];
    if (withCheckout) p.push({ slug: 'checkout', title: 'Checkout', sections: [{ type: 'hero', headline: 'Checkout' }, { type: 'checkout' }] } as any);
    return p;
  };
  const setModel = (withCheckout: boolean) => pool.query('update projects set params=$2 where id=$1', [id, JSON.stringify({
    archetype: 'store', shape: 'multi', theme: 'warm',
    pages: mkPages(withCheckout).map(({ slug, title }) => ({ slug, title })),
    site: { pages: mkPages(withCheckout) },
    brand: { name: 'Kiln', tokens: { bg: '#ffffff', primary: '#7a1f1f' } } })]);
  await setModel(true);
  const good = await verify(pool, { verify: 'site_model', project_id: id }, '');
  ok('site_model accepts a complete store (cart + checkout pages)', good.ok === true, good.log);
  await setModel(false);
  const bad = await verify(pool, { verify: 'site_model', project_id: id }, '');
  ok('site_model REJECTS a store missing its checkout page', bad.ok === false && /checkout/.test(bad.log), bad.log);
}
} catch (e: any) {
  fail++; console.error('  ✗ threw:', e?.message ?? e);
} finally {
  await pool.query(`drop schema if exists "${schema}" cascade`).catch(() => {});
  await pool.query('delete from projects where id=$1', [id]).catch(() => {});   // the PDP scratch project row
}
console.log(`\necom:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

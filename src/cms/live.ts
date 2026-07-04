// LIVE CMS serving — render a CMS-backed page FRESH from the CMS on every request, through the same
// deterministic renderPage. This is what makes a produced site a real CMS site: edit the content in
// the CMS and the live page changes on the next load, with NO rebuild. Returns null for non-CMS
// projects (the caller then serves the static file as before).
import pg from 'pg';
import { renderPage, formPageSlug, receiptsEnabled } from '../render.ts';
import { processMedia } from '../media.ts';
import { brandFor } from './util.ts';
import { SITES } from '../verify.ts';
import * as appdb from '../appdb.ts';
import { PRIVATE_READ } from '../schema.ts';
import { themeTone } from '../themes.ts';

const env = () => ({ url: process.env.DIRECTUS_URL || 'http://127.0.0.1:8055', token: process.env.DIRECTUS_TOKEN || '' });

export async function renderLiveFromCms(pool: pg.Pool, projectId: string, slug: string): Promise<string | null> {
  const pr = (await pool.query('select params from projects where id=$1', [projectId])).rows[0];
  if (!pr) return null;
  const params = pr.params || {};
  if (!params.cms_built || !params.site || !Array.isArray(params.site.pages) || !params.site.pages.length) return null;

  const { url, token } = env();
  const q = `${url}/items/pages?filter[project_id][_eq]=${encodeURIComponent(projectId)}&filter[slug][_eq]=${encodeURIComponent(slug)}&fields=id,title,slug,sections&limit=1`;
  let row: any;
  try {
    const res = await fetch(q, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    row = (await res.json())?.data?.[0];
  } catch { return null; }
  if (!row || !Array.isArray(row.sections)) return null;

  const navPages = params.site.pages.map((p: any) => ({ slug: p.slug, title: p.title }));
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections: row.sections };
  // M2: pass the schema snapshot — without it a typed form silently degrades to the contact fallback
  const sf = params.schema_forms || {};
  let html = renderPage(spec, { pages: navPages, slug, title: row.title, projectId, theme: params.theme || 'modern', layout: params.layout, forms: sf.forms, primaryTable: sf.primaryTable, formSlug: formPageSlug(params.site), accountLinks: receiptsEnabled(params.site) });
  try { html = await processMedia(html, new URL(projectId + '/', SITES)); } catch { /* image-light or no key */ }
  return `<!--relay:cms=directus LIVE doc=${row.id} (rendered from CMS on request)-->\n` + html;
}

// PDP (PQ2) — product-<id>.html rendered FRESH from the live product row on every request, through the
// same deterministic renderPage + site chrome (nav/footer/brand/theme come from the locked site model).
// No CMS page row, no static file: the product IS the source, so a price/photo/description edit in the
// owner's Content tab shows on the very next load. Purely a projection — no LLM anywhere in this path.
// Returns null (-> honest 404) when the project isn't a store or the product doesn't exist.
export async function renderLivePdp(pool: pg.Pool, projectId: string, productId: number): Promise<string | null> {
  const pr = (await pool.query('select params from projects where id=$1', [projectId])).rows[0];
  if (!pr) return null;
  const params = pr.params || {};
  // ANY archetype with a products table gets detail pages (a taqueria's dish page is real content —
  // a canary caught 12 grid links 404ing because this was store-only). Cart controls stay store-only.
  const isStore = String(params.archetype) === 'store';
  if (!params.site || !Array.isArray(params.site.pages) || !params.site.pages.length) return null;
  const row = await appdb.readRow(pool, projectId, 'products', productId);   // the deterministic store contract table
  if (!row) return null;
  const navPages = params.site.pages.map((p: any) => ({ slug: p.slug, title: p.title }));
  // back-link to the page that actually CARRIES the products grid (the composed model), never a slug
  // guess — and when the grid is on several pages (home + shop), prefer the dedicated one over home.
  const prodPages = params.site.pages.filter((p: any) => (p.sections || []).some((s: any) => s.type === 'products'));
  const withProducts = prodPages.find((p: any) => p.slug !== 'index') || prodPages[0];
  const back = withProducts ? { slug: withProducts.slug, title: withProducts.title } : navPages[0];
  const cartPage = navPages.find((p: any) => /cart|basket|bag/.test(String(p.slug)));
  const title = String(row.title || row.name || 'Product #' + productId);
  const variants = await appdb.productVariants(pool, projectId, productId);   // PQ2 · options picker
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections: [{ type: 'product', row, back, cartSlug: isStore ? cartPage?.slug : undefined, variants, store: isStore }] };
  const html = renderPage(spec, { pages: navPages, slug: 'product-' + productId, title, projectId, theme: params.theme || 'modern', layout: params.layout, formSlug: formPageSlug(params.site), accountLinks: receiptsEnabled(params.site) });
  return `<!--relay:cms=directus LIVE pdp=${productId} (rendered from the live product row on request)-->\n` + html;
}

const singular = (t: string) => humanizeTable(t).replace(/ies$/i, 'y').replace(/s$/i, '');
const humanizeTable = (t: string) => String(t).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// BLOG — post-<id>.html rendered FRESH from the live article row (the PDP pattern for content):
// title, date, cover, FULL body as paragraphs. Write in the Content tab → the article page changes
// on the next load. Works for whichever content table the model shipped (posts/articles/news/…).
const BLOG_TABLE = /^(posts|articles|news|stories|guides|recipes)$/i;
export async function renderLivePost(pool: pg.Pool, projectId: string, postId: number): Promise<string | null> {
  const pr = (await pool.query('select params from projects where id=$1', [projectId])).rows[0];
  if (!pr) return null;
  const params = pr.params || {};
  if (!params.site || !Array.isArray(params.site.pages) || !params.site.pages.length) return null;
  const tables = (await appdb.listTables(pool, projectId)).filter(t => BLOG_TABLE.test(t));
  if (!tables.length) return null;
  let row: any = null; let table = '';
  for (const t of tables) { row = await appdb.readRow(pool, projectId, t, postId); if (row) { table = t; break; } }
  if (!row) return null;
  const navPages = params.site.pages.map((p: any) => ({ slug: p.slug, title: p.title }));
  // back to the page that CARRIES the article collection (blog/journal/news), else home
  const blogPages = params.site.pages.filter((p: any) => (p.sections || []).some((s: any) => s.type === 'collection' && BLOG_TABLE.test(String(s.table || ''))));
  const withBlog = blogPages.find((p: any) => p.slug !== 'index') || blogPages[0];
  const back = withBlog ? { slug: withBlog.slug, title: withBlog.title } : navPages[0];
  const title = String(row.title || row.name || row.headline || 'Post #' + postId);
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections: [{ type: 'article', row, back, label: singular(table) }] };
  const html = renderPage(spec, { pages: navPages, slug: 'post-' + postId, title, projectId, theme: params.theme || 'modern', layout: params.layout, formSlug: formPageSlug(params.site), accountLinks: receiptsEnabled(params.site) });
  return `<!--relay:cms=directus LIVE post=${postId} (rendered from the live article row on request)-->\n` + html;
}

// FS1 — the RECEIPT: receipt-<table>-<token>.html rendered fresh from the visitor's own row, keyed
// by the secret reference token in their URL. The row itself never exposes the token (reads strip
// it); the page displays the code FROM the URL. Wrong token -> null -> honest 404.
export async function renderLiveReceipt(pool: pg.Pool, projectId: string, table: string, token: string): Promise<string | null> {
  const pr = (await pool.query('select params from projects where id=$1', [projectId])).rows[0];
  if (!pr) return null;
  const params = pr.params || {};
  if (!params.site || !Array.isArray(params.site.pages) || !params.site.pages.length) return null;
  const rows = await appdb.readScoped(pool, projectId, table, 'ref_token', token, 1);
  if (!rows.length) return null;
  const navPages = params.site.pages.map((p: any) => ({ slug: p.slug, title: p.title }));
  const backSlug = formPageSlug(params.site) || navPages[0].slug;
  const back = navPages.find((p: any) => p.slug === backSlug) || navPages[0];
  // PAYMENTS: an ORDER receipt repeats the store's payment instructions — the visitor who closed
  // the checkout tab still knows how to pay (read live from the owner-editable table).
  let payinfo: any[] = [];
  if (/^orders?$/i.test(table)) {
    try { payinfo = (await appdb.readRows(pool, projectId, 'payment_options', 6)).filter((o: any) => o && o.name && o.active !== false); } catch {}
  }
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections: [
    { type: 'record', row: rows[0], refCode: token, back, findSlug: 'find', findTitle: 'Find my booking', eyebrow: singular(table) + ' received', title: 'Your ' + singular(table).toLowerCase() + ' is in', payinfo }] };
  const html = renderPage(spec, { pages: navPages, slug: 'receipt', title: 'Your ' + singular(table).toLowerCase(), projectId, theme: params.theme || 'modern', layout: params.layout, formSlug: formPageSlug(params.site), accountLinks: receiptsEnabled(params.site) });
  return `<!--relay:cms=directus LIVE receipt (rendered from the visitor's own row on request)-->\n` + html;
}

// FS1 — FIND MY BOOKING: find.html, served live with the site's own chrome. Paste the code, or ask
// for the links by email (always answers "sent" — no enumeration).
export async function renderLiveFind(pool: pg.Pool, projectId: string): Promise<string | null> {
  const pr = (await pool.query('select params from projects where id=$1', [projectId])).rows[0];
  if (!pr) return null;
  const params = pr.params || {};
  if (!params.site || !Array.isArray(params.site.pages) || !params.site.pages.length) return null;
  if (!['app', 'store'].includes(String(params.archetype))) return null;
  const navPages = params.site.pages.map((p: any) => ({ slug: p.slug, title: p.title }));
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections: [{ type: 'find', title: 'Find my booking' }] };
  const html = renderPage(spec, { pages: navPages, slug: 'find', title: 'Find my booking', projectId, theme: params.theme || 'modern', layout: params.layout, formSlug: formPageSlug(params.site), accountLinks: receiptsEnabled(params.site) });
  return `<!--relay:cms=directus LIVE find (system page)-->\n` + html;
}

// CHAIN — HOW IT WAS BUILT: the production record as a product surface (owner-directed 2026-07-04:
// "the magic is the chain"). Served live for ANY finished project — old sites included — with the
// site's own chrome. Everything rendered is CURATED here from a closed whitelist: names, counts,
// verdicts and the brief. Never task outputs, never event detail text, never emails or tokens.
const VERIFY_WORDS: Record<string, string> = {
  render: 'every page renders correctly, desktop and mobile',
  site_renders: 'every page renders correctly, desktop and mobile',
  sql_applies: 'the database schema applies cleanly to a real PostgreSQL',
  site_consistent: 'one brand, one navigation — identical on every page',
  served_from_cms: 'pages are served from the CMS, not from stale copies',
  json_valid: 'every structured hand-off parsed and validated',
  none: '',
};
export async function renderLiveChain(pool: pg.Pool, projectId: string): Promise<string | null> {
  const pr = (await pool.query('select brief, created_at, params from projects where id=$1', [projectId])).rows[0];
  if (!pr) return null;
  const params = pr.params || {};
  if (!params.site || !Array.isArray(params.site.pages) || !params.site.pages.length) return null;
  const navPages = params.site.pages.map((p: any) => ({ slug: p.slug, title: p.title }));

  const tk = (await pool.query(
    `select count(*)::int total,
            coalesce(sum(case when status='done' then 1 else 0 end),0)::int done,
            coalesce(sum(greatest(attempts-1,0)),0)::int retries,
            coalesce(extract(epoch from (max(updated_at)-min(created_at))),0)::int wall,
            array_agg(distinct verify) as verifies
     from tasks where project_id=$1`, [projectId])).rows[0] || {};
  const evs = (await pool.query(
    `select type, count(*)::int n from run_events where project_id=$1 and type in ('plan_repair','project_retry') group by type`,
    [projectId])).rows;
  const evn = (t: string) => evs.find((e: any) => e.type === t)?.n || 0;
  const rev = (await pool.query('select passed, coalesce(jsonb_array_length(issues),0)::int n from dogfood_reviews where project_id=$1 order by id desc limit 1', [projectId])).rows[0];

  const archetype = String(params.archetype || 'site');
  const KIND: Record<string, string> = {
    app: 'a real application — its own database, forms compiled from the schema, receipts and accounts',
    store: 'a real store — live catalog, cart, server-priced checkout',
    site: 'a presentation site — every page verified',
  };
  let tables: { name: string; rows: number; isPrivate: boolean }[] = [];
  if (archetype === 'app' || archetype === 'store') {
    try {
      const desc = await appdb.describeSchema(pool, projectId);
      tables = (desc.tables || []).filter((t: any) => !/^_relay_/.test(t.table)).slice(0, 12)
        .map((t: any) => ({ name: t.table, rows: Number(t.rows) || 0, isPrivate: PRIVATE_READ.test(t.table) }));
    } catch { /* schema may be gone on legacy projects — the page stands without it */ }
  }
  const checks = [...new Set(((tk.verifies || []) as any[]).map((v) => VERIFY_WORDS[String(v)] ?? '').filter(Boolean))];
  checks.push('privacy: visitor records are never publicly listable');
  if (archetype === 'store') checks.push('a real browser BOUGHT from this store before it shipped (order + line items verified in the database)');
  if (archetype === 'app') checks.push('a real browser performed the core action and followed its receipt before this site shipped');

  const scope = params.scope && Array.isArray(params.scope.includes) ? {
    difficulty: Number(params.scope.difficulty) || 1,
    includes: params.scope.includes.map((i: any) => ({ name: String(i.name || ''), promise: String(i.promise || '') })).slice(0, 9),
    excludes: (params.scope.excludes || []).map((x: any) => ({ ask: String(x.ask || ''), alternative: String(x.alternative || '') })).slice(0, 6),
  } : null;

  const sections = [{
    type: 'chain',
    brief: String(pr.brief || ''),
    scope,
    blueprint: {
      kind: KIND[archetype] || KIND.site,
      theme: String(params.theme || 'modern'),
      tone: themeTone((params.theme && ['editorial','modern','warm','bold','minimal'].includes(params.theme)) ? params.theme : 'modern'),
      hero: params.layout?.hero ? String(params.layout.hero) : '',
      nav: params.layout?.nav ? String(params.layout.nav) : '',
      bg: params.brand?.tokens?.bg, primary: params.brand?.tokens?.primary,
    },
    tables,
    run: { total: Number(tk.total) || 0, done: Number(tk.done) || 0, wallSecs: Number(tk.wall) || 0, repairs: evn('plan_repair'), rebuilds: evn('project_retry') },
    checks,
    review: rev ? { passed: !!rev.passed, issues: Number(rev.n) || 0, probed: archetype !== 'site' } : null,
  }];
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections };
  const html = renderPage(spec, { pages: navPages, slug: 'how-it-was-built', title: 'How this site was built', projectId, theme: params.theme || 'modern', layout: params.layout, formSlug: formPageSlug(params.site), accountLinks: receiptsEnabled(params.site) });
  return `<!--relay:cms=directus LIVE chain (the production record, rendered from the pipeline's own database)-->\n` + html;
}

// FS2 — MY BOOKINGS: account.html, served live. Signed out -> the sign-in (magic link) form; signed
// in -> the visitor's records across the app's private tables, each opening its own receipt. The
// visitor rides in from the route (validated server-side against the app's OWN token table).
export async function renderLiveAccount(pool: pg.Pool, projectId: string, visitor: { id: number; email: string } | null): Promise<string | null> {
  const pr = (await pool.query('select params from projects where id=$1', [projectId])).rows[0];
  if (!pr) return null;
  const params = pr.params || {};
  if (!params.site || !Array.isArray(params.site.pages) || !params.site.pages.length) return null;
  if (!['app', 'store'].includes(String(params.archetype))) return null;
  const navPages = params.site.pages.map((p: any) => ({ slug: p.slug, title: p.title }));
  let sections: any[];
  if (!visitor) sections = [{ type: 'signin', title: 'Sign in' }];
  else {
    const { visitorRecords } = await import('../visitors.ts');
    const items = await visitorRecords(pool, projectId, visitor.email);
    sections = [{ type: 'records', title: 'My bookings', email: visitor.email, items }];
  }
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections };
  const html = renderPage(spec, { pages: navPages, slug: 'account', title: visitor ? 'My bookings' : 'Sign in', projectId, theme: params.theme || 'modern', layout: params.layout, formSlug: formPageSlug(params.site), accountLinks: receiptsEnabled(params.site) });
  return `<!--relay:cms=directus LIVE account (system page)-->\n` + html;
}

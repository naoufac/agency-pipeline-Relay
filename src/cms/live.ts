// LIVE CMS serving — render a CMS-backed page FRESH from the CMS on every request, through the same
// deterministic renderPage. This is what makes a produced site a real CMS site: edit the content in
// the CMS and the live page changes on the next load, with NO rebuild. Returns null for non-CMS
// projects (the caller then serves the static file as before).
import pg from 'pg';
import { renderPage, formPageSlug } from '../render.ts';
import { processMedia } from '../media.ts';
import { brandFor } from './util.ts';
import { SITES } from '../verify.ts';
import * as appdb from '../appdb.ts';

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
  let html = renderPage(spec, { pages: navPages, slug, title: row.title, projectId, theme: params.theme || 'modern', layout: params.layout, forms: sf.forms, primaryTable: sf.primaryTable, formSlug: formPageSlug(params.site) });
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
  if (String(params.archetype) !== 'store') return null;
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
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections: [{ type: 'product', row, back, cartSlug: cartPage?.slug }] };
  const html = renderPage(spec, { pages: navPages, slug: 'product-' + productId, title, projectId, theme: params.theme || 'modern', layout: params.layout, formSlug: formPageSlug(params.site) });
  return `<!--relay:cms=directus LIVE pdp=${productId} (rendered from the live product row on request)-->\n` + html;
}

const singular = (t: string) => humanizeTable(t).replace(/ies$/i, 'y').replace(/s$/i, '');
const humanizeTable = (t: string) => String(t).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

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
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections: [
    { type: 'record', row: rows[0], refCode: token, back, findSlug: 'find', findTitle: 'Find my booking', eyebrow: singular(table) + ' received', title: 'Your ' + singular(table).toLowerCase() + ' is in' }] };
  const html = renderPage(spec, { pages: navPages, slug: 'receipt', title: 'Your ' + singular(table).toLowerCase(), projectId, theme: params.theme || 'modern', layout: params.layout, formSlug: formPageSlug(params.site) });
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
  const html = renderPage(spec, { pages: navPages, slug: 'find', title: 'Find my booking', projectId, theme: params.theme || 'modern', layout: params.layout, formSlug: formPageSlug(params.site) });
  return `<!--relay:cms=directus LIVE find (system page)-->\n` + html;
}

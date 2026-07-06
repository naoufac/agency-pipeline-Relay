// Directus adapter — CmsTarget #1. A site is built ON a real, running Directus instance:
// content lives in a `pages` collection, and buildAndServe renders each page FROM a CMS read
// (never from the in-memory model), through Relay's existing deterministic renderPage.
//
// Infra: ONE shared Directus (DIRECTUS_URL, static DIRECTUS_TOKEN on the admin user), backed by the
// existing Postgres. Per-project isolation = rows filtered by project_id in the shared collection
// (Directus collection-level multi-tenancy). See docs/CMS-ARCHITECTURE.md.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderPage, formPageSlug, receiptsEnabled } from '../render.ts';
import { processMedia } from '../media.ts';
import { servedPath, brandFor, heroHeadline } from './util.ts';
import type { CmsTarget, CmsInstance, SiteModel, BuildCtx } from './types.ts';

const COLLECTION = 'pages';
const env = () => ({ url: process.env.DIRECTUS_URL || 'http://127.0.0.1:8055', token: process.env.DIRECTUS_TOKEN || '' });

// One authenticated request against the Directus HTTP API. Throws on non-2xx (the gate relies on this).
async function dx(method: string, p: string, body?: any): Promise<any> {
  const { url, token } = env();
  const res = await fetch(url + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`directus ${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

const byProjectSlug = (projectId: string, slug: string) =>
  `/items/${COLLECTION}?filter[project_id][_eq]=${encodeURIComponent(projectId)}&filter[slug][_eq]=${encodeURIComponent(slug)}&fields=id,title,slug,sections&limit=1`;

export const directus: CmsTarget = {
  id: 'directus',

  async provision(ctx: BuildCtx): Promise<CmsInstance> {
    const { url } = env();
    return { cms: 'directus', projectId: ctx.projectId, baseUrl: url, namespace: COLLECTION, healthUrl: url + '/server/health', tokenRef: 'DIRECTUS_TOKEN' };
  },

  async healthcheck(_inst: CmsInstance): Promise<{ ok: boolean; detail: string }> {
    try { const me = await dx('GET', '/users/me?fields=email'); return { ok: true, detail: `auth ok (${me?.data?.email || '?'})` }; }
    catch (e: any) { return { ok: false, detail: String(e?.message ?? e) }; }
  },

  // Ensure the `pages` collection exists with the fields Relay needs. Idempotent (create-if-missing).
  async modelContentTypes(_inst: CmsInstance, _model: SiteModel, _ctx: BuildCtx): Promise<{ types: string[] }> {
    let exists = true;
    try { await dx('GET', `/collections/${COLLECTION}`); } catch { exists = false; }
    if (!exists) {
      await dx('POST', '/collections', {
        collection: COLLECTION,
        meta: { singleton: false, note: 'Relay page content (one row per project page)' },
        schema: {},
        fields: [
          { field: 'id', type: 'integer', meta: { hidden: true }, schema: { is_primary_key: true, has_auto_increment: true } },
          { field: 'project_id', type: 'string', meta: { interface: 'input' }, schema: {} },
          { field: 'slug', type: 'string', meta: { interface: 'input' }, schema: {} },
          { field: 'title', type: 'string', meta: { interface: 'input' }, schema: {} },
          { field: 'sections', type: 'json', meta: { interface: 'input-code' }, schema: {} },
        ],
      });
    }
    return { types: [COLLECTION] };
  },

  // Upsert each page (keyed by project_id+slug) as a real CMS document. The CMS holds REAL content:
  // the internal {{brand}} token is substituted with the locked name BEFORE storing (an editor must
  // see "Sign in to Acme", never a template token — and the servedFromCms gate compares CMS fields
  // against served text, so a stored token can never match).
  async pushContent(_inst: CmsInstance, model: SiteModel, ctx: BuildCtx): Promise<{ ids: Record<string, string[]> }> {
    const ids: Record<string, string[]> = { [COLLECTION]: [] };
    const name = String(brandFor(model)?.name || 'Studio');
    const fill = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/\{\{\s*brand\s*\}\}/gi, JSON.stringify(name).slice(1, -1)));
    for (const page of model.pages) {
      const title = fill(heroHeadline(page));
      const found = await dx('GET', byProjectSlug(ctx.projectId, page.slug));
      const row = found?.data?.[0];
      const payload = { project_id: ctx.projectId, slug: page.slug, title, sections: fill(page.sections) };
      let id: any;
      if (row) { await dx('PATCH', `/items/${COLLECTION}/${row.id}`, payload); id = row.id; }
      else { const r = await dx('POST', `/items/${COLLECTION}`, payload); id = r.data.id; }
      ids[COLLECTION].push(String(id));
    }
    // M3: sweep STALE CMS rows from a previous generation — slugs no longer in the model would keep
    // serving an outdated page (old nav, old brand) through the live path.
    try {
      const all = await dx('GET', `/items/${COLLECTION}?filter[project_id][_eq]=${encodeURIComponent(ctx.projectId)}&fields=id,slug&limit=200`);
      const live = new Set(model.pages.map(p => p.slug));
      for (const row of (all?.data || [])) if (!live.has(String(row.slug))) await dx('DELETE', `/items/${COLLECTION}/${row.id}`);
    } catch { /* sweep is best-effort; the gate still validates current pages */ }
    return { ids };
  },

  async readBack(_inst: CmsInstance, slug: string, ctx: BuildCtx): Promise<{ docId: string; fields: Record<string, string> }> {
    const r = await dx('GET', byProjectSlug(ctx.projectId, slug));
    const row = r?.data?.[0];
    if (!row) throw new Error(`directus readBack: no CMS row for ${ctx.projectId}/${slug}`);
    return { docId: String(row.id), fields: { title: String(row.title ?? ''), slug: String(row.slug ?? '') } };
  },

  // Build each page by FETCHING it back out of the CMS, then rendering through the SAME renderPage.
  async buildAndServe(_inst: CmsInstance, model: SiteModel, ctx: BuildCtx): Promise<{ pages: Record<string, string> }> {
    const out: Record<string, string> = {};
    const dir = path.join(ctx.sitesDir, ctx.projectId);
    mkdirSync(dir, { recursive: true });
    const navPages = model.pages.map(p => ({ slug: p.slug, title: p.title }));
    for (const page of model.pages) {
      const r = await dx('GET', byProjectSlug(ctx.projectId, page.slug));
      const row = r?.data?.[0];
      if (!row) throw new Error(`directus buildAndServe: no CMS row for ${page.slug}`);
      const spec = { brand: brandFor(model), sections: row.sections };
      // M2: the schema snapshot rides along — a typed form must survive the CMS re-serve
      const html = renderPage(spec, { pages: navPages, slug: page.slug, title: row.title || page.title, projectId: ctx.projectId, theme: ctx.theme, layout: (ctx as any).layout, forms: ctx.schemaForms?.forms, primaryTable: ctx.schemaForms?.primaryTable, formSlug: formPageSlug(model), accountLinks: receiptsEnabled(model), locale: (ctx as any).locale, siteBase: ctx.siteBase, localBusiness: !!ctx.localBusiness, bizType: ctx.bizType, bizFacts: ctx.bizFacts });
      // localize any remote images into the site dir (gate-safe), best-effort.
      let body = html;
      try { body = await processMedia(html, pathToFileURL(dir + path.sep)); } catch { /* image-light page or no key: ship as-is */ }
      // provenance: ties this served file to the exact CMS document it was rendered from.
      const stamped = `<!--relay:cms=directus doc=${row.id}-->\n` + body;
      writeFileSync(servedPath(ctx, page.slug), stamped);
      out[page.slug] = servedPath(ctx, page.slug);
    }
    return { pages: out };
  },

  // Release this project's footprint: delete its rows. purge=false keeps them for audit.
  async teardown(inst: CmsInstance, opts?: { purge?: boolean }): Promise<void> {
    if (opts?.purge === false) return;
    const r = await dx('GET', `/items/${COLLECTION}?filter[project_id][_eq]=${encodeURIComponent(inst.projectId)}&fields=id&limit=-1`);
    const ids = (r?.data ?? []).map((x: any) => x.id);
    if (ids.length) await dx('DELETE', `/items/${COLLECTION}`, ids);
  },
};

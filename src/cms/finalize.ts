// CMS FINALIZE — make a project's served site genuinely CMS-served, and record the proof on the board.
// Additive + guarded: it re-serves the already-composed site (params.site) THROUGH the chosen CMS and
// runs the served_from_cms gate. On any failure the existing static files are left as-is (never breaks
// a build). The chosen CMS is params.cms (set by the selector at plan time); if that CMS isn't
// operational yet, resolveBuildable falls back to the proven Directus and the event says so — no faking.
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { resolveBuildable } from './registry.ts';
import { servedFromCms } from './gate.ts';
import { isCmsName, type SiteModel, type BuildCtx, type CmsName } from './types.ts';
import { SITES } from '../verify.ts';
import { ev } from '../db.ts';

export interface FinalizeResult { ok: boolean; cms: string; builtOn?: string; fellBackFrom?: string | null; log: string; }

export async function cmsFinalize(pool: pg.Pool, projectId: string, sitesDirOverride?: string): Promise<FinalizeResult> {
  const r = (await pool.query('select brief, params from projects where id=$1', [projectId])).rows[0];
  if (!r) return { ok: false, cms: '?', log: 'no such project' };
  const params = r.params || {};
  const site = params.site;
  if (!site || !Array.isArray(site.pages) || !site.pages.length)
    return { ok: false, cms: String(params.cms ?? '?'), log: 'no composed site model (params.site) — nothing to finalize' };

  const chosen: CmsName = isCmsName(params.cms) ? params.cms : 'directus';
  const { name: builtOn, entry, fellBackFrom } = resolveBuildable(chosen);
  const sitesDir = sitesDirOverride || fileURLToPath(SITES);
  const ctx: BuildCtx = { projectId, brief: r.brief, archetype: params.archetype || 'site', theme: params.theme || 'modern', sitesDir, schemaForms: params.schema_forms, layout: params.layout, locale: params.locale };
  const model: SiteModel = { pages: site.pages, brand: params.brand || site.brand, data: site.data };
  const tag = fellBackFrom ? `assigned ${fellBackFrom} (not operational yet) → built on ${builtOn}` : `built on ${builtOn}`;

  // agency-grade: give every DB-backed card a real photo (once, cached) BEFORE the site is served —
  // so product/collection grids are visual, not text-on-white. Best-effort; never blocks the build.
  try {
    const { contentTables } = await import('../appdb.ts');
    const { enrichRowImages } = await import('../rowmedia.ts');
    const cts = await contentTables(pool, projectId);
    if (cts.length) { const e = await enrichRowImages(pool, projectId, cts); if (e.fetched) await ev(pool, projectId, null, 'row_images', `fetched ${e.fetched} product/content photo(s)`); }
  } catch (e: any) { await ev(pool, projectId, null, 'row_images_failed', String(e?.message ?? e).slice(0, 160)).catch(() => {}); }

  try {
    const inst = await entry.adapter.provision(ctx);
    const h = await entry.adapter.healthcheck(inst);
    if (!h.ok) { await ev(pool, projectId, null, 'cms_build_failed', `${builtOn} unhealthy: ${h.detail}`); return { ok: false, cms: chosen, builtOn, log: h.detail }; }
    await entry.adapter.modelContentTypes(inst, model, ctx);
    await entry.adapter.pushContent(inst, model, ctx);
    await entry.adapter.buildAndServe(inst, model, ctx);
    const gate = await servedFromCms(entry.adapter, inst, model, ctx);
    await ev(pool, projectId, null, gate.ok ? 'cms_built' : 'cms_build_failed', `${tag} · ${gate.log}`);
    if (gate.ok) await pool.query("update projects set params = jsonb_set(params, '{cms_built}', to_jsonb($2::text), true) where id=$1", [projectId, builtOn]);
    return { ok: gate.ok, cms: chosen, builtOn, fellBackFrom, log: `${tag} · ${gate.log}` };
  } catch (e: any) {
    await ev(pool, projectId, null, 'cms_build_failed', `${tag} · ${String(e?.message ?? e)}`).catch(() => {});
    return { ok: false, cms: chosen, builtOn, log: String(e?.message ?? e) };
  }
}

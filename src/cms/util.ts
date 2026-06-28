// Small shared helpers for the CMS adapters + the served_from_cms gate.
import path from 'node:path';
import type { SiteModel, SiteModelPage, BuildCtx } from './types.ts';

// Where a built page lands on disk: <sitesDir>/<projectId>/<slug>.html — the cached, gate-verified
// projection of the CMS read. buildAndServe writes it; the gate reads it.
export function servedPath(ctx: BuildCtx, slug: string): string {
  return path.join(ctx.sitesDir, ctx.projectId, slug + '.html');
}

// The page's canonical text handle (the hero headline) — the field the gate diffs + mutates.
export function heroHeadline(page: SiteModelPage): string {
  const h = (page.sections || []).find((s: any) => s && s.type === 'hero');
  return (h && typeof h.headline === 'string' && h.headline) ? h.headline : (page.title || page.slug);
}
export function setHeroHeadline(page: SiteModelPage, v: string): void {
  let h: any = (page.sections || []).find((s: any) => s && s.type === 'hero');
  if (!h) { h = { type: 'hero', headline: v }; (page.sections ||= []).unshift(h); }
  else { h.headline = v; }
}

export function brandFor(model: SiteModel): any {
  return model.brand || { name: 'Studio', tokens: { bg: '#ffffff', primary: '#4f46e5' } };
}

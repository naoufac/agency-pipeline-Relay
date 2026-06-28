// served_from_cms — the zero-trust gate. Proves a built page is genuinely a projection of a CMS
// read, not standalone HTML. CMS-agnostic: works against any CmsTarget. The core is the MUTATION
// PROOF — write a unique sentinel THROUGH the CMS, rebuild, assert it surfaces, revert. Static HTML
// (or a build disconnected from the CMS) cannot pass this. An agent cannot self-report it: it issues
// live CMS reads/writes and diffs them against the on-disk served file.
import { readFileSync } from 'node:fs';
import { servedPath, heroHeadline, setHeroHeadline } from './util.ts';
import type { CmsTarget, CmsInstance, SiteModel, BuildCtx } from './types.ts';

export interface GateResult { ok: boolean; log: string; }

export async function servedFromCms(target: CmsTarget, inst: CmsInstance, model: SiteModel, ctx: BuildCtx): Promise<GateResult> {
  const notes: string[] = [];

  // 1+2: every page's canonical CMS field + provenance docId must appear in the served HTML.
  for (const page of model.pages) {
    const rb = await target.readBack(inst, page.slug, ctx);
    let html: string;
    try { html = readFileSync(servedPath(ctx, page.slug), 'utf8'); }
    catch { return { ok: false, log: `served file missing for ${page.slug}` }; }
    if (rb.fields.title && !html.includes(rb.fields.title))
      return { ok: false, log: `CMS title not present in served ${page.slug}: "${rb.fields.title}"` };
    const marker = `relay:cms=${target.id} doc=${rb.docId}`;
    if (!html.includes(marker))
      return { ok: false, log: `provenance marker missing in ${page.slug} (expected ${marker})` };
    notes.push(`${page.slug}#${rb.docId}`);
  }

  // 3: MUTATION PROOF on the first page — the un-fakeable core.
  const p0 = model.pages[0];
  if (!p0) return { ok: false, log: 'no pages to prove' };
  const sentinel = `RELAY-CMS-PROOF-${target.id}-${ctx.projectId.slice(0, 8)}-${Math.floor(Date.now() / 1000)}`;
  const before = readFileSync(servedPath(ctx, p0.slug), 'utf8');
  if (before.includes(sentinel)) return { ok: false, log: 'sentinel already present before mutation — aborting' };

  const orig = heroHeadline(p0);
  try {
    setHeroHeadline(p0, sentinel);
    await target.pushContent(inst, { pages: [p0] } as SiteModel, ctx);   // write THROUGH the CMS
    const rbS = await target.readBack(inst, p0.slug, ctx);                // confirm it landed in the CMS
    if (rbS.fields.title !== sentinel)
      return { ok: false, log: `mutation did not persist in CMS (read back "${rbS.fields.title}")` };
    await target.buildAndServe(inst, { pages: [p0] } as SiteModel, ctx);  // rebuild that page FROM the CMS
    const after = readFileSync(servedPath(ctx, p0.slug), 'utf8');
    if (!after.includes(sentinel))
      return { ok: false, log: 'sentinel written to the CMS did NOT appear in the re-served HTML — page is NOT served from the CMS' };
    notes.push('mutation-proof:PASS');
  } finally {
    // revert to the original content + rebuild, so the gate leaves no trace.
    setHeroHeadline(p0, orig);
    try { await target.pushContent(inst, { pages: [p0] } as SiteModel, ctx); await target.buildAndServe(inst, { pages: [p0] } as SiteModel, ctx); } catch {}
  }

  return { ok: true, log: `served_from_cms OK [${notes.join(' · ')}]` };
}

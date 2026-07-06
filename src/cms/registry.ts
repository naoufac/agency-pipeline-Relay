// CMS REGISTRY — ONE CMS: Directus. Proven end-to-end (`npm run prove:directus` + the servedFromCms
// gate on every build). The former 5-CMS registry (payload/drupal/sanity/craft stubs with fallback
// routing) is retired: one pipeline, one CMS, every project — see GOAL.md. Adding a CMS back is a
// deliberate code change here (and in types.ts CmsName), never a runtime selection.
//
// BUILDER REGISTRY (separate section below):
// params.builder selects the delivery substrate (directus|wordpress|app|campaign).
// This does NOT affect the CMS registry above — cms:check still sees exactly one CMS (directus).
// The builder registry is keyed by params.builder (set by the orchestrator, default 'directus').
import type { CmsTarget, CmsName, Builder, BuilderId } from './types.ts';
import { directus } from './directus.ts';

export type CmsStatus = 'proven';
export interface CmsEntry { adapter: CmsTarget; status: CmsStatus; note: string; }

export const REGISTRY: Record<CmsName, CmsEntry> = {
  directus: { adapter: directus, status: 'proven',
    note: 'Shared container on ap-pg; built + served-from-CMS proven by `npm run prove:directus`.' },
};

export const CMS_ORDER: CmsName[] = ['directus'];

// The adapter to BUILD with. With one proven CMS there is nothing to fall back from; the shape is
// kept so finalize.ts stays untouched and honest logging still works if a legacy params.cms differs.
export function resolveBuildable(chosen: CmsName): { name: CmsName; entry: CmsEntry; fellBackFrom: CmsName | null } {
  const e = REGISTRY[chosen];
  if (e) return { name: chosen, entry: e, fellBackFrom: null };
  return { name: 'directus', entry: REGISTRY.directus, fellBackFrom: chosen };
}

// ---------------------------------------------------------------------------
// BUILDER REGISTRY — substrate-level delivery (orthogonal to the CMS registry)
// ---------------------------------------------------------------------------
// Directus builder wraps the existing cmsFinalize path so runner.ts can call resolveBuilder
// for ALL deliverables uniformly. For 'directus' this is a thin wrapper — behaviour identical.
// WHY lazy imports: the wordpress/app builders have heavier deps (execSync, appdb); we only load
// them when the feature flag is on. The directus wrapper loads unconditionally (it's the default).

const directusBuilder: Builder = {
  id: 'directus',
  // Delegates to the existing cmsFinalize so the Directus path is byte-identical to today.
  // pool+projectId are the same params; ctx is unused (cmsFinalize re-derives its own ctx from DB).
  async finalize(pool: any, projectId: string, _ctx: any): Promise<{ ok: boolean; log: string }> {
    const { cmsFinalize } = await import('./finalize.ts');
    const res = await cmsFinalize(pool, projectId);
    return { ok: res.ok, log: res.log };
  },
};

// Stub builders returned when the real builder module fails to import or the feature flag is off.
const stubBuilder = (id: string, reason: string): Builder => ({
  id,
  async finalize(): Promise<{ ok: boolean; log: string }> {
    return { ok: true, log: `${id} builder stub — ${reason}` };
  },
});

// Resolve a builder by id. Returns the directus builder as the safe default — identical to
// today's behaviour when params.builder is absent. Throws nothing; every path returns a Builder.
export function resolveBuilder(id: BuilderId | string | undefined): Builder {
  const bid = (id || 'directus') as BuilderId;
  switch (bid) {
    case 'directus':
      return directusBuilder;
    case 'wordpress':
      // Lazy-load: only imported when explicitly selected. If RELAY_WP is unset, the wordpress
      // builder itself returns ok:true immediately (flag-gated internally) so it is always safe.
      // Dynamic import is synchronous-by-pattern here because finalize is async — caller awaits.
      return {
        id: 'wordpress',
        async finalize(pool, projectId, ctx) {
          try {
            const { wordpressBuilder } = await import('./wordpress.ts');
            return wordpressBuilder.finalize(pool, projectId, ctx);
          } catch (e: any) {
            return { ok: false, log: `wordpress builder load failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
        },
      };
    case 'app':
      return stubBuilder('app', 'app builder registered by Worker C');
    case 'campaign':
      return stubBuilder('campaign', 'campaign builder not yet implemented');
    default:
      return directusBuilder;
  }
}

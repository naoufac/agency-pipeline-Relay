// A transparent placeholder adapter for a CMS that's present in the system + selectable, but whose
// real adapter isn't built/provisioned yet. It NEVER fakes a build: healthcheck reports the honest
// blocker, and any build method throws. The registry falls back to a proven CMS so generation still
// runs on a real CMS (with an honest log) instead of pretending.
import type { CmsTarget, CmsName } from './types.ts';

export function pendingAdapter(id: CmsName, blocker: string): CmsTarget {
  const nope = (): never => { throw new Error(`cms '${id}' adapter not built — ${blocker}`); };
  return {
    id,
    async provision() { return nope(); },
    async modelContentTypes() { return nope(); },
    async pushContent() { return nope(); },
    async buildAndServe() { return nope(); },
    async readBack() { return nope(); },
    async healthcheck() { return { ok: false, detail: blocker }; },
    async teardown() { /* nothing provisioned */ },
  };
}

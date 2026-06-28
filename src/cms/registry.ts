// CMS REGISTRY — all 5 present in the system, one selectable per project. Directus is proven
// (real, served-from-CMS). The other four are registered + selectable with an HONEST status and
// blocker; their adapters are not built yet, so the registry falls back to the proven default for
// building (never silently faking — the caller logs the fallback). See docs/CMS-ARCHITECTURE.md.
import type { CmsTarget, CmsName } from './types.ts';
import { directus } from './directus.ts';
import { pendingAdapter } from './pending.ts';

export type CmsStatus = 'proven' | 'pending' | 'blocked';
export interface CmsEntry { adapter: CmsTarget; status: CmsStatus; note: string; }

export const REGISTRY: Record<CmsName, CmsEntry> = {
  directus: { adapter: directus, status: 'proven',
    note: 'Shared container on ap-pg; built + served-from-CMS proven by `npm run prove:directus`.' },
  payload: { adapter: pendingAdapter('payload', 'adapter not built; Payload is a framework — provisioning needs a built host app'), status: 'pending',
    note: 'Self-hostable (MIT). Standable, adapter not written yet.' },
  drupal: { adapter: pendingAdapter('drupal', 'adapter not built; standable via Docker (free) — pending'), status: 'pending',
    note: 'Self-hostable (GPL, free). Standable via Docker, adapter not written yet.' },
  sanity: { adapter: pendingAdapter('sanity', 'BLOCKED: needs a Sanity account + SANITY_TOKEN (SaaS credential I cannot create autonomously)'), status: 'blocked',
    note: 'Cloud SaaS — requires the operator to provide a Sanity project + write token.' },
  craft: { adapter: pendingAdapter('craft', 'BLOCKED: needs a purchased Craft Pro licence ($299/project) + outbound phone-home'), status: 'blocked',
    note: 'Paid licence + licence phone-home — cannot run no-human autonomously without a purchase.' },
};

export const CMS_ORDER: CmsName[] = ['directus', 'payload', 'drupal', 'sanity', 'craft'];

// The adapter to actually BUILD with. If the chosen CMS isn't proven-buildable yet, fall back to the
// proven default and tell the caller (so it can log an honest "built on X instead of Y"), never fake.
export function resolveBuildable(chosen: CmsName): { name: CmsName; entry: CmsEntry; fellBackFrom: CmsName | null } {
  const e = REGISTRY[chosen];
  if (e && e.status === 'proven') return { name: chosen, entry: e, fellBackFrom: null };
  return { name: 'directus', entry: REGISTRY.directus, fellBackFrom: chosen };
}

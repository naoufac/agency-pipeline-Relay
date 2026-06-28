// CMS SELECTOR — deterministic, brief-rooted, closed-set; mirrors archetypeFor()/themeFor() exactly.
// Picks exactly ONE of the 5 CMS for a project, ONCE, at plan time (stored in projects.params.cms,
// the same place theme/archetype live). The LLM may NAME a cms (validated against the closed set);
// otherwise the archetype's candidate list is rotated by a STABLE hash of the brief, so the choice
// is a pure, reproducible function of the brief yet every adapter gets real traffic — honouring
// "all 5 present in the system, exactly 1 per project". The LLM is never trusted to decide structure.
import { type Archetype } from '../archetype.ts';
import { type CmsName, isCmsName } from './types.ts';

export const DEFAULT_CMS: CmsName = 'directus';   // highest autonomous-fit, free, shares the existing Postgres

// Ordered candidate list per archetype (best-fit first), derived from the research's autonomous-fit
// scores + data-model needs. Rotation spreads load WITHOUT ever making craft (the weakest no-human
// fit: per-project licence, phone-home, domain binding) a silent default for a data archetype.
const ROTATION: Record<Archetype, CmsName[]> = {
  site:  ['sanity', 'directus', 'craft'],    // headless SSG, code-first schema, zero infra to stand up
  app:   ['payload', 'directus', 'drupal'],  // TS code-first schema pairs with the appdb relational model
  store: ['directus', 'payload', 'drupal'],  // shared-Postgres collections, cleanest bulk catalog push
};

// blog/content-heavy is a sub-type of `site` → route to Drupal's strong editorial model (JSON:API,
// GPL/free) so Drupal earns real traffic too.
const BLOG_ROTATION: CmsName[] = ['drupal', 'directus', 'sanity'];
const BLOG_RE = /\b(blog|magazine|news|editorial|publication|articles?|journal|press)\b/;

// FNV-1a — small, stable, dependency-free. Same brief → same index, forever (reproducible).
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// Trust an LLM-named cms only if it's in the closed set; else rotate the archetype's candidates by
// the brief hash. Always returns a valid CmsName.
export function selectCms(named: any, brief: string, archetype: Archetype): CmsName {
  if (isCmsName(named)) return named;                              // explicit, validated override
  const b = ' ' + String(brief || '').toLowerCase() + ' ';
  const candidates = (archetype === 'site' && BLOG_RE.test(b)) ? BLOG_ROTATION : ROTATION[archetype];
  if (!candidates || !candidates.length) return DEFAULT_CMS;       // fallback (should never trigger)
  return candidates[hash(String(brief || '')) % candidates.length];
}

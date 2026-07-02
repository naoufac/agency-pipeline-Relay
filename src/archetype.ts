// ARCHETYPE — does this brief need a real backend, or is it a presentation site?
// This is what makes "one prompt → full agency production" real: the archetype decides which
// DEPARTMENTS the agency runs. A presentation `site` ships pages; an `app`/`store` additionally
// gets a real, sql_applies-verified DATABASE department (an actual schema, not just copy).
// Deterministic + brief-rooted + closed set, exactly like themes.ts — the LLM is never trusted to
// decide structure; at most it NAMES an archetype (validated, with this classifier as the floor).

export type Archetype = 'site' | 'app' | 'store';
export const ARCHETYPES: Archetype[] = ['site', 'app', 'store'];
export const DEFAULT_ARCHETYPE: Archetype = 'site';

// First match wins; `store` before `app` (a shop is a more specific app). `site` is the fallback.
const RULES: [Archetype, RegExp][] = [
  ['store', /\b(shop|store|e-?commerce|e-?shop|catalog(ue)?|checkout|\bcart\b|boutique|merch|webshop|sell (online|products?)|product (page|catalog))\b/],
  ['app', /\b(app|application|platform|saas|dashboard|portal|booking|reservations?|reserve|delivery|marketplace|directory|listings?|\bcrm\b|\berp\b|tracker|tracking|sign[- ]?up|log[- ]?in|members? area|membership|subscription|orders?|inventory|appointments?|scheduling|on[- ]?demand|ride[- ]?hailing|fleet|jobs? board|classifieds)\b/],
];

export function isArchetype(x: any): x is Archetype { return typeof x === 'string' && (ARCHETYPES as string[]).includes(x); }

export function classifyArchetype(brief: string): Archetype {
  const b = ' ' + String(brief || '').toLowerCase() + ' ';
  for (const [name, re] of RULES) if (re.test(b)) return name;
  return DEFAULT_ARCHETYPE;
}

// Trust an LLM-named archetype only if it's in the closed set; else classify the brief deterministically.
export function archetypeFor(named: any, brief: string): Archetype {
  return isArchetype(named) ? named : classifyArchetype(brief);
}

// Does this archetype require a real data model (a verified database department)?
export function needsData(a: Archetype): boolean { return a === 'app' || a === 'store'; }

// FS0 — HONEST APP SURFACE. Page roles the system cannot power yet: an owner "dashboard" lives in
// the board's Content tab, visitor "portal/track/account" views arrive with FS1/FS2 (receipts,
// sign-in). Until then, planning such a page renders FICTION — a brochure ABOUT a dashboard with
// invented stats and dead buttons (the facade class the reviewer failed on a real build). The
// planner drops these loudly; site_model rejects any that slip through; the reviewer flags them.
export const FACADE_PAGE = /^(dashboard|admin|portal|client-?portal|customer-?portal|my-?account|account|profile|login|log-?in|sign-?in|track|tracking|console|panel|backoffice|back-?office|manage|management)$/i;

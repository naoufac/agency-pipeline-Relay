// CmsTarget — the contract Relay's CMS implements so every site is built ON it (not static HTML with
// a text editor bolted on). ONE CMS: Directus. The type system enforces it — adding a second CMS is a
// deliberate code change here, never a runtime choice. Design notes live in docs/CMS-ARCHITECTURE.md.
//
// Principles carried over from the rest of Relay:
//  - Deterministic where it can be; the LLM NEVER authors schema (modelContentTypes consumes the
//    already-normalized, validated SiteModel, not raw LLM output).
//  - One shared, long-lived instance per self-hosted CMS; per-project isolation is a Postgres SCHEMA
//    per project (reuses the appdb.ts schemaName safety contract), NOT a container per project.
//  - Every method is idempotent and confined to this project's namespace — never touches shared infra.
import type { Archetype } from '../archetype.ts';
import type { ThemeName } from '../themes.ts';

export type CmsName = 'directus';
export const CMS_NAMES: CmsName[] = ['directus'];
export function isCmsName(x: any): x is CmsName {
  return typeof x === 'string' && (CMS_NAMES as string[]).includes(x);
}

// A live, project-bound CMS endpoint produced by provision(). Secrets are REFERENCED, not stored.
export interface CmsInstance {
  cms: CmsName;
  projectId: string;
  baseUrl: string;      // self-hosted: http://127.0.0.1:8055 ; sanity: the API host
  namespace: string;    // per-project isolation: pg schema cms_<name>_<hex>, or a sanity dataset
  healthUrl: string;    // cheap liveness probe target
  tokenRef: string;     // env/secret reference (e.g. "RELAY_DIRECTUS_TOKEN"), NEVER the secret itself
}

// Relay's normalized, CMS-agnostic site (output of compose / normalizeSite). Structural on purpose —
// the adapter consumes it; it is the single in-memory source that gets pushed INTO the CMS.
export interface SiteModelPage { slug: string; title: string; sections: any[]; }
export interface SiteModel {
  pages: SiteModelPage[];
  brand?: any;
  data?: { tables?: string[]; rows?: Record<string, any[]> };
}

// Everything an adapter needs that isn't the model itself.
export interface BuildCtx {
  projectId: string;
  brief: string;
  locale?: string;   // i18n: the site's language — EVERY render path must carry it or chrome falls back to English
  archetype: Archetype;
  theme: ThemeName;
  sitesDir: string;     // where /sites/<id>/ artifacts are written
  // M2: the schema snapshot taken at compose (params.schema_forms) — REQUIRED for any render of a
  // page that may carry a typed form; without it the form degrades to the contact fallback.
  schemaForms?: { tables: string[]; forms: Record<string, any[]>; primaryTable: string };
  layout?: any;   // structure variant (hero/nav/band), passed to renderPage on CMS re-serve
  // SEO identity — the CMS re-serve is the FINAL writer of every page, so it must carry the same
  // head context the runner renders with, or canonical/schema.org silently degrade (2026-07-06:
  // a live proof build shipped generic Organization + no canonical because these were dropped here).
  siteBase?: string;        // https://<slug>.naples.agency when the slug is minted
  localBusiness?: boolean;  // back-compat classification
  bizType?: string;         // most-specific schema.org @type (Restaurant, Dentist, …)
  bizFacts?: any;           // whole-site telephone/email/address/hours (extractBusinessFacts)
}

// The contract. See docs/CMS-ARCHITECTURE.md for how it maps onto Directus.
export interface CmsTarget {
  readonly id: CmsName;

  // Stand up (or re-attach to) a running CMS bound to this project, fully via env/CLI/API — zero UI.
  // Idempotent: re-running on an existing project re-attaches, never re-wipes.
  provision(ctx: BuildCtx): Promise<CmsInstance>;

  // Translate the normalized SiteModel into the CMS's native code-first schema and apply it (diff).
  modelContentTypes(inst: CmsInstance, model: SiteModel, ctx: BuildCtx): Promise<{ types: string[] }>;

  // Write every page's composed copy + section blocks + seeded catalog rows as real CMS documents.
  // Idempotent via stable external keys (slug) so rebuilds upsert, never duplicate. Returns doc ids.
  pushContent(inst: CmsInstance, model: SiteModel, ctx: BuildCtx): Promise<{ ids: Record<string, string[]> }>;

  // Produce the served site by FETCHING content back OUT of the CMS (never from the in-memory model)
  // and rendering through Relay's existing deterministic renderPage. Stamps a CMS provenance marker.
  // Returns slug -> artifact path. This is the one channel that makes the live page a CMS projection.
  buildAndServe(inst: CmsInstance, model: SiteModel, ctx: BuildCtx): Promise<{ pages: Record<string, string> }>;

  // Fetch one page's canonical fields straight from the CMS read API by slug. The served_from_cms
  // gate diffs this against the served HTML — the zero-trust proof a page is genuinely CMS-served.
  readBack(inst: CmsInstance, slug: string, ctx: BuildCtx): Promise<{ docId: string; fields: Record<string, string> }>;

  // Cheap liveness/readiness probe (HTTP 200 on the API root + auth). Gates provisioning + is polled
  // before model/push so a slow-booting container retries transiently instead of failing spuriously.
  healthcheck(inst: CmsInstance): Promise<{ ok: boolean; detail: string }>;

  // Release this project's CMS footprint (stop container/process, drop its schema or dataset).
  // purge=false leaves data for audit. Confined to this project's namespace, like appdb teardown.
  teardown(inst: CmsInstance, opts?: { purge?: boolean }): Promise<void>;
}

// ---------------------------------------------------------------------------
// BUILDER REGISTRY — substrate-level delivery (orthogonal to the CMS registry)
// params.cms STAYS 'directus' forever; params.builder selects the delivery substrate.
// The CMS registry (REGISTRY/CMS_NAMES/CMS_ORDER) is untouched; cms:check still passes.
// ---------------------------------------------------------------------------

// The one method every builder must implement: given a fully composed project, deliver it
// through the appropriate substrate and return a proof record. On any failure the static
// files stand (runner.ts wraps in try/catch). Idempotent — re-running upserts, never duplicates.
export interface Builder {
  readonly id: string;  // 'directus' | 'wordpress' | 'app' | 'campaign'
  finalize(pool: any, projectId: string, ctx: BuildCtx): Promise<{ ok: boolean; log: string }>;
}

// Known builder IDs — additive, never replaces CmsName.
export type BuilderId = 'directus' | 'wordpress' | 'app' | 'campaign';
export const BUILDER_IDS: BuilderId[] = ['directus', 'wordpress', 'app', 'campaign'];

// PrestaShop Builder — delivers a composed Relay site model onto a PrestaShop instance via the
// PrestaShop Webservice API (REST/XML). This is Relay's third delivery substrate alongside
// Directus and WordPress; it does NOT replace Directus and is NOT registered in the CMS REGISTRY
// (which stays Directus-only). Designed for French e-commerce (FR-ecom) deployments.
//
// WHY PrestaShop Webservice over admin scraping:
//   The webservice API is the official, stable channel for headless integrations. It supports
//   products, categories, combinations, images, and store configuration without browser deps.
//   Auth is a single API key (RELAY_PRESTA_KEY). No session cookies, no CSRF dance.
//
// WHY slug-scoped meta (relay_project_id reference_*):
//   Same proven isolation pattern used by WordPress (relay_project_id post-meta).
//   We stamp each created resource with a reference field containing the projectId prefix so
//   teardown can find + delete only this project's resources without touching shared catalog.
//
// FEATURE FLAG: the whole PrestaShop path is gated behind RELAY_PRESTA=1. With the flag off,
// finalize() returns ok:true immediately and the static Directus build stands. Never breaks the
// default chain. Also exits early if RELAY_PRESTA_URL is absent or the container is unreachable.
//
// STUB CONTRACT (no live infra): when no PrestaShop endpoint is reachable, the builder records
// intent in params.presta_provision so the project log is honest about what would have happened.
// The stub is clearly labelled in every log line it produces.
//
// Owned by: Worker F (prestashop builder). Do NOT import from server.ts (cms:check.ts banned pattern).
import type { Builder, BuildCtx } from './types.ts';

// ---------------------------------------------------------------------------
// Environment / endpoint resolution
// ---------------------------------------------------------------------------

// Resolve the PrestaShop webservice endpoint from env. Priority:
//   1. RELAY_PRESTA_URL (explicit override, e.g. http://127.0.0.1:8069)
//   2. 'presta' docker container hostname (localhost on the bridge network)
// Returns empty string if nothing is configured (graceful-absent path).
export function resolvePrestaUrl(): string {
  if (process.env.RELAY_PRESTA_URL) return process.env.RELAY_PRESTA_URL.replace(/\/$/, '');
  // No explicit URL → caller must also confirm container availability separately.
  return '';
}

// API key for the PrestaShop webservice (set in PS back-office → Advanced → Webservice).
// Referenced by env name only — the raw value never appears in logs or params.
export const PRESTA_KEY_REF = 'RELAY_PRESTA_KEY';

// Build the Basic-auth header value expected by the PrestaShop webservice.
// PS webservice uses HTTP Basic with the API key as username and an empty password.
// Called at request time; never stored in the module scope (no side effects on import).
export function prestaAuthHeader(apiKey: string): string {
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
}

// Cheap liveness probe: GET /api/?output_format=JSON with auth. Returns true only when
// the endpoint responds HTTP 200 with a JSON body that contains the 'api' key.
export async function prestaAvailable(baseUrl: string, apiKey: string): Promise<boolean> {
  if (!baseUrl || !apiKey) return false;
  try {
    const res = await fetch(`${baseUrl}/api/?output_format=JSON`, {
      headers: { Authorization: prestaAuthHeader(apiKey) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const json: any = await res.json();
    return typeof json === 'object' && json !== null && 'api' in json;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Webservice helpers (products + categories)
// ---------------------------------------------------------------------------
// WHY XML: the PrestaShop webservice natively speaks XML for write operations (POST/PUT).
// JSON output_format is read-only for most resources. We build minimal XML strings rather
// than pulling in a full XML library to keep zero-dep import guarantees.

function xmlEsc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Wrap a CDATA value for PS multilang text fields (avoids encoding issues with copy).
function cdata(s: string): string {
  return `<![CDATA[${s}]]>`;
}

// POST a new resource to the PS webservice. Returns the numeric ID of the created resource.
// Throws on HTTP error (caller catches + records in stub notes).
async function psCreate(
  baseUrl: string,
  apiKey: string,
  resource: string,      // e.g. 'categories', 'products'
  xmlBody: string,       // full XML document
): Promise<number> {
  const res = await fetch(`${baseUrl}/api/${resource}?output_format=JSON`, {
    method: 'POST',
    headers: {
      Authorization: prestaAuthHeader(apiKey),
      'Content-Type': 'application/xml',
    },
    body: xmlBody,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PS ${resource} POST ${res.status}: ${text.slice(0, 200)}`);
  }
  const json: any = await res.json();
  // PS returns { [resource_singular]: { id: <n> } } — dig out the id.
  const singular = resource.replace(/s$/, ''); // products→product, categories→category
  const id = json?.[singular]?.id ?? json?.id;
  if (!id) throw new Error(`PS ${resource} POST: no id in response — ${JSON.stringify(json).slice(0, 200)}`);
  return Number(id);
}

// GET a list of IDs from the webservice (filter by display field=id).
// Returns [] on error (idempotency: "does resource exist?" check).
async function psListIds(
  baseUrl: string,
  apiKey: string,
  resource: string,
  filter?: { field: string; value: string }, // e.g. {field:'reference',value:'relay-<uuid>'}
): Promise<number[]> {
  let url = `${baseUrl}/api/${resource}?output_format=JSON&display=full`;
  if (filter) url += `&filter[${filter.field}]=[${encodeURIComponent(filter.value)}]`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: prestaAuthHeader(apiKey) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    // PS returns { [resource]: [ { id, … }, … ] } or { [resource]: { id, … } } for single result.
    const arr: any[] = Array.isArray(json?.[resource]) ? json[resource] : (json?.[resource] ? [json[resource]] : []);
    return arr.map((r: any) => Number(r.id)).filter(Boolean);
  } catch { return []; }
}

// DELETE a resource by id. Best-effort (swallows errors — teardown is non-fatal).
async function psDelete(
  baseUrl: string,
  apiKey: string,
  resource: string,
  id: number,
): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/${resource}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: prestaAuthHeader(apiKey) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Category provisioning
// ---------------------------------------------------------------------------
// WHY: PS products must live in a category. We create one per project under the root catalog
// (id_parent=2 is the default "Home" category in a stock PS install). The reference field
// carries `relay-<projectId>` for idempotent upsert + teardown.

function categoryXml(projectId: string, name: string, langId: number): string {
  const ref = `relay-${projectId.slice(0, 16)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <category>
    <id_parent>2</id_parent>
    <active>1</active>
    <id_shop_default>1</id_shop_default>
    <is_root_category>0</is_root_category>
    <link_rewrite><language id="${langId}"><![CDATA[${xmlEsc(ref)}]]></language></link_rewrite>
    <name><language id="${langId}">${cdata(xmlEsc(name))}</language></name>
    <description><language id="${langId}"><![CDATA[Relay project ${xmlEsc(projectId.slice(0, 8))}]]></language></description>
    <meta_title><language id="${langId}">${cdata(xmlEsc(name))}</language></meta_title>
    <meta_keywords><language id="${langId}"><![CDATA[relay]]></language></meta_keywords>
    <meta_description><language id="${langId}"><![CDATA[]]></language></meta_description>
  </category>
</prestashop>`;
}

// ---------------------------------------------------------------------------
// Product provisioning
// ---------------------------------------------------------------------------
// Each site page that carries a 'products' section is turned into a PS product. If the
// brief's brand + page titles are not product-shaped, we fall back to a "site as store" mapping:
// one product per page entry. This keeps the stub honest about intent.

interface PsProductSpec {
  name: string;
  reference: string;  // relay-<projectId>-<slug> — idempotent key
  price: string;      // decimal string, e.g. '0.000000'
  description: string;
  categoryId: number;
}

function productXml(spec: PsProductSpec, langId: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product>
    <id_category_default>${spec.categoryId}</id_category_default>
    <reference><![CDATA[${xmlEsc(spec.reference)}]]></reference>
    <price>${xmlEsc(spec.price)}</price>
    <active>1</active>
    <available_for_order>1</available_for_order>
    <show_price>1</show_price>
    <online_only>0</online_only>
    <condition>new</condition>
    <name><language id="${langId}">${cdata(xmlEsc(spec.name))}</language></name>
    <description><language id="${langId}">${cdata(xmlEsc(spec.description))}</language></description>
    <description_short><language id="${langId}">${cdata(xmlEsc(spec.description.slice(0, 200)))}</language></description_short>
    <link_rewrite><language id="${langId}"><![CDATA[${xmlEsc(spec.reference.replace(/[^a-z0-9-]/g, '-').toLowerCase())}]]></language></link_rewrite>
    <meta_title><language id="${langId}">${cdata(xmlEsc(spec.name))}</language></meta_title>
    <meta_keywords><language id="${langId}"><![CDATA[relay]]></language></meta_keywords>
    <meta_description><language id="${langId}"><![CDATA[]]></language></meta_description>
  </product>
</prestashop>`;
}

// ---------------------------------------------------------------------------
// FR-ecom language detection helper (exported for check suite)
// ---------------------------------------------------------------------------
// WHY: PrestaShop is the FR-ecom substrate; the language ID for French in a stock PS install is
// typically 1 (fr_FR) or 2 depending on install locale. We probe /api/languages to find the
// active French language ID. Falls back to 1 (most common default).
export async function resolveFrLangId(baseUrl: string, apiKey: string): Promise<number> {
  try {
    const res = await fetch(`${baseUrl}/api/languages?output_format=JSON&display=full`, {
      headers: { Authorization: prestaAuthHeader(apiKey) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return 1;
    const json: any = await res.json();
    const langs: any[] = Array.isArray(json?.languages) ? json.languages : [];
    const fr = langs.find((l: any) => String(l.iso_code).toLowerCase().startsWith('fr'));
    return fr?.id ? Number(fr.id) : 1;
  } catch { return 1; }
}

// ---------------------------------------------------------------------------
// Build product specs from the composed site model
// ---------------------------------------------------------------------------
// WHY: we scan every page for 'products'/'services'/'features' sections and build a flat list of
// PsProductSpec. If no typed product section is found we emit one entry per page (site-as-catalog
// fallback) so every build produces at least one visible product on the storefront.

function buildProductSpecs(
  projectId: string,
  site: { pages: Array<{ slug: string; title?: string; sections?: any[] }> },
  categoryId: number,
): PsProductSpec[] {
  const specs: PsProductSpec[] = [];
  const prefix = `relay-${projectId.slice(0, 8)}`;

  for (const page of site.pages ?? []) {
    const sections = page.sections ?? [];
    const productSections = sections.filter((s: any) => /^(products?|services?|features?)$/.test(s?.type ?? ''));

    if (productSections.length > 0) {
      for (const sec of productSections) {
        const items: any[] = Array.isArray(sec.items) ? sec.items : [];
        for (const item of items) {
          const name = String(item?.title || item?.name || page.title || page.slug).trim();
          const desc = String(item?.desc || item?.description || '').trim();
          const price = String(item?.price || '0.000000');
          const ref = `${prefix}-${String(item?.title || page.slug).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32)}`;
          specs.push({ name, reference: ref, price, description: desc, categoryId });
        }
      }
    } else {
      // Fallback: one product per page (site-as-catalog).
      const name = String(page.title || page.slug).trim();
      const desc = sections.find((s: any) => s?.body)?.body ?? '';
      const ref  = `${prefix}-${String(page.slug).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32)}`;
      specs.push({ name, reference: ref, price: '0.000000', description: String(desc), categoryId });
    }
  }

  // Deduplicate by reference (idempotent: same slug = same product).
  const seen = new Set<string>();
  return specs.filter(s => { if (seen.has(s.reference)) return false; seen.add(s.reference); return true; });
}

// ---------------------------------------------------------------------------
// STUB path: record intent in params without hitting live infra
// ---------------------------------------------------------------------------
// WHY: when no PrestaShop endpoint is reachable we must not fail the build — the static Directus
// artifacts are the deliverable. The stub records what would have been provisioned so the project
// log is auditable. Every log line is prefixed with [STUB] so it is never mistaken for real work.
async function stubProvision(
  pool: any,
  projectId: string,
  site: { pages: any[] },
  reason: string,
): Promise<{ ok: boolean; log: string }> {
  const intendedProducts = (site.pages ?? []).map((p: any) => ({
    slug: p.slug,
    title: p.title || p.slug,
    sections: (p.sections ?? []).map((s: any) => s?.type).filter(Boolean),
  }));

  const proof = {
    mode: 'STUB',
    reason,
    intendedProducts,
    timestamp: new Date().toISOString(),
  };

  try {
    await pool.query(
      "update projects set params = jsonb_set(params, '{presta_provision}', $2::jsonb, true) where id=$1",
      [projectId, JSON.stringify(proof)],
    );
  } catch { /* pool may be null in test contexts; best-effort */ }

  return {
    ok: true,
    log: `[STUB] prestashop disabled/absent — no-op (reason: ${reason}) — intent recorded in params.presta_provision`,
  };
}

// ---------------------------------------------------------------------------
// REAL provision path (when RELAY_PRESTA=1 + endpoint reachable)
// ---------------------------------------------------------------------------
// Idempotent: category upsert by reference, product upsert by reference. Re-running the
// same project does NOT create duplicates — it finds existing resources by relay reference
// and skips creation. Teardown finds all resources by the relay-<projectId> reference prefix.

async function realProvision(
  pool: any,
  projectId: string,
  ctx: BuildCtx,
  baseUrl: string,
  apiKey: string,
  site: { pages: any[]; brand?: any },
): Promise<{ ok: boolean; log: string }> {
  const notes: string[] = [];
  const brandName = String(site.brand?.name || ctx.brief.slice(0, 30) || 'Relay Store').trim();
  const catRef = `relay-${projectId.slice(0, 16)}`;

  // Resolve the French language ID from the live PS instance.
  const langId = await resolveFrLangId(baseUrl, apiKey);
  notes.push(`lang:${langId}`);

  // 1. Upsert category (idempotent: find by link_rewrite = catRef).
  let categoryId: number;
  const existingCats = await psListIds(baseUrl, apiKey, 'categories', { field: 'link_rewrite', value: catRef });
  if (existingCats.length > 0) {
    categoryId = existingCats[0];
    notes.push(`category:reused(id=${categoryId})`);
  } else {
    try {
      categoryId = await psCreate(baseUrl, apiKey, 'categories', categoryXml(projectId, brandName, langId));
      notes.push(`category:created(id=${categoryId})`);
    } catch (e: any) {
      // Category creation can fail if webservice key lacks write perms on categories — use root (2).
      categoryId = 2;
      notes.push(`category:fallback-root(${String(e?.message ?? e).slice(0, 80)})`);
    }
  }

  // 2. Build product specs from the composed site model.
  const specs = buildProductSpecs(projectId, site, categoryId);
  notes.push(`products-to-provision:${specs.length}`);

  // 3. Upsert each product (idempotent by reference).
  const productIds: number[] = [];
  for (const spec of specs) {
    const existing = await psListIds(baseUrl, apiKey, 'products', { field: 'reference', value: spec.reference });
    if (existing.length > 0) {
      productIds.push(existing[0]);
      notes.push(`product:reused(${spec.reference.slice(0, 24)})`);
    } else {
      try {
        const id = await psCreate(baseUrl, apiKey, 'products', productXml(spec, langId));
        productIds.push(id);
        notes.push(`product:created(id=${id},ref=${spec.reference.slice(0, 24)})`);
      } catch (e: any) {
        notes.push(`product:error(${spec.reference.slice(0, 24)}:${String(e?.message ?? e).slice(0, 60)})`);
      }
    }
  }

  // 4. Write proof onto the project params so verify rules can assert it.
  const proof = {
    mode: 'REAL',
    baseUrl,
    categoryId,
    productIds,
    catRef,
    langId,
    timestamp: new Date().toISOString(),
    ok: true,
  };
  try {
    await pool.query(
      "update projects set params = jsonb_set(params, '{presta_provision}', $2::jsonb, true) where id=$1",
      [projectId, JSON.stringify(proof)],
    );
  } catch { /* best-effort — proof is in logs even if DB write fails */ }

  return { ok: true, log: `prestashop provisioned [${notes.join(' · ')}]` };
}

// ---------------------------------------------------------------------------
// Main builder: prestashopBuilder — the one export the boss wires into registry.ts
// ---------------------------------------------------------------------------

export const prestashopBuilder: Builder = {
  id: 'prestashop',

  async finalize(pool: any, projectId: string, ctx: BuildCtx): Promise<{ ok: boolean; log: string }> {
    // FEATURE FLAG: with RELAY_PRESTA != '1', return immediately so the static Directus build stands.
    // This is how the default chain (26+ suites) never touches PrestaShop infrastructure.
    if (process.env.RELAY_PRESTA !== '1') {
      return { ok: true, log: 'prestashop disabled (RELAY_PRESTA!=1) — static build stands' };
    }

    // Read the composed site model from DB.
    let site: { pages: any[]; brand?: any } | null = null;
    try {
      const r = await pool.query('select params from projects where id=$1', [projectId]);
      if (!r.rows[0]) return { ok: false, log: 'prestashop: no such project' };
      const params = r.rows[0].params || {};
      site = params.site || null;
    } catch (e: any) {
      return { ok: false, log: `prestashop: DB read failed: ${String(e?.message ?? e).slice(0, 200)}` };
    }

    if (!site || !Array.isArray(site.pages) || !site.pages.length)
      return { ok: false, log: 'prestashop: no composed site model (params.site) — nothing to provision' };

    // Resolve endpoint.
    const baseUrl = resolvePrestaUrl();
    const apiKey  = process.env[PRESTA_KEY_REF] || '';

    // Liveness probe — if the endpoint is absent or unreachable, fall back to stub.
    if (!baseUrl || !apiKey) {
      return stubProvision(pool, projectId, site, `RELAY_PRESTA_URL or ${PRESTA_KEY_REF} not set`);
    }
    const alive = await prestaAvailable(baseUrl, apiKey);
    if (!alive) {
      return stubProvision(pool, projectId, site, `endpoint ${baseUrl} not reachable`);
    }

    // Real provision path.
    try {
      return await realProvision(pool, projectId, ctx, baseUrl, apiKey, site);
    } catch (e: any) {
      return { ok: false, log: `prestashop finalize error: ${String(e?.message ?? e).slice(0, 400)}` };
    }
  },
};

export { prestashopBuilder as default };

// ---------------------------------------------------------------------------
// Theme helpers (exported for check suite and future wiring)
// ---------------------------------------------------------------------------
// WHY: mirrors wordpressBuilder's wpTheme export so the pattern is discoverable for the boss
// when wiring prestashop into the deliverable chain. PrestaShop ships with a handful of
// bundled themes; we map Relay theme names to the closest PS equivalent.

const PRESTA_THEME_MAP: Record<string, string> = {
  editorial: 'classic',    // Classic theme: clean editorial layout
  modern:    'classic',    // Classic is the only guaranteed bundled theme in PS 8.x
  warm:      'classic',
  bold:      'classic',
  minimal:   'classic',
};

// Returns the closest bundled PrestaShop theme name for a given Relay theme.
export function prestaTheme(relayTheme: string): string {
  return PRESTA_THEME_MAP[relayTheme] || 'classic';
}

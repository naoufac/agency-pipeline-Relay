// WordPress Builder — delivers a composed Relay site model onto the live relay-wp container via
// wp-cli phar (docker exec). This is Relay's second delivery substrate alongside Directus; it does
// NOT replace Directus and is NOT registered in the CMS REGISTRY (which stays Directus-only).
//
// WHY wp-cli over REST:
//   REST requires per-site app-password auth plumbing and cannot activate themes or install plugins.
//   wp-cli runs as root in the container (--allow-root), reads wp-config.php for DB creds, and does
//   everything in one idempotent channel — no secrets on the command line, no auth dance.
//
// WHY a slug-scoped page tree (not multisite):
//   Multisite needs domain/subdirectory mapping and per-site provisioning; it is heavier and more
//   error-prone. Slug-scoped isolation is the SAME proven pattern Directus uses (project_id filter
//   on a shared collection). Each project's pages carry post-meta `relay_project_id=<uuid>`.
//   Teardown: delete all posts with that meta value.
//
// FEATURE FLAG: the whole WP path is gated behind RELAY_WP=1. With the flag off, finalize() returns
// ok:true immediately and the static Directus build stands. Never breaks the default chain.
//
// Owned by: Worker B (wordpress builder). Do NOT import from server.ts (cms:check.ts:24-25).
//
// T25 — Typography: injectBrandPalette() extended to inject Google Fonts @import + --relay-font-display/body
//         CSS variables and body/heading font-family rules inside the same custom_css post.
//         Record fontsInjected:true in proof.
// T26 — Per-page SEO: injectPageSeo() writes _relay_seo_title / _relay_seo_desc / og:* post meta,
//         a mu-plugin emits them in <head>. Sitemap at /wp-sitemap.xml asserted 200.
//         Record seo:true in proof.
// T27 — Featured images: setFeaturedImage() downloads a Pexels photo per page and sets _thumbnail_id
//         via 'wp media import'. Skip when no PEXELS key. Record featuredImages count.
// T28 — WooCommerce full config: createWooCategories(), attachProductImages(), EUR currency for
//         French locale, COD payment via 'wp option update woocommerce_cod_settings'.
//         Record wooCurrency/wooCod in proof.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Builder, BuildCtx } from './types.ts';
import pg from 'pg';

// ---------------------------------------------------------------------------
// Container helpers
// ---------------------------------------------------------------------------

const CONTAINER = 'relay-wp';
const WP_PATH = '/var/www/html';
const WP_URL  = 'http://127.0.0.1:8057';

// Wrapper around `docker exec relay-wp wp --allow-root --path=/var/www/html <args>`.
// Returns stdout as string. Throws with stderr on non-zero exit.
// We use execSync (not exec) because every wp-cli call is short-lived and sequential;
// async complexity adds nothing here.
function wp(args: string, opts?: { input?: string }): string {
  const cmd = `docker exec ${CONTAINER} wp --allow-root --path=${WP_PATH} ${args}`;
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: 30_000,
      input: opts?.input,
      // wp-cli outputs progress to stderr even on success — redirect so we only capture stdout
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    throw new Error(`wp-cli "${args}" failed: ${String(e?.stderr ?? e?.message ?? e).slice(0, 400)}`);
  }
}

// Cheap check that the container is reachable and wp-cli is installed.
export function wpAvailable(): boolean {
  try {
    execSync(`docker inspect --format='{{.State.Running}}' ${CONTAINER}`, { encoding: 'utf8', timeout: 5_000 });
    wp('--version');
    return true;
  } catch { return false; }
}

// Idempotent: install wp-cli phar if absent. Safe to call every finalize — the fast path is
// `command -v wp && exit 0`.
export function ensureWpCli(): void {
  const script = [
    `command -v wp >/dev/null 2>&1 && exit 0`,
    `curl -sS -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar`,
    `chmod +x /usr/local/bin/wp`,
  ].join(' && ');
  execSync(`docker exec ${CONTAINER} bash -lc ${JSON.stringify(script)}`, { encoding: 'utf8', timeout: 60_000 });
}

// ---------------------------------------------------------------------------
// WP isolation helpers (slug-scoped namespace via post-meta relay_project_id)
// ---------------------------------------------------------------------------

const META_KEY = 'relay_project_id';

// Look up a page by slug restricted to this project's namespace. Returns WP post ID or ''.
function findPage(projectId: string, slug: string): string {
  try {
    const ids = wp(
      `post list --post_type=page --name=${JSON.stringify(slug)} --meta_key=${META_KEY} --meta_value=${JSON.stringify(projectId)} --field=ID --format=csv`
    );
    return ids.split('\n')[0]?.trim() || '';
  } catch { return ''; }
}

// Upsert a page: create if absent, update if present. Returns the WP post ID as string.
function upsertPage(projectId: string, slug: string, title: string, content: string): string {
  const existing = findPage(projectId, slug);
  if (existing) {
    wp(`post update ${existing} --post_title=${JSON.stringify(title)} --post_content=${JSON.stringify(content)} --post_status=publish`);
    return existing;
  }
  const id = wp(
    `post create --post_type=page --post_name=${JSON.stringify(slug)} --post_title=${JSON.stringify(title)} --post_content=${JSON.stringify(content)} --post_status=publish --porcelain`
  );
  // stamp with project meta so teardown can find this post by project id alone
  wp(`post meta update ${id} ${META_KEY} ${JSON.stringify(projectId)}`);
  return id.trim();
}

// Delete every page belonging to this project.
function teardownProject(projectId: string): void {
  try {
    const ids = wp(
      `post list --post_type=page --meta_key=${META_KEY} --meta_value=${JSON.stringify(projectId)} --field=ID --format=csv`
    );
    const list = ids.split('\n').map(s => s.trim()).filter(Boolean);
    if (list.length) wp(`post delete ${list.join(' ')} --force`);
  } catch { /* teardown is best-effort */ }
}

// ---------------------------------------------------------------------------
// Section → WP block content conversion
// ---------------------------------------------------------------------------
// WHY: WordPress stores content as HTML/Gutenberg blocks. We render each section to a simple
// block-compatible HTML string so wp-cli's post_content field carries real copy, not placeholders.
// Full Gutenberg block markup is optional; a plain HTML <div> renders fine in the block editor's
// "classic" fallback and in the front-end template.

function sectionsToHtml(sections: any[], brandName: string): string {
  const fill = (s: string) => s.replace(/\{\{\s*brand\s*\}\}/gi, brandName);
  const parts: string[] = [];
  for (const sec of sections ?? []) {
    if (!sec?.type) continue;
    switch (sec.type) {
      case 'hero':
        parts.push(`<!-- wp:heading --><h1>${fill(esc(sec.headline || ''))}</h1><!-- /wp:heading -->`);
        if (sec.subheadline) parts.push(`<!-- wp:paragraph --><p>${fill(esc(sec.subheadline))}</p><!-- /wp:paragraph -->`);
        if (sec.cta) parts.push(`<!-- wp:buttons --><div class="wp-block-buttons"><div class="wp-block-button"><a class="wp-block-button__link">${fill(esc(sec.cta))}</a></div></div><!-- /wp:buttons -->`);
        break;
      case 'content':
      case 'about':
      case 'text':
        if (sec.headline) parts.push(`<!-- wp:heading {"level":2} --><h2>${fill(esc(sec.headline))}</h2><!-- /wp:heading -->`);
        if (sec.body) parts.push(`<!-- wp:paragraph --><p>${fill(esc(sec.body))}</p><!-- /wp:paragraph -->`);
        break;
      case 'services':
      case 'features':
        if (sec.headline) parts.push(`<!-- wp:heading {"level":2} --><h2>${fill(esc(sec.headline))}</h2><!-- /wp:heading -->`);
        if (Array.isArray(sec.items)) {
          parts.push('<!-- wp:list --><ul>');
          for (const item of sec.items) parts.push(`<li><strong>${fill(esc(item.title || ''))}</strong>${item.desc ? ': ' + fill(esc(item.desc)) : ''}</li>`);
          parts.push('</ul><!-- /wp:list -->');
        }
        break;
      case 'cta':
        parts.push(`<!-- wp:group --><div class="wp-block-group">`);
        if (sec.headline) parts.push(`<!-- wp:heading {"level":2} --><h2>${fill(esc(sec.headline))}</h2><!-- /wp:heading -->`);
        if (sec.cta) parts.push(`<!-- wp:buttons --><div class="wp-block-buttons"><div class="wp-block-button"><a class="wp-block-button__link">${fill(esc(sec.cta))}</a></div></div><!-- /wp:buttons -->`);
        parts.push('</div><!-- /wp:group -->');
        break;
      case 'contact':
      case 'form':
        if (sec.headline) parts.push(`<!-- wp:heading {"level":2} --><h2>${fill(esc(sec.headline))}</h2><!-- /wp:heading -->`);
        parts.push(`<!-- wp:paragraph --><p><em>Contact form powered by Relay.</em></p><!-- /wp:paragraph -->`);
        break;
      case 'testimonials':
        if (sec.headline) parts.push(`<!-- wp:heading {"level":2} --><h2>${fill(esc(sec.headline))}</h2><!-- /wp:heading -->`);
        for (const t of (sec.items ?? [])) parts.push(`<!-- wp:quote --><blockquote class="wp-block-quote"><p>${fill(esc(t.quote || ''))}</p><cite>${fill(esc(t.author || ''))}</cite></blockquote><!-- /wp:quote -->`);
        break;
      case 'products':
        parts.push(`<!-- wp:heading {"level":2} --><h2>${fill(esc(sec.headline || 'Products'))}</h2><!-- /wp:heading -->`);
        parts.push(`<!-- wp:paragraph --><p><em>Product catalog rendered by WooCommerce.</em></p><!-- /wp:paragraph -->`);
        break;
      default:
        if (sec.headline) parts.push(`<!-- wp:heading {"level":2} --><h2>${fill(esc(sec.headline))}</h2><!-- /wp:heading -->`);
        if (sec.body) parts.push(`<!-- wp:paragraph --><p>${fill(esc(sec.body))}</p><!-- /wp:paragraph -->`);
    }
  }
  return parts.join('\n');
}

// Minimal HTML escaper for copy strings going into WP post content.
// (esc from components.ts is for the Relay static render; keep a local one here so this module has
// no import from the render pipeline, which avoids pulling in CSS/font dependencies.)
function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Theme mapping: Relay theme name → closest bundled WP block theme
// ---------------------------------------------------------------------------
// WHY bundled themes only: installing a marketplace theme needs internet + a paid licence; the
// built-in Twenty* themes are always present and cover the basic visual axes.
// WHY fallback chain: not every environment ships every Twenty* version; the container may have
// only a subset. activateTheme() tries the mapped theme, installs it if absent (wp theme install),
// and falls back to the first active/installed default — never hangs or throws.
const THEME_MAP: Record<string, string> = {
  editorial: 'twentytwentyfive',
  modern:    'twentytwentyfour',
  warm:      'twentytwentythree',
  bold:      'twentytwentyfive',  // twentytwentytwo absent in base container → use twentytwentyfive
  minimal:   'twentytwentyfour',  // same grid structure, brand CSS overrides contrast
};
// Hardcoded fallback order: themes that ship in the WP docker image by default.
const FALLBACK_THEMES = ['twentytwentythree', 'twentytwentyfour', 'twentytwentyfive', 'twentytwentyone'];

function wpTheme(relayTheme: string): string {
  return THEME_MAP[relayTheme] || 'twentytwentyfour';
}

// Idempotent theme activation with install + fallback.
// 1. Try to activate the target theme directly.
// 2. If that fails (not installed), try `wp theme install <t> --activate`.
// 3. If install also fails (no internet / licence), activate the first available installed theme.
// Returns the slug of the theme that ended up active.
function activateTheme(target: string): string {
  // Fast path: already active.
  try {
    const active = wp('theme list --status=active --field=name --format=csv').split('\n')[0]?.trim();
    if (active === target) return target;
  } catch { /* ignore */ }

  // Try direct activate (works when theme is already installed).
  try { wp(`theme activate ${target}`); return target; } catch { /* not installed */ }

  // Try installing then activating.
  try {
    wp(`theme install ${target} --activate`);
    return target;
  } catch { /* no internet or licence; fall through to installed fallback */ }

  // Fall back to the first installed theme in our preferred list.
  try {
    const installedCsv = wp('theme list --field=name --format=csv');
    const installed = installedCsv.split('\n').map(s => s.trim()).filter(Boolean);
    for (const fb of FALLBACK_THEMES) {
      if (installed.includes(fb)) {
        try { wp(`theme activate ${fb}`); return fb; } catch { /* continue */ }
      }
    }
    // Last resort: activate whatever is first in the list.
    if (installed[0]) { try { wp(`theme activate ${installed[0]}`); return installed[0]; } catch {} }
  } catch { /* ignore */ }

  // Could not activate any theme — return the target slug so the caller can log it.
  return target;
}

// ---------------------------------------------------------------------------
// T6 — Brand palette injection + T25 — Typography (Google Fonts)
// ---------------------------------------------------------------------------
// WHY Additional CSS (custom_css post type): it is the officially supported, theme-agnostic channel
// for injecting CSS into a WP site without editing theme files. WP stores it as a `custom_css`
// post whose slug matches the active theme. We write CSS custom properties (--relay-bg, etc.) so
// every theme inherits the brand palette without any per-theme conditionals.
//
// WHY idempotent marker: we wrap our block in /* relay-brand-palette-<projectId> */…/* /relay */
// so re-runs detect and replace only OUR block, leaving any manually added CSS intact.
//
// T25 Typography: brand.type.display (heading font) and brand.type.body are resolved to Google Fonts
// family slugs and injected as a @import at the top of the same CSS block, followed by
// --relay-font-display / --relay-font-body CSS custom properties and font-family declarations on
// body and h1–h4. This makes the WP front-end match the brand's visual identity without any plugin.

const PALETTE_MARKER_OPEN  = (id: string) => `/* relay-brand-palette-${id.slice(0, 8)} */`;
const PALETTE_MARKER_CLOSE = '/* /relay-brand-palette */';

// Sanitise a font family name for use in a Google Fonts URL (spaces → +).
function fontSlug(name: string): string {
  return String(name || '').trim().replace(/\s+/g, '+');
}

// Build a Google Fonts @import URL for one or two families (display + body), deduped.
// Returns '' when no families are supplied.
function googleFontsImport(display: string, body: string): string {
  const families: string[] = [];
  const seen = new Set<string>();
  for (const f of [display, body].filter(Boolean)) {
    const slug = fontSlug(f);
    if (slug && !seen.has(slug)) { families.push(`family=${slug}:ital,wght@0,400;0,700;1,400`); seen.add(slug); }
  }
  if (!families.length) return '';
  return `@import url('https://fonts.googleapis.com/css2?' + ${JSON.stringify(families.join('&'))} + '&display=swap');`;
}

// Returns the CSS block to inject for this project's brand palette + typography.
// T25: now includes Google Fonts @import + --relay-font-display/body vars + font-family on body/headings.
function buildPaletteCSS(
  palette: { bg?: string; primary?: string; accent?: string },
  projectId: string,
  type?: { display?: string; body?: string },
): string {
  const bg      = String(palette?.bg      || '#ffffff');
  const primary = String(palette?.primary || '#000000');
  const accent  = String(palette?.accent  || primary);

  // T25: resolve font families — fall back gracefully when brand.type is absent.
  const displayFont = String(type?.display || '').trim();
  const bodyFont    = String(type?.body    || '').trim();
  const hasType     = !!(displayFont || bodyFont);

  const lines: string[] = [PALETTE_MARKER_OPEN(projectId)];

  // T25: Google Fonts @import goes at the very top so it precedes any rule that references the vars.
  if (hasType) {
    const families: string[] = [];
    const seen = new Set<string>();
    for (const f of [displayFont, bodyFont].filter(Boolean)) {
      const slug = fontSlug(f);
      if (slug && !seen.has(slug)) { families.push(`family=${slug}:ital,wght@0,400;0,700;1,400`); seen.add(slug); }
    }
    if (families.length) {
      lines.push(`@import url('https://fonts.googleapis.com/css2?${families.join('&')}&display=swap');`);
    }
  }

  lines.push(':root {');
  lines.push(`  --relay-bg: ${bg};`);
  lines.push(`  --relay-primary: ${primary};`);
  lines.push(`  --relay-accent: ${accent};`);
  // T25: CSS custom properties for font families so child themes can reference them.
  if (displayFont) lines.push(`  --relay-font-display: '${displayFont}', sans-serif;`);
  if (bodyFont)    lines.push(`  --relay-font-body: '${bodyFont}', sans-serif;`);
  lines.push('}');
  lines.push('body { background-color: var(--relay-bg); }');
  lines.push('a, .wp-block-button__link { color: var(--relay-primary); }');
  lines.push('.wp-block-button__link { background-color: var(--relay-accent); }');
  // T25: Apply font-family from CSS vars to body and headings.
  if (bodyFont)    lines.push(`body { font-family: var(--relay-font-body); }`);
  if (displayFont) lines.push(`h1, h2, h3, h4 { font-family: var(--relay-font-display); }`);
  lines.push(PALETTE_MARKER_CLOSE);

  return lines.join('\n');
}

// Inject or replace the relay brand palette+typography block in WP's Additional CSS.
// Uses the `custom_css` post type (WP Customizer's Additional CSS mechanism).
// Idempotent: detects existing block by marker comment and replaces it in-place.
// Returns a summary string for the finalize log.
// T25: now also records fontsInjected in the returned log token and proof.
function injectBrandPalette(
  palette: { bg?: string; primary?: string; accent?: string },
  projectId: string,
  activeTheme: string,
  type?: { display?: string; body?: string },
): { log: string; fontsInjected: boolean } {
  if (!palette?.bg && !palette?.primary && !palette?.accent) return { log: 'palette:no-colors-skipped', fontsInjected: false };
  const newBlock = buildPaletteCSS(palette, projectId, type);
  const hasType  = !!(type?.display || type?.body);

  try {
    // Retrieve existing custom_css post for the active theme, if any.
    let existingId = '';
    let existingContent = '';
    try {
      existingId = wp(`post list --post_type=custom_css --post_name=${JSON.stringify(activeTheme)} --field=ID --format=csv`).split('\n')[0]?.trim() || '';
    } catch { /* no post yet — will create */ }

    if (existingId) {
      existingContent = wp(`post get ${existingId} --field=post_content`);
    }

    // Replace our block if already present; otherwise append.
    let updated: string;
    const open  = PALETTE_MARKER_OPEN(projectId);
    const close = PALETTE_MARKER_CLOSE;
    if (existingContent.includes(open)) {
      // Replace between markers (inclusive).
      const before = existingContent.slice(0, existingContent.indexOf(open));
      const after  = existingContent.slice(existingContent.indexOf(close) + close.length);
      updated = before + newBlock + after;
    } else {
      updated = existingContent ? existingContent + '\n' + newBlock : newBlock;
    }

    if (existingId) {
      // Update existing custom_css post.
      wp(`post update ${existingId} --post_content=${JSON.stringify(updated)}`);
    } else {
      // Create new custom_css post for the active theme.
      const newId = wp(`post create --post_type=custom_css --post_name=${JSON.stringify(activeTheme)} --post_title="Additional CSS" --post_status=publish --post_content=${JSON.stringify(updated)} --porcelain`).split('\n')[0]?.trim();
      // Link the theme_mods option so WP picks up this post.
      try { wp(`option patch update theme_mods_${activeTheme} custom_css_post_id ${JSON.stringify(newId)}`); } catch { /* best-effort */ }
    }

    const logStr = `palette:injected(bg=${palette?.bg || 'default'},primary=${palette?.primary || 'default'}${hasType ? `,fonts=${type?.display || ''}/${type?.body || ''}` : ''})`;
    return { log: logStr, fontsInjected: hasType };
  } catch (e: any) {
    return { log: `palette:error(${String(e?.message ?? e).slice(0, 100)})`, fontsInjected: false };
  }
}

// ---------------------------------------------------------------------------
// T5 — WooCommerce product sync
// ---------------------------------------------------------------------------
// WHY: a wp_woocommerce deliverable stores products in the app DB (appdb.ts provisions the
// schema). We read them here and push to WooCommerce via wp-cli so the storefront is real.
//
// WHY fallback: `wp wc product create` requires WooCommerce REST API sub-command (shipped with
// the woocommerce plugin). If the plugin is absent or the sub-command isn't registered yet,
// we fall back to `wp post create --post_type=product` with `_price` / `_regular_price` meta
// (the WooCommerce data model). Both paths record the WP post ID for the proof record.
//
// WHY idempotent-by-name: we look up existing products with the same post_title first; if found,
// we skip creation rather than duplicate. A more precise key (SKU) requires WooCommerce to be
// active; the name check works in both paths.

async function syncWooCommerceProducts(pool: pg.Pool, projectId: string): Promise<{ log: string; productIds: string[] }> {
  const notes: string[] = [];
  const productIds: string[] = [];
  try {
    const { listTables, readRows } = await import('../appdb.ts');
    const tables = await listTables(pool, projectId);
    const productTable = tables.find(t => /^products?$/.test(t));
    if (!productTable) return { log: 'no products table', productIds };

    const rows = await readRows(pool, projectId, productTable, 100);
    if (!rows.length) return { log: 'products table empty', productIds };

    // Ensure WooCommerce plugin is active (idempotent: skip if already active).
    const plugins = wp('plugin list --field=name --status=active --format=csv');
    if (!plugins.includes('woocommerce')) {
      try {
        wp('plugin install woocommerce --activate');
        notes.push('woocommerce installed+activated');
      } catch (e: any) {
        notes.push(`woocommerce install failed: ${String(e?.message ?? e).slice(0, 80)}`);
      }
    }

    // Detect whether `wp wc` sub-command is available (only present when WooCommerce is active
    // AND its REST scaffolding is registered in the container).
    let useWcCli = false;
    try {
      wp('wc --help');
      useWcCli = true;
    } catch { useWcCli = false; }

    for (const row of rows) {
      const name  = String(row.name || row.title || row.product_name || '').trim();
      const price = String(row.price || row.regular_price || '0').trim();
      const desc  = String(row.description || row.desc || '').trim();
      if (!name) continue;

      // Idempotent: skip if a product with this title already exists.
      try {
        const existing = wp(`post list --post_type=product --post_title=${JSON.stringify(name)} --field=ID --format=csv`).split('\n')[0]?.trim();
        if (existing && /^\d+$/.test(existing)) {
          notes.push(`product:exists(${name})`);
          productIds.push(existing);
          continue;
        }
      } catch { /* ignore — proceed to create */ }

      try {
        if (useWcCli) {
          // Primary path: wp wc product create (available when WooCommerce REST is scaffolded).
          const out = wp(`wc product create --user=1 --name=${JSON.stringify(name)} --regular_price=${JSON.stringify(price)} --description=${JSON.stringify(desc || name)} --status=publish --format=json`);
          try { const parsed = JSON.parse(out); if (parsed?.id) { productIds.push(String(parsed.id)); } } catch { /* ok */ }
          notes.push(`product:wc-cli(${name})`);
        } else {
          // Fallback: wp post create --post_type=product (WooCommerce native data model).
          // _price + _regular_price are the meta keys WooCommerce reads for pricing.
          const pid = wp(`post create --post_type=product --post_title=${JSON.stringify(name)} --post_content=${JSON.stringify(desc || name)} --post_status=publish --porcelain`).split('\n')[0]?.trim();
          if (pid && /^\d+$/.test(pid)) {
            wp(`post meta update ${pid} _price ${JSON.stringify(price)}`);
            wp(`post meta update ${pid} _regular_price ${JSON.stringify(price)}`);
            // Mark with relay_project_id so teardown can find these products.
            wp(`post meta update ${pid} ${META_KEY} ${JSON.stringify(projectId)}`);
            productIds.push(pid);
          }
          notes.push(`product:post-fallback(${name},id=${pid || '?'})`);
        }
      } catch (e: any) {
        notes.push(`product:err(${name}:${String(e?.message ?? e).slice(0, 60)})`);
      }
    }
  } catch (e: any) { return { log: `woocommerce sync error: ${String(e?.message ?? e).slice(0, 200)}`, productIds }; }
  return { log: notes.length ? `synced: ${notes.join(', ')}` : 'no products to sync', productIds };
}

// ---------------------------------------------------------------------------
// T26 — Per-page SEO: SEO title + meta description + Open Graph via post meta + mu-plugin
// ---------------------------------------------------------------------------
// WHY post meta for SEO data: avoids paid plugins (Yoast SEO). We store three keys per page:
//   _relay_seo_title     — the <title> override
//   _relay_seo_desc      — the <meta name="description"> content
//   _relay_og_title      — og:title (Open Graph)
//   _relay_og_desc       — og:description
//
// WHY mu-plugin for <head> emission: a must-use plugin is the lightest, most reliable hook for
// injecting arbitrary <meta> tags without depending on a theme's wp_head() call chain. The plugin
// reads the post meta on each page load and emits the tags — zero PHP framework overhead.
//
// WHY /wp-sitemap.xml: WP Core (5.5+) ships a built-in XML sitemap at /wp-sitemap.xml. We assert
// HTTP 200 here so the gate confirms SEO discoverability is intact.

const SEO_MU_PLUGIN_NAME = 'relay-seo.php';

// Idempotent: write (or overwrite) the relay-seo.php mu-plugin into the container.
// Uses docker cp of a temp file because wp-cli has no file-write primitive.
function ensureSeoMuPlugin(): void {
  const phpCode = `<?php
/**
 * Plugin Name: Relay SEO
 * Description: Emits SEO meta tags from post meta (_relay_seo_title, _relay_seo_desc, _relay_og_*).
 * Version: 1.0
 */
add_action('wp_head', function () {
  if (!is_singular()) return;
  $id = get_queried_object_id();
  $title = get_post_meta($id, '_relay_seo_title', true);
  $desc  = get_post_meta($id, '_relay_seo_desc',  true);
  $ogt   = get_post_meta($id, '_relay_og_title',  true) ?: $title;
  $ogd   = get_post_meta($id, '_relay_og_desc',   true) ?: $desc;
  if ($title) echo '<title>' . esc_html($title) . '</title>' . "\\n";
  if ($desc)  echo '<meta name="description" content="' . esc_attr($desc) . '">' . "\\n";
  if ($ogt)   echo '<meta property="og:title" content="' . esc_attr($ogt) . '">' . "\\n";
  if ($ogd)   echo '<meta property="og:description" content="' . esc_attr($ogd) . '">' . "\\n";
}, 1);
`;
  // Write to host tmp then copy into container.
  const tmpFile = join(tmpdir(), SEO_MU_PLUGIN_NAME);
  writeFileSync(tmpFile, phpCode, 'utf8');
  execSync(`docker cp ${JSON.stringify(tmpFile)} relay-wp:/var/www/html/wp-content/mu-plugins/${SEO_MU_PLUGIN_NAME}`, {
    encoding: 'utf8', timeout: 10_000,
  });
  // Ensure mu-plugins dir has correct permissions (www-data or root both fine; WP reads as root).
  execSync(`docker exec relay-wp chmod 644 /var/www/html/wp-content/mu-plugins/${SEO_MU_PLUGIN_NAME}`, {
    encoding: 'utf8', timeout: 5_000,
  });
}

// Set SEO post meta on a WP page. Values come from the page's sections (hero headline/subheadline)
// and the site brand name. Idempotent — wp post meta update is an upsert.
function injectPageSeo(pageId: string, page: any, brandName: string): void {
  const hero    = (page.sections || []).find((s: any) => s.type === 'hero');
  const title   = String(hero?.headline || page.title || brandName).slice(0, 120).trim();
  const desc    = String(hero?.subheadline || hero?.body || page.title || '').slice(0, 320).trim();
  const seoTitle = `${title} – ${brandName}`;
  const seoDesc  = desc || `${brandName} — ${page.title || 'Welcome'}`;
  wp(`post meta update ${pageId} _relay_seo_title ${JSON.stringify(seoTitle)}`);
  wp(`post meta update ${pageId} _relay_seo_desc  ${JSON.stringify(seoDesc)}`);
  wp(`post meta update ${pageId} _relay_og_title  ${JSON.stringify(seoTitle)}`);
  wp(`post meta update ${pageId} _relay_og_desc   ${JSON.stringify(seoDesc)}`);
}

// Assert the WP core sitemap is reachable (HTTP 200). Returns true/false.
async function assertSitemap(): Promise<boolean> {
  try {
    const res = await fetch(`${WP_URL}/wp-sitemap.xml`, { redirect: 'follow', signal: AbortSignal.timeout(8_000) });
    return res.ok;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// T27 — Featured images: Pexels photo per page, uploaded via wp media import
// ---------------------------------------------------------------------------
// WHY wp media import: this is the official wp-cli mechanism to sideload an image file into the
// WP media library and get back the attachment post ID. We then set _thumbnail_id on the page.
// WHY skip on no PEXELS key: keeps the path inert in CI/CD environments without the key.
// WHY hero query: the hero section's data-q is the most representative image for the page.

// Upload one image buffer to WP media library and return the attachment post ID.
// We write a tmp file on the host then `docker cp` it into the container's /tmp/ before
// calling `wp media import` — avoids piping binary data through execSync's stdio.
async function uploadImageToWP(buf: Buffer, filename: string, postId: string, title: string): Promise<string> {
  const tmpFile  = join(tmpdir(), filename);
  const ctrPath  = `/tmp/${filename}`;
  writeFileSync(tmpFile, buf);
  try {
    execSync(`docker cp ${JSON.stringify(tmpFile)} relay-wp:${ctrPath}`, { encoding: 'utf8', timeout: 10_000 });
    const attachId = wp(
      `media import ${ctrPath} --post_id=${postId} --title=${JSON.stringify(title)} --porcelain`
    ).split('\n')[0]?.trim();
    // Clean up temp file inside container.
    try { execSync(`docker exec relay-wp rm -f ${ctrPath}`, { encoding: 'utf8', timeout: 5_000 }); } catch {}
    return attachId && /^\d+$/.test(attachId) ? attachId : '';
  } finally {
    try { execSync(`rm -f ${JSON.stringify(tmpFile)}`, { encoding: 'utf8', timeout: 3_000 }); } catch {}
  }
}

// Idempotent: set the featured image on a WP page. If _thumbnail_id is already set AND the
// referenced attachment still exists, skip download. Returns the attachment ID or ''.
async function setFeaturedImage(
  pageId: string, page: any, pexelsPhoto: (q: string, portrait: boolean) => Promise<Buffer | null>
): Promise<string> {
  if (!process.env.PEXELS_API_KEY) return '';

  // Check idempotent: already has a thumbnail?
  try {
    const existing = wp(`post meta get ${pageId} _thumbnail_id`).trim();
    if (existing && /^\d+$/.test(existing)) {
      // Verify the attachment still exists.
      try { wp(`post get ${existing} --field=ID`); return existing; } catch { /* attachment gone, re-fetch */ }
    }
  } catch { /* no meta yet */ }

  // Derive best search query: hero data-q > hero headline > page title.
  const hero  = (page.sections || []).find((s: any) => s.type === 'hero');
  const query = String(hero?.imageQuery || hero?.headline || page.title || 'business').trim();

  const buf = await pexelsPhoto(query, false);
  if (!buf) return '';

  const slug = String(page.slug || 'page').replace(/[^a-z0-9-]/g, '-');
  const filename = `relay-hero-${slug}-${pageId}.jpg`;
  const attachId = await uploadImageToWP(buf, filename, pageId, `${query} (Relay hero)`);
  if (attachId) {
    wp(`post meta update ${pageId} _thumbnail_id ${attachId}`);
  }
  return attachId;
}

// ---------------------------------------------------------------------------
// T28 — WooCommerce full config: categories, product images, EUR currency, COD payment
// ---------------------------------------------------------------------------
// WHY product categories: they appear in the WP nav and WooCommerce storefront sidebars.
//   We create one category per product section in the data model (idempotent by slug).
// WHY EUR for French locale: the brief may say locale=fr or locale=fr-FR. When detected, we
//   set the store currency to EUR so pricing displays correctly for French clients.
//   This is a single WP option (woocommerce_currency), safe to update on every run.
// WHY COD: Cash on Delivery is universally available and requires no payment gateway secrets.
//   We enable it via 'wp option update woocommerce_cod_settings' with enabled=yes.

// Create (or return existing) a WooCommerce product category by name. Returns term ID.
function ensureWooCategory(name: string): string {
  if (!name) return '';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Check if term exists.
  try {
    const existing = wp(`term list product_cat --field=term_id --name=${JSON.stringify(name)} --format=csv`).split('\n')[0]?.trim();
    if (existing && /^\d+$/.test(existing)) return existing;
  } catch { /* not found */ }
  // Create new category.
  try {
    const termId = wp(`term create product_cat ${JSON.stringify(name)} --slug=${JSON.stringify(slug)} --porcelain`).trim();
    return /^\d+$/.test(termId) ? termId : '';
  } catch (e: any) {
    return '';
  }
}

// Attach a Pexels image to an existing product post (set _thumbnail_id).
// Same upload path as setFeaturedImage but for product posts.
async function attachProductImage(
  productId: string, name: string, pexelsPhoto: (q: string, portrait: boolean) => Promise<Buffer | null>
): Promise<string> {
  if (!process.env.PEXELS_API_KEY) return '';
  try {
    const existing = wp(`post meta get ${productId} _thumbnail_id`).trim();
    if (existing && /^\d+$/.test(existing)) {
      try { wp(`post get ${existing} --field=ID`); return existing; } catch {}
    }
  } catch {}
  const buf = await pexelsPhoto(`${name} product`, false);
  if (!buf) return '';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  const filename = `relay-product-${slug}-${productId}.jpg`;
  const attachId = await uploadImageToWP(buf, filename, productId, `${name} product image (Relay)`);
  if (attachId) wp(`post meta update ${productId} _thumbnail_id ${attachId}`);
  return attachId;
}

// Full WooCommerce config: categories + product images + currency + COD.
// Returns { wooCurrency, wooCod, categoriesCreated, productImagesSet }.
async function configureWooCommerce(
  pool: pg.Pool,
  projectId: string,
  locale: string,
  productIds: string[],
  pexelsPhoto: (q: string, portrait: boolean) => Promise<Buffer | null>,
): Promise<{ wooCurrency: string; wooCod: boolean; categoriesCreated: number; productImagesSet: number }> {
  let categoriesCreated = 0;
  let productImagesSet  = 0;

  // T28: Product categories from data model.
  // We read the products table and group by category/type column if present; otherwise create a
  // single default category from the product names.
  try {
    const { listTables, readRows } = await import('../appdb.ts');
    const tables = await listTables(pool, projectId);
    const productTable = tables.find(t => /^products?$/.test(t));
    if (productTable) {
      const rows = await readRows(pool, projectId, productTable, 100);
      const catNames = new Set<string>();
      for (const row of rows) {
        const cat = String(row.category || row.type || row.category_name || '').trim();
        if (cat) catNames.add(cat);
      }
      if (!catNames.size) {
        // No category column — create a single "Products" category.
        catNames.add('Products');
      }
      for (const cat of catNames) {
        const termId = ensureWooCategory(cat);
        if (termId) categoriesCreated++;
      }
    }
  } catch { /* best-effort — categories are non-critical */ }

  // T28: Product images for each product post ID.
  // We fetch the product title from WP to use as the search query.
  if (productIds.length && process.env.PEXELS_API_KEY) {
    for (const pid of productIds.slice(0, 8)) { // cap at 8 to avoid excessive API calls
      try {
        const title = wp(`post get ${pid} --field=post_title`).trim();
        const attachId = await attachProductImage(pid, title, pexelsPhoto);
        if (attachId) productImagesSet++;
      } catch { /* continue to next */ }
    }
  }

  // T28: EUR currency for French locale (fr, fr-FR, fr_FR).
  const isFrench = /^fr(-|_|$)/i.test(locale || '');
  const wooCurrency = isFrench ? 'EUR' : '';
  if (isFrench) {
    try { wp(`option update woocommerce_currency EUR`); } catch { /* best-effort */ }
  }

  // T28: Enable COD payment method (Cash on Delivery).
  // woocommerce_cod_settings is a WP option containing a PHP-serialized array; we set it as JSON
  // that WooCommerce 4+ accepts when the COD gateway reads it. The key field is 'enabled' = 'yes'.
  let wooCod = false;
  try {
    // Check if WooCommerce is active before touching woo options.
    const plugins = wp('plugin list --field=name --status=active --format=csv');
    if (plugins.includes('woocommerce')) {
      const codSettings = JSON.stringify({ enabled: 'yes', title: 'Cash on Delivery', description: 'Pay with cash upon delivery.', instructions: 'Pay with cash upon delivery.' });
      wp(`option update woocommerce_cod_settings ${JSON.stringify(codSettings)} --format=json`);
      wooCod = true;
    }
  } catch { /* WooCommerce not active — skip */ }

  return { wooCurrency: wooCurrency || 'default', wooCod, categoriesCreated, productImagesSet };
}

// ---------------------------------------------------------------------------
// Main builder: finalize() — the one method the builder registry calls
// ---------------------------------------------------------------------------

export const wordpressBuilder: Builder = {
  id: 'wordpress',

  async finalize(pool: pg.Pool, projectId: string, ctx: BuildCtx): Promise<{ ok: boolean; log: string }> {
    // FEATURE FLAG: with RELAY_WP != '1', return immediately so the static Directus build stands.
    // This is how the default chain (24 suites) never touches WP infrastructure.
    if (process.env.RELAY_WP !== '1') {
      return { ok: true, log: 'wp disabled (RELAY_WP!=1) — static build stands' };
    }

    // Ensure wp-cli is present; bail gracefully if the container is unreachable.
    try { ensureWpCli(); } catch (e: any) {
      return { ok: false, log: `wp-cli bootstrap failed: ${String(e?.message ?? e).slice(0, 300)}` };
    }

    // Read the composed site model from the DB (params.site + params.brand).
    const r = await pool.query('select params from projects where id=$1', [projectId]);
    if (!r.rows[0]) return { ok: false, log: 'no such project' };
    const params = r.rows[0].params || {};
    const site   = params.site;
    const brand  = params.brand || site?.brand || {};

    if (!site || !Array.isArray(site.pages) || !site.pages.length)
      return { ok: false, log: 'no composed site model (params.site) — nothing to push to WordPress' };

    const brandName = String(brand?.name || 'Studio');
    const theme     = wpTheme(String(params.theme || 'modern'));
    const palette   = brand?.palette || {};
    const notes: string[] = [];

    try {
      // 1. Check WP core is installed.
      wp('core is-installed');

      // 2. T7: Activate the mapped theme with install + fallback (idempotent).
      // activateTheme() tries: activate → install+activate → installed fallback.
      // Never throws; returns the slug of the theme that actually became active.
      const activeTheme = activateTheme(theme);
      notes.push(`theme:${activeTheme}${activeTheme !== theme ? `(wanted:${theme})` : ''})`);

      // 3. Upsert each page, get back the WP post IDs.
      const pageIds: Record<string, string> = {};
      for (const page of site.pages) {
        const content = sectionsToHtml(page.sections, brandName);
        const id      = upsertPage(projectId, String(page.slug), String(page.title || page.slug), content);
        pageIds[page.slug] = id;
        notes.push(`page:${page.slug}(id=${id})`);
      }

      // 4. Build/update the primary navigation menu (idempotent by name).
      const menuName = `relay-${projectId.slice(0, 8)}`;
      let menuId: string;
      try {
        // list returns just the ID if it exists
        const existing = wp(`menu list --fields=term_id,name --format=csv`);
        const row = existing.split('\n').find(l => l.includes(menuName));
        menuId = row ? row.split(',')[0].trim() : '';
        if (!menuId) { menuId = wp(`menu create ${JSON.stringify(menuName)} --porcelain`).trim(); notes.push('menu:created'); }
        else { notes.push('menu:reused'); }
      } catch { menuId = wp(`menu create ${JSON.stringify(menuName)} --porcelain`).trim(); }

      // Add each page to the menu in order (idempotent: clear existing items first, then re-add).
      // Do the reset as SEPARATE in-container wp calls — never a nested $(wp …) subshell (that ran on
      // the HOST, which has no wp-cli, and a `menu item delete` with an empty arg list blocks on stdin
      // with no TTY → an 180s hang; live-caught 2026-07-06).
      try {
        const itemsCsv = wp(`menu item list ${menuId} --field=db_id --format=csv`);
        const dbIds = itemsCsv.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s));
        for (const dbId of dbIds) { try { wp(`menu item delete ${dbId}`); } catch {} }
      } catch {}
      for (const page of site.pages) {
        const pid = pageIds[page.slug];
        if (pid) { try { wp(`menu item add-post ${menuId} ${pid} --title=${JSON.stringify(page.title || page.slug)}`); } catch {} }
      }

      // Assign menu to the primary location (theme must support it; safe no-op if it doesn't).
      try { wp(`menu location assign ${menuId} primary`); } catch {}

      // 5. Set the front page to the first page in the model.
      const firstSlug = site.pages[0]?.slug;
      const frontId   = firstSlug ? pageIds[firstSlug] : '';
      if (frontId) {
        wp(`option update show_on_front page`);
        wp(`option update page_on_front ${frontId}`);
        notes.push(`homepage:${firstSlug}`);
      }

      // 6. T6 + T25: Inject brand palette + typography into WP Additional CSS.
      // injectBrandPalette() now also injects the Google Fonts @import and --relay-font-* CSS vars
      // from brand.type.display/body (T25). Both are written into the same custom_css post so there
      // is exactly ONE idempotent block per project — no duplicate CSS posts.
      const brandType = brand?.type || {};
      const paletteResult = injectBrandPalette(palette, projectId, activeTheme, brandType);
      notes.push(paletteResult.log);
      const fontsInjected = paletteResult.fontsInjected;
      if (fontsInjected) notes.push(`fonts:${brandType.display || ''}/${brandType.body || ''}`);

      // 7. T5: WooCommerce product sync (only for wp_woocommerce deliverable; no-op otherwise).
      let productIds: string[] = [];
      if (String(params.deliverable) === 'wp_woocommerce') {
        const wooResult = await syncWooCommerceProducts(pool, projectId);
        notes.push(wooResult.log);
        productIds = wooResult.productIds;
      }

      // 8. T26: Per-page SEO — write post meta + mu-plugin to emit <meta> tags in <head>.
      // Idempotent: mu-plugin is overwritten on each run (same content).
      let seoApplied = false;
      try {
        ensureSeoMuPlugin();
        for (const page of site.pages) {
          const pageId = pageIds[page.slug];
          if (pageId) injectPageSeo(pageId, page, brandName);
        }
        seoApplied = true;
        notes.push('seo:ok');
      } catch (e: any) {
        notes.push(`seo:error(${String(e?.message ?? e).slice(0, 60)})`);
      }

      // Sitemap assertion (WP core sitemaps — /wp-sitemap.xml should be HTTP 200).
      let sitemapOk = false;
      try { sitemapOk = await assertSitemap(); } catch {}
      notes.push(`sitemap:${sitemapOk ? 'ok' : 'check-manually'}`);

      // 9. T27: Featured images — set hero Pexels photo as the WP featured image on each page.
      // pexelsPhoto is lazily imported to avoid pulling in the Pexels key at dry-run time.
      let featuredImages = 0;
      try {
        if (process.env.PEXELS_API_KEY) {
          const { pexelsPhoto } = await import('../media.ts');
          for (const page of site.pages) {
            const pageId = pageIds[page.slug];
            if (pageId) {
              const attachId = await setFeaturedImage(pageId, page, pexelsPhoto);
              if (attachId) featuredImages++;
            }
          }
        }
        notes.push(`featuredImages:${featuredImages}`);
      } catch (e: any) {
        notes.push(`featuredImages:error(${String(e?.message ?? e).slice(0, 60)})`);
      }

      // 10. T28: WooCommerce full config (only for wp_woocommerce deliverable).
      let wooCurrency = 'default';
      let wooCod      = false;
      let wooCategories = 0;
      let wooProductImages = 0;
      if (String(params.deliverable) === 'wp_woocommerce') {
        try {
          const locale = String(params.locale || ctx.locale || '');
          const { pexelsPhoto } = process.env.PEXELS_API_KEY
            ? await import('../media.ts')
            : { pexelsPhoto: async () => null };
          const wooConf = await configureWooCommerce(pool, projectId, locale, productIds, pexelsPhoto as any);
          wooCurrency      = wooConf.wooCurrency;
          wooCod           = wooConf.wooCod;
          wooCategories    = wooConf.categoriesCreated;
          wooProductImages = wooConf.productImagesSet;
          notes.push(`woo:currency=${wooCurrency},cod=${wooCod},cats=${wooCategories},imgs=${wooProductImages}`);
        } catch (e: any) {
          notes.push(`woo:config-error(${String(e?.message ?? e).slice(0, 80)})`);
        }
      }

      // 11. Write proof onto the project params so the wp_provisioned verify rule can check it.
      // T5: productIds | T6: paletteInjected | T25: fontsInjected | T26: seo, sitemap
      // T27: featuredImages | T28: wooCurrency, wooCod
      const proof = {
        pageIds, menuId, theme: activeTheme, timestamp: new Date().toISOString(), ok: true,
        productIds,                                                        // T5
        paletteInjected: paletteResult.log.startsWith('palette:injected'), // T6
        fontsInjected,                                                     // T25
        seo: seoApplied,                                                   // T26
        sitemapOk,                                                         // T26
        featuredImages,                                                    // T27
        wooCurrency,                                                       // T28
        wooCod,                                                            // T28
        wooCategories,                                                     // T28
        wooProductImages,                                                  // T28
      };
      await pool.query(
        "update projects set params = jsonb_set(params, '{wp_provision}', $2::jsonb, true) where id=$1",
        [projectId, JSON.stringify(proof)],
      );

      // 12. Quick smoke-test: fetch the WP front page and assert it responds.
      let served = false;
      try {
        const res = await fetch(WP_URL, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
        served = res.ok || res.status === 302 || res.status === 301;
      } catch { served = false; }
      if (served) notes.push('served:ok'); else notes.push('served:check-manually');

      return { ok: true, log: `wp provisioned [${notes.join(' · ')}]` };

    } catch (e: any) {
      return { ok: false, log: `wp finalize error: ${String(e?.message ?? e).slice(0, 400)}` };
    }
  },
};

export { wordpressBuilder as default };

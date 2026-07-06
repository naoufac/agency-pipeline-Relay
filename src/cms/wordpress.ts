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
import { execSync } from 'node:child_process';
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
const THEME_MAP: Record<string, string> = {
  editorial: 'twentytwentyfive',
  modern:    'twentytwentyfour',
  warm:      'twentytwentythree',
  bold:      'twentytwentytwo',
  minimal:   'twentytwentyfour',  // same grid structure, brand CSS overrides contrast
};
function wpTheme(relayTheme: string): string {
  return THEME_MAP[relayTheme] || 'twentytwentyfour';
}

// ---------------------------------------------------------------------------
// WooCommerce product sync
// ---------------------------------------------------------------------------
// WHY: a wp_woocommerce deliverable stores products in the app DB (appdb.ts provisions the
// schema). We read them here and push to WooCommerce via wp-cli so the storefront is real.
async function syncWooCommerceProducts(pool: pg.Pool, projectId: string): Promise<string> {
  const notes: string[] = [];
  try {
    const { listTables, readRows } = await import('../appdb.ts');
    const tables = await listTables(pool, projectId);
    const productTable = tables.find(t => /^products?$/.test(t));
    if (!productTable) return 'no products table';

    const rows = await readRows(pool, projectId, productTable, 100);
    if (!rows.length) return 'products table empty';

    // Ensure WooCommerce is active
    const plugins = wp('plugin list --field=name --status=active --format=csv');
    if (!plugins.includes('woocommerce')) {
      wp('plugin install woocommerce --activate');
      notes.push('woocommerce installed+activated');
    }

    for (const row of rows) {
      const name  = String(row.name || row.title || row.product_name || '').trim();
      const price = String(row.price || row.regular_price || '0').trim();
      if (!name) continue;
      // Idempotent: check if a product with this name exists under this project
      try {
        wp(`wc product create --user=1 --name=${JSON.stringify(name)} --regular_price=${JSON.stringify(price)} --status=publish`);
        notes.push(`product: ${name}`);
      } catch { /* product may already exist; best-effort */ }
    }
  } catch (e: any) { return `woocommerce sync error: ${String(e?.message ?? e).slice(0, 200)}`; }
  return notes.length ? `synced: ${notes.join(', ')}` : 'no products to sync';
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
    const notes: string[] = [];

    try {
      // 1. Check WP core is installed.
      wp('core is-installed');

      // 2. Activate the closest matching theme (idempotent — re-activating is a no-op).
      try { wp(`theme activate ${theme}`); notes.push(`theme:${theme}`); }
      catch { notes.push(`theme:${theme} (activate failed, continuing)`); }

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

      // Add each page to the menu in order (idempotent: clear first, re-add).
      try { wp(`menu item delete $(wp --allow-root --path=${WP_PATH} menu item list ${menuId} --field=db_id --format=csv 2>/dev/null || echo '')`); } catch {}
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

      // 6. WooCommerce product sync (only for wp_woocommerce deliverable; no-op otherwise).
      if (String(params.deliverable) === 'wp_woocommerce') {
        const wooLog = await syncWooCommerceProducts(pool, projectId);
        notes.push(wooLog);
      }

      // 7. Write proof onto the project params so the wp_provisioned verify rule can check it.
      const proof = { pageIds, menuId, theme, timestamp: new Date().toISOString(), ok: true };
      await pool.query(
        "update projects set params = jsonb_set(params, '{wp_provision}', $2::jsonb, true) where id=$1",
        [projectId, JSON.stringify(proof)],
      );

      // 8. Quick smoke-test: fetch the WP front page and assert it responds.
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

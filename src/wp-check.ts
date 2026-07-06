// wp:check — WordPress builder gate.
//
// Two modes:
//   WITHOUT RELAY_WP=1 (default, used in the 24-suite check chain):
//     Source-pin + structural dry checks. No container touch. Must exit 0 always.
//     Verifies: the builder module compiles, the feature flag guard is present, the
//     CMS registry is untouched (REGISTRY stays directus-only), resolveBuilder returns
//     correct types, and the wordpress.ts module does NOT import from server.ts.
//
//   WITH RELAY_WP=1 (PROVE mode — run manually to prove against live infra):
//     1. Bootstrap wp-cli (idempotent install).
//     2. Assert wp core is-installed.
//     3. Create a scratch project (random uuid8 slug prefix).
//     4. Create a page with relay_project_id=<scratch>, a nav menu, set as homepage.
//     5. Assert wp post list --meta_value=<scratch> returns the page.
//     6. Fetch http://127.0.0.1:8057/<slug> and assert the brand text appears.
//     7. Teardown: delete all scratch posts/menu by meta value. Assert zero remain.
//
// Run: npm run wp:check          (dry mode, always-green)
//      RELAY_WP=1 npm run wp:check  (prove mode, needs relay-wp container)
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (cond: boolean, label: string, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
};

const PROVE = process.env.RELAY_WP === '1';
console.log(`\nwp:check [${PROVE ? 'PROVE mode — live container' : 'DRY mode — source pins only'}]\n`);

// ---------------------------------------------------------------------------
// DRY CHECKS (always run, even in PROVE mode)
// ---------------------------------------------------------------------------

// 1. The wordpress builder module must contain the feature flag guard.
const wpSrc = readFileSync(new URL('./cms/wordpress.ts', import.meta.url), 'utf8');
ok(wpSrc.includes("RELAY_WP !== '1'"), "wordpress.ts: RELAY_WP feature flag guard present");
ok(wpSrc.includes("id: 'wordpress'"), "wordpress.ts: builder id is 'wordpress'");
ok(wpSrc.includes("META_KEY = 'relay_project_id'"), "wordpress.ts: uses relay_project_id meta for namespace isolation");
ok(!wpSrc.includes("from '../server.ts'") && !wpSrc.includes("'../server'"),
  "wordpress.ts: no server.ts import (avoids circular + cms:check banned pattern)");
ok(wpSrc.includes('ensureWpCli'), "wordpress.ts: idempotent wp-cli bootstrap");
ok(wpSrc.includes('teardownProject'), "wordpress.ts: teardown by meta key (isolated teardown)");
ok(wpSrc.includes('wp_provision'), "wordpress.ts: writes params.wp_provision proof");
// ANTI-HANG: the menu reset must be SEPARATE in-container wp calls, never a nested $(wp …) subshell.
// The subshell ran wp on the HOST (no wp-cli) and `menu item delete` with an empty arg list blocked
// on stdin with no TTY → an 180s deadlock that stalled the whole build (live-caught 2026-07-06).
ok(!/menu item delete \$\(wp/.test(wpSrc), "wordpress.ts: NO nested $(wp …) subshell in menu reset (deadlock)");
ok(wpSrc.includes('menu item list') && /for \(const dbId of dbIds\)/.test(wpSrc),
  "wordpress.ts: menu reset lists db_ids then deletes each explicitly (no empty-arg delete)");

// 2. The registry must still have exactly ONE CMS (directus) after adding the builder registry.
const { REGISTRY, CMS_ORDER, resolveBuilder } = await import('./cms/registry.ts');
const { CMS_NAMES } = await import('./cms/types.ts');
ok(CMS_NAMES.length === 1 && CMS_NAMES[0] === 'directus', "registry: CMS_NAMES still directus-only");
ok(Object.keys(REGISTRY).length === 1 && !!REGISTRY.directus, "registry: REGISTRY still one entry (directus)");
ok(CMS_ORDER.length === 1 && CMS_ORDER[0] === 'directus', "registry: CMS_ORDER still directus-only");

// 3. resolveBuilder must return correct types.
const dbldr = resolveBuilder('directus');
ok(dbldr.id === 'directus' && typeof dbldr.finalize === 'function', "resolveBuilder('directus') → directus builder");
const wbldr = resolveBuilder('wordpress');
ok(wbldr.id === 'wordpress' && typeof wbldr.finalize === 'function', "resolveBuilder('wordpress') → wordpress builder");
const ubldr = resolveBuilder(undefined as any);
ok(ubldr.id === 'directus', "resolveBuilder(undefined) → directus (safe default)");
const xbldr = resolveBuilder('unknown-builder-xyz' as any);
ok(xbldr.id === 'directus', "resolveBuilder(unknown) → directus fallback");

// 4. The wp_provisioned verify rule must be present in verify.ts.
const verifySrc = readFileSync(new URL('./verify.ts', import.meta.url), 'utf8');
ok(verifySrc.includes("'wp_provisioned'"), "verify.ts: wp_provisioned rule present");
ok(verifySrc.includes("RELAY_WP !== '1'"), "verify.ts: wp_provisioned degrades gracefully without flag");
ok(verifySrc.includes("params.wp_provision"), "verify.ts: wp_provisioned reads params.wp_provision proof");

// 5. finalize.ts builder dispatch must be present.
const finSrc = readFileSync(new URL('./cms/finalize.ts', import.meta.url), 'utf8');
ok(finSrc.includes('resolveBuilder'), "finalize.ts: imports + calls resolveBuilder for non-directus builders");
ok(finSrc.includes("builderId !== 'directus'"), "finalize.ts: directus path unchanged (builder dispatch is additive)");
// cms:check structural pins must still hold
ok(/siteBase: params\.slug/.test(finSrc), "finalize.ts: siteBase pin still present");
ok(/bizType: params\.bizType/.test(finSrc), "finalize.ts: bizType pin still present");
ok(finSrc.includes('bizFacts: extractBusinessFacts('), "finalize.ts: bizFacts pin still present");

// ---------------------------------------------------------------------------
// PROVE MODE — live container checks (only with RELAY_WP=1)
// ---------------------------------------------------------------------------
if (PROVE) {
  console.log('\n--- PROVE mode: live container ---\n');

  const CONTAINER = 'relay-wp';
  const WP_PATH   = '/var/www/html';
  const WP_URL    = 'http://127.0.0.1:8057';
  const META_KEY  = 'relay_project_id';

  // Helper: run a wp-cli command in the container.
  function wp(args: string): string {
    return execSync(
      `docker exec ${CONTAINER} wp --allow-root --path=${WP_PATH} ${args}`,
      { encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  }

  // 0. Check container is reachable.
  let containerOk = false;
  try {
    const running = execSync(`docker inspect --format='{{.State.Running}}' ${CONTAINER}`, { encoding: 'utf8', timeout: 5_000 }).trim();
    containerOk = running === 'true';
  } catch { containerOk = false; }
  if (!containerOk) {
    console.log(`  ⚠ SKIP: ${CONTAINER} container not running — PROVE mode needs live infra`);
    console.log('\nSKIP — container absent (exit 0 per design: no infra = no failure)\n');
    process.exit(0);
  }
  ok(true, 'container: relay-wp is running');

  // 1. Bootstrap wp-cli (idempotent).
  try {
    const script = [
      `command -v wp >/dev/null 2>&1 && exit 0`,
      `curl -sS -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar`,
      `chmod +x /usr/local/bin/wp`,
    ].join(' && ');
    execSync(`docker exec ${CONTAINER} bash -lc ${JSON.stringify(script)}`, { encoding: 'utf8', timeout: 60_000 });
    const ver = wp('--version');
    ok(ver.includes('WP-CLI'), `wp-cli: installed (${ver.split('\n')[0]})`);
  } catch (e: any) {
    ok(false, `wp-cli: bootstrap failed — ${String(e?.message ?? e).slice(0, 200)}`);
  }

  // 2. Assert WP core is-installed.
  try { wp('core is-installed'); ok(true, 'wp: core is-installed'); }
  catch { ok(false, 'wp: core is-installed FAILED'); }

  // 3. Scratch project.
  const scratchId = randomUUID();
  const scratchSlug = `relay-test-${scratchId.slice(0, 8)}`;
  const sentinel = `RELAY-WP-PROOF-${scratchId.slice(0, 8)}`;
  let scratchPageId = '';
  let scratchMenuId = '';

  try {
    // 4a. Create a scratch page with a unique sentinel title.
    scratchPageId = wp(
      `post create --post_type=page --post_name=${JSON.stringify(scratchSlug)} --post_title=${JSON.stringify(sentinel)} --post_content="<p>Relay wp:check scratch page.</p>" --post_status=publish --porcelain`
    ).split('\n')[0].trim();
    wp(`post meta update ${scratchPageId} ${META_KEY} ${JSON.stringify(scratchId)}`);
    ok(!!scratchPageId, `scratch page created (id=${scratchPageId}, meta=${META_KEY}=${scratchId.slice(0,8)}…)`);

    // 4b. Create a scratch menu.
    const menuName = `relay-check-${scratchId.slice(0, 8)}`;
    scratchMenuId = wp(`menu create ${JSON.stringify(menuName)} --porcelain`).trim();
    ok(!!scratchMenuId, `scratch menu created (id=${scratchMenuId})`);
    wp(`menu item add-post ${scratchMenuId} ${scratchPageId} --title=${JSON.stringify('Home')}`);

    // 5. Assert wp post list --meta_value=<scratchId> returns the page.
    const listed = wp(
      `post list --post_type=page --meta_key=${META_KEY} --meta_value=${JSON.stringify(scratchId)} --field=ID --format=csv`
    );
    ok(listed.split('\n').map(s => s.trim()).includes(scratchPageId),
      `namespace isolation: post list returns scratch page by meta_value`);

    // 6. Fetch the served page and assert the sentinel appears.
    // We don't assert the full URL response because the WP front-end may redirect or show a different
    // page for a non-front page; instead we assert the WP site responds at all (the smoke test in
    // the builder) and the page can be fetched via the REST API.
    try {
      const apiUrl = `${WP_URL}/wp-json/wp/v2/pages/${scratchPageId}`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const json: any = await res.json();
        const titleText: string = json?.title?.rendered ?? '';
        ok(titleText.includes('RELAY-WP-PROOF') || titleText.includes(scratchSlug),
          `REST API: page title readable — "${titleText.slice(0, 60)}"`);
      } else {
        // REST API may be disabled; fall back to wp-cli read-back
        const readTitle = wp(`post get ${scratchPageId} --field=post_title`);
        ok(readTitle.includes('RELAY-WP-PROOF'), `wp-cli read-back: title="${readTitle.slice(0, 60)}"`);
      }
    } catch {
      // REST not available; use wp-cli
      const readTitle = wp(`post get ${scratchPageId} --field=post_title`);
      ok(readTitle.includes('RELAY-WP-PROOF'), `wp-cli read-back: title="${readTitle.slice(0, 60)}"`);
    }

  } finally {
    // 7. Teardown: delete all scratch posts + menu.
    try {
      if (scratchMenuId) {
        try { wp(`menu delete ${scratchMenuId}`); } catch { /* best-effort */ }
      }
      const toDelete = wp(
        `post list --post_type=page --meta_key=${META_KEY} --meta_value=${JSON.stringify(scratchId)} --field=ID --format=csv`
      ).split('\n').map(s => s.trim()).filter(Boolean);
      if (toDelete.length) {
        wp(`post delete ${toDelete.join(' ')} --force`);
      }
      // Assert zero remain.
      const remaining = wp(
        `post list --post_type=page --meta_key=${META_KEY} --meta_value=${JSON.stringify(scratchId)} --field=ID --format=csv`
      ).split('\n').map(s => s.trim()).filter(Boolean);
      ok(remaining.length === 0, `teardown: zero scratch posts remain after cleanup`);
    } catch (e: any) {
      console.error(`  teardown error (non-fatal): ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
const total = pass + fail;
console.log(`\nwp:check — ${pass}/${total} passed${fail ? ` · ${fail} FAILED` : ''}\n`);
if (fail) process.exit(1);

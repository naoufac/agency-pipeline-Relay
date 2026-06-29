// WordPress Multisite generator — Relay turns a brief into a REAL, isolated, branded website.
// Each project = its own WP subsite (own theme, own branding, own admin, own content). Branding
// (fonts/colours) lives in the THEME's Additional CSS — site-wide, SEPARATE from content — so a user
// (or the LLM) adding a page is a content+menu op that CANNOT break branding/fonts/navigation.
// LLM = copywriter only (fast, minimal reasoning). Code does everything structural.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { llmText } from '../agents.ts';

const pexec = promisify(execFile);
const HOST = process.env.WP_HOST || 'https://sites.naples.agency';

// async (non-blocking) so the http server stays responsive during a ~minute build.
async function wp(args: string[], url?: string): Promise<string> {
  const env = ['-e', 'HOME=/tmp', '-e', 'WORDPRESS_DB_HOST=relay-wp-db', '-e', 'WORDPRESS_DB_USER=wp',
    '-e', `WORDPRESS_DB_PASSWORD=${process.env.WP_DB_PW}`, '-e', 'WORDPRESS_DB_NAME=wordpress'];
  const base = ['run', '--rm', '--user', 'root', '--network', 'relay-wp', '--volumes-from', 'relay-wp', ...env,
    'wordpress:cli', 'wp', '--allow-root'];
  const full = url ? [...base, `--url=${url}`, ...args] : [...base, ...args];
  const { stdout } = await pexec('docker', full, { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}
async function put(containerPath: string, content: string): Promise<void> {
  writeFileSync('/tmp/relay-wp-put', content);
  await pexec('docker', ['cp', '/tmp/relay-wp-put', `relay-wp:${containerPath}`]);
}
function extractJson(s: string): any {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no JSON in LLM output');
  return JSON.parse(s.slice(a, b + 1));
}
// the model occasionally returns an empty/garbled completion — retry a few times before giving up.
async function llmJson(system: string, user: string, tokens: number, tries = 3): Promise<any> {
  let last = '';
  for (let i = 0; i < tries; i++) {
    last = await llmText(system, user, tokens);
    try { return extractJson(last); } catch { /* retry */ }
  }
  throw new Error('LLM returned no usable JSON after ' + tries + ' tries: ' + last.slice(0, 120));
}

export interface WpSite { slug: string; siteName: string; url: string; adminUrl: string; pages: string[]; engine: string; shopUrl?: string; }

export async function generateWordpressSite(brief: string, ecom = false): Promise<WpSite> {
  // 1) LLM writes the brand + copy (only). It never decides the stack.
  const system = 'You write a complete small website as raw JSON only — no commentary, no markdown, no <think>.';
  const user =
`Brief: "${brief}".
Return ONLY this JSON:
{"slug":"<short url-safe, a-z0-9->","site_name":"<brand name>","tagline":"<5-8 word tagline>",
 "brand":{"primary":"#hex","accent":"#hex","bg":"#hex","text":"#hex","heading_font":"<a real Google font>","body_font":"<a real Google font>"},
 "pages":[{"title":"Home","slug":"home","content":"<rich HTML: <h2> <p> <ul> <li> <strong> — a strong hero line + 2-3 value sections of specific real copy>"},
          {"title":"About","slug":"about","content":"..."},
          {"title":"${ecom ? 'Shipping &amp; Returns' : 'Services'}","slug":"${ecom ? 'shipping' : 'services'}","content":"..."},
          {"title":"Contact","slug":"contact","content":"..."}],
 "products":[${ecom ? '{"name":"<product>","price":"29.00","description":"<1-2 sentences>"}' : ''}]}
Pick brand colours + Google fonts that genuinely fit the brief. Specific, confident copy.${ecom ? ' Fill "products" with 5 real products that fit the brief (realistic prices).' : ' Leave "products" as an empty array.'}`;
  const spec = await llmJson(system, user, 9000);
  const slug = (String(spec.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30)) || ('site' + Math.random().toString(16).slice(2, 6));

  // 2) Provision an ISOLATED subsite (own theme/branding/content/admin).
  try { await wp(['site', 'create', `--slug=${slug}`, `--title=${spec.site_name || slug}`]); } catch { /* may already exist */ }
  const url = `${HOST}/${slug}/`;

  // 3) Activate the theme (branding/nav live here, not in content).
  try { await wp(['theme', 'enable', 'twentytwentyone', '--network']); } catch {}
  await wp(['theme', 'activate', 'twentytwentyone'], url);

  // 4) Build: branding (Additional CSS, site-wide), pages, front page, menu → nav. Code only.
  await put('/var/www/html/relay-wp-site.json', JSON.stringify(spec));
  await put('/var/www/html/relay-wp-build.php', BUILD_PHP);
  const out = await wp(['eval-file', '/var/www/html/relay-wp-build.php'], url);
  const res = extractJson(out);

  // 5) ECOM: a real WooCommerce store (shop/cart/checkout + the brief's products), per-subsite.
  let shopUrl: string | undefined;
  if (ecom) {
    try { await wp(['plugin', 'install', 'woocommerce', '--activate'], url); } catch {}
    try { await wp(['wc', 'tool', 'run', 'install_pages', '--user=1'], url); } catch {}
    await put('/var/www/html/relay-wp-shop.json', JSON.stringify({ products: spec.products || [] }));
    await put('/var/www/html/relay-wp-shop.php', WOO_PHP);
    try { const so = await wp(['eval-file', '/var/www/html/relay-wp-shop.php'], url); shopUrl = extractJson(so).shop; } catch {}
  }

  return { slug, siteName: spec.site_name || slug, url, adminUrl: url + 'wp-admin/', pages: res.pages || [], engine: ecom ? 'woocommerce' : 'wordpress', shopUrl };
}

// SAFE EDIT: add a page on request. LLM writes the new page's COPY only; code inserts a page + adds it
// to the existing menu. The theme + branding CSS are never touched → branding/fonts/nav can't break.
export async function addWordpressPage(slug: string, request: string): Promise<{ url: string; title: string }> {
  const url = `${HOST}/${slug}/`;
  const system = 'You write ONE website page as raw JSON only — no commentary, no markdown.';
  const user = `For the site, write the page the user asked for: "${request}". Return ONLY: {"title":"<page title>","slug":"<url-safe>","content":"<rich HTML using <h2> <p> <ul> <li> <strong> — real specific copy>"}`;
  const p = await llmJson(system, user, 4000);
  await put('/var/www/html/relay-wp-addpage.json', JSON.stringify(p));
  await put('/var/www/html/relay-wp-addpage.php', ADDPAGE_PHP);
  const out = await wp(['eval-file', '/var/www/html/relay-wp-addpage.php'], url);
  const res = extractJson(out);
  return { url: res.url, title: p.title };
}

const BUILD_PHP = `<?php
$d = json_decode(file_get_contents('/var/www/html/relay-wp-site.json'), true);
$b = $d['brand'];
$hf = $b['heading_font']; $bf = $b['body_font'];
$css = "@import url('https://fonts.googleapis.com/css2?family=".str_replace(' ','+',$hf).":wght@600;800&family=".str_replace(' ','+',$bf).":wght@400;600&display=swap');\\n";
$css .= ":root{--brand:{$b['primary']};--accent:{$b['accent']};--bg:{$b['bg']};--ink:{$b['text']};}\\n";
$css .= "body,.entry-content{background:var(--bg)!important;color:var(--ink)!important;font-family:'{$bf}',-apple-system,sans-serif!important;}\\n";
$css .= "h1,h2,h3,.site-title,.entry-title{font-family:'{$hf}',Georgia,serif!important;color:var(--ink)!important;}\\n";
$css .= ".site-title a{color:var(--ink)!important;} a{color:var(--brand)!important;}\\n";
$css .= ".wp-block-button__link,.button,input[type=submit]{background:var(--brand)!important;color:#fff!important;border-radius:8px;}\\n";
$css .= "#site-navigation a,.menu a{color:var(--ink)!important;font-weight:600;}\\n";
wp_update_custom_css_post($css);
update_option('blogname', $d['site_name']);
update_option('blogdescription', $d['tagline']);
$ids = [];
foreach ($d['pages'] as $p) {
  $id = wp_insert_post(['post_type'=>'page','post_title'=>$p['title'],'post_name'=>$p['slug'],'post_content'=>$p['content'],'post_status'=>'publish']);
  $ids[$p['slug']] = $id;
}
$home = $ids['home'] ?? array_values($ids)[0];
update_option('show_on_front','page'); update_option('page_on_front',$home);
$menu_name = 'Primary';
$menu = wp_get_nav_menu_object($menu_name); $menu_id = $menu ? $menu->term_id : wp_create_nav_menu($menu_name);
foreach ($d['pages'] as $p) {
  wp_update_nav_menu_item($menu_id, 0, ['menu-item-title'=>$p['title'],'menu-item-object'=>'page','menu-item-object-id'=>$ids[$p['slug']],'menu-item-type'=>'post_type','menu-item-status'=>'publish']);
}
$loc = get_theme_mod('nav_menu_locations', []); $loc['primary'] = $menu_id; set_theme_mod('nav_menu_locations', $loc);
$urls = []; foreach ($ids as $s=>$id) $urls[] = get_permalink($id);
echo json_encode(['home'=>get_permalink($home), 'pages'=>$urls]);
`;

const ADDPAGE_PHP = `<?php
$p = json_decode(file_get_contents('/var/www/html/relay-wp-addpage.json'), true);
$id = wp_insert_post(['post_type'=>'page','post_title'=>$p['title'],'post_name'=>$p['slug'],'post_content'=>$p['content'],'post_status'=>'publish']);
$loc = get_theme_mod('nav_menu_locations', []); $menu_id = isset($loc['primary']) ? $loc['primary'] : 0;
if ($menu_id) wp_update_nav_menu_item($menu_id, 0, ['menu-item-title'=>$p['title'],'menu-item-object'=>'page','menu-item-object-id'=>$id,'menu-item-type'=>'post_type','menu-item-status'=>'publish']);
echo json_encode(['url'=>get_permalink($id)]);
`;

const WOO_PHP = `<?php
$d = json_decode(file_get_contents('/var/www/html/relay-wp-shop.json'), true);
$made = 0;
foreach (($d['products'] ?? []) as $pr) {
  if (empty($pr['name'])) continue;
  $p = new WC_Product_Simple();
  $p->set_name($pr['name']);
  $price = preg_replace('/[^0-9.]/', '', (string)($pr['price'] ?? '19.00')); if ($price === '') $price = '19.00';
  $p->set_regular_price($price);
  $p->set_description($pr['description'] ?? '');
  $p->set_short_description($pr['description'] ?? '');
  $p->set_status('publish'); $p->set_catalog_visibility('visible');
  $p->save(); $made++;
}
$shop_id = wc_get_page_id('shop');
$loc = get_theme_mod('nav_menu_locations', []); $menu_id = isset($loc['primary']) ? $loc['primary'] : 0;
if ($menu_id && $shop_id > 0) {
  wp_update_nav_menu_item($menu_id, 0, ['menu-item-title'=>'Shop','menu-item-object'=>'page','menu-item-object-id'=>$shop_id,'menu-item-type'=>'post_type','menu-item-status'=>'publish']);
}
echo json_encode(['shop'=>($shop_id>0?get_permalink($shop_id):''), 'products'=>$made]);
`;

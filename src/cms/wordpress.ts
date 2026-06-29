// WordPress Multisite generator — Relay turns a brief into a REAL, isolated, branded website.
// Each project = its own WP subsite (own theme, own branding, own admin, own content). Branding
// (fonts/colours) lives in the THEME's Additional CSS — site-wide, SEPARATE from content — so a user
// (or the LLM) adding a page is a content+menu op that CANNOT break branding/fonts/navigation.
// LLM = copywriter only (fast, minimal reasoning). Code does everything structural.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { llmText } from '../agents.ts';

const HOST = process.env.WP_HOST || 'https://sites.naples.agency';

function wp(args: string[], url?: string): string {
  const env = ['-e', 'HOME=/tmp', '-e', 'WORDPRESS_DB_HOST=relay-wp-db', '-e', 'WORDPRESS_DB_USER=wp',
    '-e', `WORDPRESS_DB_PASSWORD=${process.env.WP_DB_PW}`, '-e', 'WORDPRESS_DB_NAME=wordpress'];
  const base = ['run', '--rm', '--user', 'root', '--network', 'relay-wp', '--volumes-from', 'relay-wp', ...env,
    'wordpress:cli', 'wp', '--allow-root'];
  const full = url ? [...base, `--url=${url}`, ...args] : [...base, ...args];
  return execFileSync('docker', full, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}
function put(containerPath: string, content: string): void {
  writeFileSync('/tmp/relay-wp-put', content);
  execFileSync('docker', ['cp', '/tmp/relay-wp-put', `relay-wp:${containerPath}`]);
}
function extractJson(s: string): any {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no JSON in LLM output');
  return JSON.parse(s.slice(a, b + 1));
}

export interface WpSite { slug: string; siteName: string; url: string; adminUrl: string; pages: string[]; }

export async function generateWordpressSite(brief: string): Promise<WpSite> {
  // 1) LLM writes the brand + copy (only). It never decides the stack.
  const system = 'You write a complete small website as raw JSON only — no commentary, no markdown, no <think>.';
  const user =
`Brief: "${brief}".
Return ONLY this JSON:
{"slug":"<short url-safe, a-z0-9->","site_name":"<brand name>","tagline":"<5-8 word tagline>",
 "brand":{"primary":"#hex","accent":"#hex","bg":"#hex","text":"#hex","heading_font":"<a real Google font>","body_font":"<a real Google font>"},
 "pages":[{"title":"Home","slug":"home","content":"<rich HTML: <h2> <p> <ul> <li> <strong> — a strong hero line + 2-3 value sections of specific real copy>"},
          {"title":"About","slug":"about","content":"..."},
          {"title":"Services","slug":"services","content":"..."},
          {"title":"Contact","slug":"contact","content":"..."}]}
Pick brand colours + Google fonts that genuinely fit the brief. Specific, confident copy.`;
  const spec = extractJson(await llmText(system, user, 9000));
  const slug = (String(spec.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30)) || ('site' + Math.random().toString(16).slice(2, 6));

  // 2) Provision an ISOLATED subsite (own theme/branding/content/admin).
  try { wp(['site', 'create', `--slug=${slug}`, `--title=${spec.site_name || slug}`]); } catch { /* may already exist */ }
  const url = `${HOST}/${slug}/`;

  // 3) Activate the theme (branding/nav live here, not in content).
  try { wp(['theme', 'enable', 'twentytwentyone', '--network']); } catch {}
  wp(['theme', 'activate', 'twentytwentyone'], url);

  // 4) Build: branding (Additional CSS, site-wide), pages, front page, menu → nav. Code only.
  put('/var/www/html/relay-wp-site.json', JSON.stringify(spec));
  put('/var/www/html/relay-wp-build.php', BUILD_PHP);
  const out = wp(['eval-file', '/var/www/html/relay-wp-build.php'], url);
  const res = extractJson(out);

  return { slug, siteName: spec.site_name || slug, url, adminUrl: url + 'wp-admin/', pages: res.pages || [] };
}

// SAFE EDIT: add a page on request. LLM writes the new page's COPY only; code inserts a page + adds it
// to the existing menu. The theme + branding CSS are never touched → branding/fonts/nav can't break.
export async function addWordpressPage(slug: string, request: string): Promise<{ url: string; title: string }> {
  const url = `${HOST}/${slug}/`;
  const system = 'You write ONE website page as raw JSON only — no commentary, no markdown.';
  const user = `For the site, write the page the user asked for: "${request}". Return ONLY: {"title":"<page title>","slug":"<url-safe>","content":"<rich HTML using <h2> <p> <ul> <li> <strong> — real specific copy>"}`;
  const p = extractJson(await llmText(system, user, 4000));
  put('/var/www/html/relay-wp-addpage.json', JSON.stringify(p));
  put('/var/www/html/relay-wp-addpage.php', ADDPAGE_PHP);
  const out = wp(['eval-file', '/var/www/html/relay-wp-addpage.php'], url);
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

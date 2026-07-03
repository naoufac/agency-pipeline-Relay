// PWA — every produced site installs as an app (owner-directed, 2026-07-04: "the honest Android
// answer"). Deterministic and COMPILED from the locked brand — the LLM never touches any of it:
//   manifest.webmanifest  — name/short_name from the brand, colours from the locked tokens
//   icon-192/512.png      — the brand initial on the brand primary, painted by the REAL browser
//                           (same rule as the PDP no-photo panel; no new image dependency)
//   sw.js                 — the offline shell. PAGES are network-first (a Content-tab price edit
//                           must show on the next load — the PQ3 live promise outranks offline
//                           freshness), static assets cache-first, and /api/ is NEVER cached
//                           (live stock/prices/receipts; a stale cart is worse than no cart).
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { screenshot } from './browser.ts';

const isHex = (v: any) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim());
// minimal contrast pick (mirrors render.ts pickOn) — the icon glyph must read on the brand primary
function lum(hex: string) { let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); }
const contrast = (a: string, b: string) => { const L1 = lum(a), L2 = lum(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
const onColor = (bg: string) => contrast('#ffffff', bg) >= contrast('#0b1220', bg) ? '#ffffff' : '#0b1220';

export type PwaBrand = { name?: string; tokens?: { bg?: string; primary?: string } };

export function manifestFor(brand: PwaBrand): any {
  const name = String(brand?.name || 'Site').trim().slice(0, 45) || 'Site';
  const bg = isHex(brand?.tokens?.bg) ? String(brand!.tokens!.bg).trim() : '#ffffff';
  const primary = isHex(brand?.tokens?.primary) ? String(brand!.tokens!.primary).trim() : '#0b1220';
  return {
    name,
    short_name: (name.split(/\s+/).slice(0, 2).join(' ').slice(0, 12) || name.slice(0, 12)),
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: bg,
    theme_color: primary,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

// The offline shell. Cache name carries the project id + a version so an activate can sweep stale ones.
export function swSource(projectId: string): string {
  const c = `relay-${String(projectId).replace(/[^a-z0-9-]/gi, '')}-v1`;
  return `/* Relay offline shell — pages network-first (live CMS edits show), assets cache-first, /api/ never cached */
var C='${c}';
var SHELL=['./','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(C).then(function(c){return c.addAll(SHELL)}).then(function(){return self.skipWaiting()}))});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==C&&k.indexOf('relay-')===0}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}))});
self.addEventListener('fetch',function(e){
  var u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.indexOf('/api/')>=0)return;
  var page=u.pathname.slice(-5)==='.html'||u.pathname.slice(-1)==='/';
  if(page){
    e.respondWith(fetch(e.request).then(function(r){if(r&&r.ok){var cp=r.clone();caches.open(C).then(function(c){c.put(e.request,cp)})}return r}).catch(function(){return caches.match(e.request).then(function(h){return h||caches.match('./')})}));
  }else{
    e.respondWith(caches.match(e.request).then(function(hit){var net=fetch(e.request).then(function(r){if(r&&r.ok){var cp=r.clone();caches.open(C).then(function(c){c.put(e.request,cp)})}return r}).catch(function(){return hit});return hit||net}));
  }
});
`;
}

// The icon page the browser paints: brand initial centered on the brand primary, safe-zoned for
// maskable (glyph within the inner 80%). Pure HTML+CSS — screenshot at exactly 512/192 = the PNG.
export function iconHtml(brand: PwaBrand): string {
  const primary = isHex(brand?.tokens?.primary) ? String(brand!.tokens!.primary).trim() : '#0b1220';
  const glyph = onColor(primary);
  const initial = (String(brand?.name || 'S').trim().charAt(0) || 'S').toUpperCase();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%}
body{background:${primary};display:flex;align-items:center;justify-content:center}
span{color:${glyph};font:700 55vh system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1}
</style></head><body><span>${initial.replace(/[<>&]/g, '')}</span></body></html>`;
}

// Write the PWA assets for one produced site. Manifest + sw are rewritten idempotently on every
// render (cheap, deterministic); icons are painted once (browser work) and kept.
export async function ensurePwaAssets(dir: URL, brand: PwaBrand, projectId: string): Promise<void> {
  writeFileSync(fileURLToPath(new URL('manifest.webmanifest', dir)), JSON.stringify(manifestFor(brand), null, 1));
  writeFileSync(fileURLToPath(new URL('sw.js', dir)), swSource(projectId));
  const i192 = fileURLToPath(new URL('icon-192.png', dir));
  const i512 = fileURLToPath(new URL('icon-512.png', dir));
  if (existsSync(i192) && existsSync(i512)) return;
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(iconHtml(brand));
  writeFileSync(i512, await screenshot(url, { width: 512, height: 512 }));
  writeFileSync(i192, await screenshot(url, { width: 192, height: 192 }));
}

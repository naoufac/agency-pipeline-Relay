// pwa:check — THE INSTALLABILITY GATE. Every produced site must ship a complete, honest PWA:
// a valid manifest compiled from the locked brand, real painted brand icons (PNG, exact sizes),
// and an offline shell that can NEVER go stale on live data (pages network-first, /api/ untouched).
// Deterministic; the only browser work is the real icon paint (same warm browser as theme:check).
// Exit 1 on any failure. Run: npm run pwa:check.
import { mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { manifestFor, swSource, iconHtml, ensurePwaAssets } from './pwa.ts';
import { renderPage } from './render.ts';
import { closeBrowser } from './browser.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

// ---- manifest: complete, brand-rooted, defaults that can't leak emptiness ----
{
  const m = manifestFor({ name: 'Harbor Law', tokens: { bg: '#fbfaf7', primary: '#1c2a3a' } });
  ok('manifest: name from brand', m.name === 'Harbor Law');
  ok('manifest: short_name fits a home screen (<=12 chars)', typeof m.short_name === 'string' && m.short_name.length > 0 && m.short_name.length <= 12);
  ok('manifest: standalone display', m.display === 'standalone');
  ok('manifest: colours are the locked tokens', m.background_color === '#fbfaf7' && m.theme_color === '#1c2a3a');
  ok('manifest: relative start_url + scope (works under /sites/<id>/)', m.start_url === './' && m.scope === './');
  ok('manifest: 192 + 512 + maskable icons declared', Array.isArray(m.icons) && m.icons.length === 3 && m.icons.some((i: any) => i.purpose === 'maskable'));
  const g = manifestFor({} as any);
  ok('manifest: garbage brand → still complete (never empty)', !!g.name && !!g.short_name && /^#/.test(g.background_color) && /^#/.test(g.theme_color));
  ok("short_name keeps whole words that fit ('Sal's on Oak' → itself, 12 chars)", manifestFor({ name: "Sal's on Oak" }).short_name === "Sal's on Oak");
  ok('short_name never ends on a dangling stopword', manifestFor({ name: "Sal's on Oakwood Avenue" }).short_name === "Sal's");
  ok('long single word still truncates safely', manifestFor({ name: 'Extraordinarily' }).short_name.length <= 12);
}

// ---- service worker: parses, never touches /api/, pages are network-first ----
{
  const sw = swSource('0a211ce4-ec00-4e6a-b809-b97e577c1b50');
  try { new Function(sw); pass++; } catch (e: any) { fail++; console.error('  ✗ sw.js is invalid JS: ' + (e?.message ?? e)); }
  ok('sw: /api/ is never intercepted (live data stays live)', sw.includes("indexOf('/api/')") && sw.includes('return;') );
  ok('sw: pages are network-first (Content-tab edits show on next load)', /page=.*\.html/.test(sw) && sw.indexOf('fetch(e.request)') < sw.lastIndexOf('caches.match'));
  ok('sw: cache name carries the project id', sw.includes('relay-0a211ce4'));
  ok('sw: stale caches swept on activate', sw.includes('activate') && sw.includes('caches.delete'));
}

// ---- rendered pages carry the PWA head + a GUARDED registration ----
{
  const html = renderPage({ brand: { name: 'Harbor Law', tokens: { bg: '#fbfaf7', primary: '#1c2a3a' } }, sections: [
    { type: 'hero', headline: 'Guiding your family', lead: 'Counsel that answers.', cta: 'Book' },
    { type: 'features', items: [{ title: 'Estate', body: 'planning' }] },
  ] }, { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home', projectId: 'x', theme: 'editorial' });
  ok('page head links the manifest', html.includes('<link rel="manifest" href="manifest.webmanifest">'));
  ok('page head sets theme-color to the brand primary', html.includes('<meta name="theme-color" content="#1c2a3a">'));
  ok('page head carries apple-touch-icon', html.includes('apple-touch-icon'));
  ok('sw registration is protocol-guarded (file:// gates render without it)', html.includes("'serviceWorker' in navigator") && html.includes('location.protocol'));
  ok('no external asset introduced (relative refs only)', !/<link\b[^>]*href\s*=\s*["']?https?:/i.test(html));
}

// ---- the REAL icon paint: exact-size PNGs from the brand initial on the brand primary ----
{
  const dir = new URL('../sites/_pwacheck/', import.meta.url);
  rmSync(fileURLToPath(dir), { recursive: true, force: true });
  mkdirSync(fileURLToPath(dir), { recursive: true });
  ok('icon html centers the brand initial', iconHtml({ name: 'Harbor Law', tokens: { primary: '#1c2a3a' } }).includes('>H<'));
  await ensurePwaAssets(dir, { name: 'Harbor Law', tokens: { bg: '#fbfaf7', primary: '#1c2a3a' } }, '_pwacheck');
  const pngDims = (p: string) => { const b = readFileSync(p); return { sig: b.readUInt32BE(0) === 0x89504e47, w: b.readUInt32BE(16), h: b.readUInt32BE(20), size: b.length }; };
  for (const [f, want] of [['icon-192.png', 192], ['icon-512.png', 512]] as [string, number][]) {
    const p = fileURLToPath(new URL(f, dir));
    if (!existsSync(p)) { fail++; console.error(`  ✗ ${f} not painted`); continue; }
    const d = pngDims(p);
    ok(`${f}: real PNG at exactly ${want}x${want}`, d.sig && d.w === want && d.h === want, JSON.stringify(d));
    // a flat-colour glyph PNG compresses to ~700b at 192px — blank frames land near ~300b
    ok(`${f}: not a blank frame`, d.size > 500, `${d.size}b`);
  }
  ok('manifest.webmanifest written + valid JSON', (() => { try { const j = JSON.parse(readFileSync(fileURLToPath(new URL('manifest.webmanifest', dir)), 'utf8')); return j.display === 'standalone'; } catch { return false; } })());
  ok('sw.js written', existsSync(fileURLToPath(new URL('sw.js', dir))) && statSync(fileURLToPath(new URL('sw.js', dir))).size > 200);
  // idempotent: a second call must not repaint (icons keep their mtime) and must not throw
  const before = statSync(fileURLToPath(new URL('icon-512.png', dir))).mtimeMs;
  await ensurePwaAssets(dir, { name: 'Harbor Law', tokens: { bg: '#fbfaf7', primary: '#1c2a3a' } }, '_pwacheck');
  ok('icons painted once (second run skips the browser)', statSync(fileURLToPath(new URL('icon-512.png', dir))).mtimeMs === before);
}

console.log(`\npwa:check — ${pass} passed, ${fail} failed`);
await closeBrowser();
process.exit(fail ? 1 : 0);

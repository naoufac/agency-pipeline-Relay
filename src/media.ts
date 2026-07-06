// Real media: fill <img data-q="search terms"> placeholders the build agent emits with real
// licensed Pexels photos, downloaded into the site's assets/ dir and referenced LOCALLY — so they
// render in the file:// screenshot AND pass the gate's "no external asset" check. Existing photos
// only; never AI generation. No PEXELS_API_KEY -> no-op (img tags dropped, text-only site).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KEY = process.env.PEXELS_API_KEY;
const MAX_PER_PAGE = 8;

export function mediaReady(): boolean { return !!KEY; }

// Pexel photo metadata: the URL for each size variant + the intrinsic dimensions.
// We download both `medium` (fits within ~1200px) and `large` (fits within ~1900px) for srcset.
export interface PhotoMeta {
  query: string;          // the human search term (becomes alt text)
  local: string;          // relative path: 'assets/media-N.jpg'       (large, used as src)
  localMedium: string;    // relative path: 'assets/media-N-m.jpg'     (medium, used in srcset)
  width: number;          // intrinsic width in px (from Pexels, for the large variant)
  height: number;         // intrinsic height in px (from Pexels, for the large variant)
}

// PURE: given resolved PhotoMeta, emit the final <img> tag with width/height (CLS-proof), srcset/sizes,
// and the correct loading strategy. Unit-testable without a network call or a build.
// hero=true → LCP candidate: loading="eager" fetchpriority="high"; otherwise lazy.
export function buildImgTag(meta: PhotoMeta, hero = false, cls = ''): string {
  const loadAttr = hero
    ? 'loading="eager" fetchpriority="high"'
    : 'loading="lazy"';
  // sizes: hero images span the full viewport; others are typically 33vw on desktop (3-col grid)
  // with a 100vw fallback on mobile. Each caller can override via CSS — the sizes attr is a hint
  // for the browser's preloader, not a layout contract.
  const sizes = hero ? '100vw' : '(max-width:700px) 100vw, 33vw';
  const srcset = `${meta.local} ${meta.width}w, ${meta.localMedium} ${Math.round(meta.width * 0.63)}w`;
  return `<img src="${meta.local}" srcset="${srcset}" sizes="${sizes}" width="${meta.width}" height="${meta.height}" alt="${escAttr(meta.query)}"${cls ? ` class="${escAttr(cls)}"` : ''} ${loadAttr}>`;
}

// escAttr: escape text for an HTML attribute value (double quotes + angle brackets).
function escAttr(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
}

// pexelsSearch: call the Pexels search API and return the first result's metadata + size URLs.
// Returns null on any network/API error so the caller can degrade gracefully.
interface PexelsResult {
  largeUrl: string;
  mediumUrl: string;
  width: number;
  height: number;
}
async function pexelsSearch(query: string, portrait: boolean): Promise<PexelsResult | null> {
  if (!KEY) return null;
  const orientation = portrait ? 'portrait' : 'landscape';
  try {
    const r = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=${orientation}`,
      { headers: { Authorization: KEY } });
    if (!r.ok) return null;
    const d: any = await r.json();
    const ph = d.photos?.[0];
    if (!ph?.src) return null;
    return {
      largeUrl: ph.src.large2x || ph.src.large || ph.src.original || '',
      mediumUrl: ph.src.medium || ph.src.large || ph.src.original || '',
      width: ph.width || 1920,
      height: ph.height || 1080,
    };
  } catch { return null; }
}

// Fetch ONE real photo's bytes for a query (licensed Pexels, existing photos only). Shared by the
// static media pass and the DB-row enrichment (rowmedia.ts). Returns null on any miss.
export async function pexelsPhoto(query: string, portrait: boolean): Promise<Buffer | null> {
  const res = await pexelsSearch(query, portrait);
  if (!res) return null;
  try {
    const resp = await fetch(res.largeUrl); if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length >= 1000 ? buf : null;
  } catch { return null; }
}

// Swap every <img ... data-q="QUERY" ...> for a real local photo.
// New behaviour vs the old processMedia:
//   - Downloads BOTH large + medium variants (assets/media-N.jpg + assets/media-N-m.jpg)
//   - Emits buildImgTag(meta) for real width/height + srcset/sizes (CLS-proof)
//   - alt is set to the Pexels query (the human description)
//   - A hero image (loading="eager" fetchpriority="high" in the placeholder) keeps those attrs
// Returns rewritten html.
export async function processMedia(html: string, dirUrl: URL): Promise<string> {
  if (!KEY) return html.replace(/<img\b[^>]*\bdata-q\b[^>]*>/gi, '');  // no key -> drop placeholders
  const re = /<img\b[^>]*\bdata-q\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const tags = [...html.matchAll(re)];
  if (!tags.length) return html;
  const queries = [...new Set(tags.map(m => m[1].trim().toLowerCase()))].slice(0, MAX_PER_PAGE);
  const assets = new URL('assets/', dirUrl);
  mkdirSync(fileURLToPath(assets), { recursive: true });

  // Map query → PhotoMeta (local file paths + dimensions)
  const map = new Map<string, PhotoMeta>();
  let n = 0;
  for (const q of queries) {
    const portrait = /portrait|avatar|headshot|profile|person|founder|team member/.test(q);
    const res = await pexelsSearch(q, portrait);
    if (!res) continue;
    try {
      // Download LARGE variant (main src)
      const respLarge = await fetch(res.largeUrl); if (!respLarge.ok) continue;
      const bufLarge = Buffer.from(await respLarge.arrayBuffer());
      if (bufLarge.length < 1000) continue;
      const idx = ++n;
      const nameLarge = `media-${idx}.jpg`;
      writeFileSync(fileURLToPath(new URL(nameLarge, assets)), bufLarge);

      // Download MEDIUM variant (srcset smaller size)
      let nameMedium = nameLarge; // default: same file if medium fails
      try {
        if (res.mediumUrl !== res.largeUrl) {
          const respMedium = await fetch(res.mediumUrl); if (respMedium.ok) {
            const bufMedium = Buffer.from(await respMedium.arrayBuffer());
            if (bufMedium.length >= 1000) {
              nameMedium = `media-${idx}-m.jpg`;
              writeFileSync(fileURLToPath(new URL(nameMedium, assets)), bufMedium);
            }
          }
        }
      } catch { /* medium is optional — the large alone is still CLS-proof */ }

      map.set(q, {
        query: q,
        local: 'assets/' + nameLarge,
        localMedium: 'assets/' + nameMedium,
        width: res.width,
        height: res.height,
      });
    } catch { /* skip this image */ }
  }

  return html.replace(re, (tag, rawQ) => {
    const qKey = String(rawQ).trim().toLowerCase();
    const meta = map.get(qKey);
    if (!meta) return '';    // never ship a broken <img>

    // Detect if the original placeholder requested eager loading (hero image)
    const isHero = /loading\s*=\s*["']eager["']/i.test(tag);
    // Carry the original class attribute if present
    const classMatch = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
    const cls = classMatch ? classMatch[1] : '';

    return buildImgTag(meta, isHero, cls);
  });
}

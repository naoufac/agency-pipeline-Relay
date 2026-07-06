// figma.ts — the LIVE Figma connector for figma-to-reality. Fetch a Figma file by URL and turn its
// published COLOR + TEXT styles into the loose token shape designFromTokens() already consumes. The
// mapping (figmaFileToTokens) is a PURE function proven against a realistic file fixture — no network,
// no plan lock-in (works with a personal access token on any plan). The HTTP fetch is a thin wrapper
// that degrades cleanly when no token is configured. The owner pastes a file URL in the Design tab;
// the same /design endpoint applies the result, so everything downstream (contrast, fonts, gates) holds.

export function figmaKeyFromUrl(url: string): string | null {
  const m = String(url || '').match(/figma\.com\/(?:file|design)\/([A-Za-z0-9]{10,})/);
  return m ? m[1] : (/^[A-Za-z0-9]{10,}$/.test(String(url || '').trim()) ? String(url).trim() : null);
}

// Figma colours are {r,g,b,a} floats 0..1 → #rrggbb. A semi-transparent fill is COMPOSITED over white
// (never dropped-to-opaque, which would ship a wrong colour) so the token approximates how it reads on
// a light page. (audit 2026-07-06)
function rgbaToHex(c: any): string | null {
  if (!c || typeof c !== 'object') return null;
  const r = Number(c.r), g = Number(c.g), b = Number(c.b), a = (c.a == null ? 1 : Number(c.a));
  if (![r, g, b, a].every(Number.isFinite)) return null;
  const comp = (ch: number) => Math.max(0, Math.min(255, Math.round((ch * a + (1 - a)) * 255))).toString(16).padStart(2, '0');
  return `#${comp(r)}${comp(g)}${comp(b)}`;
}

// classify a Figma style NAME (often "Brand/Primary", "Text/Body") into a canonical token key that
// designFromTokens matches exactly — figma owns the messy-name → canonical mapping.
function colorKeyOf(name: string): string | null {
  // classify on the LEAF segment — a Figma style is named "Category/Token" and the token is what
  // matters ("Text/Background" is a background, not text). (audit 2026-07-06)
  const n = (String(name || '').split('/').pop() || '').toLowerCase();
  if (/(back|bg|canvas|base|paper)/.test(n)) return 'background';
  if (/(primary|brand|main|action|\bcta\b)/.test(n)) return 'primary';
  if (/(accent|secondary|highlight)/.test(n)) return 'accent';
  if (/(surface|card|panel|elevated)/.test(n)) return 'surface';
  if (/(text|ink|body|foreground|content|neutral)/.test(n)) return 'text';
  return null;
}

// walk the whole node tree once, calling fn on every node
function walk(node: any, fn: (n: any) => void): void {
  if (!node || typeof node !== 'object') return;
  fn(node);
  if (Array.isArray(node.children)) for (const c of node.children) walk(c, fn);
}

// a Figma /v1/files/:key response → { colors, typography, radius } for designFromTokens.
export function figmaFileToTokens(file: any): { colors: Record<string, string>; typography: Record<string, any>; radius?: string } {
  const styles = (file && file.styles && typeof file.styles === 'object') ? file.styles : {};
  const nameOf = (id: string) => (styles[id] && styles[id].name) || '';
  const typeOf = (id: string) => (styles[id] && styles[id].styleType) || '';

  // per-STYLE colour tallies: a published style has one colour, but a single instance can override it —
  // take the MODE across all nodes binding the style, not the first one hit. (audit 2026-07-06)
  const fillTally: Record<string, Record<string, number>> = {};
  const texts: Array<{ name: string; family: string; size: number }> = [];
  const radii: number[] = [];

  walk(file && file.document, (n) => {
    const fillStyleId = n.styles && (n.styles.fill || n.styles.fills);
    if (fillStyleId && typeOf(fillStyleId) === 'FILL' && Array.isArray(n.fills)) {
      const solid = n.fills.find((f: any) => f && f.type === 'SOLID' && f.visible !== false && f.color);
      const hex = solid ? rgbaToHex(solid.color) : null;
      if (hex) { (fillTally[fillStyleId] ||= {})[hex] = (fillTally[fillStyleId][hex] || 0) + 1; }
    }
    const textStyleId = n.styles && n.styles.text;
    if (textStyleId && typeOf(textStyleId) === 'TEXT' && n.style && n.style.fontFamily) {
      texts.push({ name: nameOf(textStyleId), family: String(n.style.fontFamily), size: Number(n.style.fontSize) || 0 });
    }
    if (Number.isFinite(Number(n.cornerRadius)) && Number(n.cornerRadius) > 0) radii.push(Number(n.cornerRadius));
  });

  const mode = (t: Record<string, number>) => Object.entries(t).sort((a, b) => b[1] - a[1])[0]?.[0];
  const colorByKey: Record<string, string> = {};
  for (const [styleId, tally] of Object.entries(fillTally)) {
    const key = colorKeyOf(nameOf(styleId)); const hex = mode(tally);
    if (key && hex && !colorByKey[key]) colorByKey[key] = hex;
  }

  // typography: among heading-NAMED styles pick the LARGEST (a tiny 'Heading/Caption' must not beat a
  // 48px 'Display'); fall back to the largest overall. Body = body-named, else the commonest family.
  const typography: Record<string, any> = {};
  const bySize = (a: { size: number }, b: { size: number }) => b.size - a.size;
  const named = texts.filter((t) => /(head|display|title|\bh1\b|hero)/i.test((t.name.split('/').pop() || '')));
  const heading = (named.length ? named : texts).slice().sort(bySize)[0];
  const bodyName = texts.find((t) => /(body|paragraph|text|base|content)/i.test((t.name.split('/').pop() || '')));
  const commonest = (() => {
    const c: Record<string, number> = {}; for (const t of texts) c[t.family] = (c[t.family] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
  })();
  if (heading?.family) typography.heading = { fontFamily: heading.family };
  const bodyFam = bodyName?.family || commonest;
  if (bodyFam) typography.body = { fontFamily: bodyFam };

  // radius: the most common non-zero corner radius, in px
  const radius = radii.length ? `${(() => { const c: Record<number, number> = {}; for (const r of radii) c[r] = (c[r] || 0) + 1; return Number(Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]); })()}px` : undefined;

  return { colors: colorByKey, typography, ...(radius ? { radius } : {}) };
}

// thin HTTP wrapper — degrades cleanly with no token. Returns the parsed file JSON or throws a
// caller-friendly error. Timeout-bounded.
export async function figmaFetchFile(fileKey: string, token: string, timeoutMs = 20_000): Promise<any> {
  if (!token) throw new Error('figma-not-connected');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}?geometry=paths`, {
      headers: { 'X-Figma-Token': token }, signal: ctrl.signal,
    });
    if (res.status === 403 || res.status === 401) throw new Error('figma-unauthorized');
    if (res.status === 404) throw new Error('figma-file-not-found');
    if (!res.ok) throw new Error('figma-error-' + res.status);
    // BOUNDED read: a Figma file can be tens of MB — res.json() would buffer it all (OOM risk). Cap the
    // body at 12MB (huge for styles metadata) via the stream, aborting past the limit. (audit 2026-07-06)
    const MAX = 12 * 1024 * 1024;
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > MAX) throw new Error('figma-too-large');
    const reader = (res.body as any)?.getReader?.();
    if (!reader) return await res.json();
    const chunks: Uint8Array[] = []; let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('figma-too-large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(t); }
}

// URL → Design tokens, end to end (fetch + map). The endpoint hands the result to designFromTokens.
export async function figmaUrlToTokens(url: string, token: string): Promise<{ colors: Record<string, string>; typography: Record<string, any>; radius?: string }> {
  const key = figmaKeyFromUrl(url);
  if (!key) throw new Error('figma-bad-url');
  const file = await figmaFetchFile(key, token);
  return figmaFileToTokens(file);
}

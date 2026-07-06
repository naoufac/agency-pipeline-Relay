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

// Figma colours are {r,g,b,a} floats 0..1 → #rrggbb
function rgbaToHex(c: any): string | null {
  if (!c || typeof c !== 'object') return null;
  const to = (v: any) => Math.max(0, Math.min(255, Math.round(Number(v) * 255))).toString(16).padStart(2, '0');
  if (!Number.isFinite(Number(c.r)) || !Number.isFinite(Number(c.g)) || !Number.isFinite(Number(c.b))) return null;
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

// classify a Figma style NAME (often "Brand/Primary", "Text/Body") into a canonical token key that
// designFromTokens matches exactly — figma owns the messy-name → canonical mapping.
function colorKeyOf(name: string): string | null {
  const n = String(name || '').toLowerCase();
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

  const colorByKey: Record<string, string> = {};
  const texts: Array<{ name: string; family: string; size: number }> = [];
  const radii: number[] = [];

  walk(file && file.document, (n) => {
    // a bound FILL style + a solid fill → a named colour
    const fillStyleId = n.styles && (n.styles.fill || n.styles.fills);
    if (fillStyleId && typeOf(fillStyleId) === 'FILL' && Array.isArray(n.fills)) {
      const solid = n.fills.find((f: any) => f && f.type === 'SOLID' && f.visible !== false && f.color);
      const hex = solid ? rgbaToHex(solid.color) : null;
      const key = colorKeyOf(nameOf(fillStyleId));
      if (hex && key && !colorByKey[key]) colorByKey[key] = hex;
    }
    // a bound TEXT style + a font family → a named typeface (keep size to pick display vs body)
    const textStyleId = n.styles && n.styles.text;
    if (textStyleId && typeOf(textStyleId) === 'TEXT' && n.style && n.style.fontFamily) {
      texts.push({ name: nameOf(textStyleId), family: String(n.style.fontFamily), size: Number(n.style.fontSize) || 0 });
    }
    if (Number.isFinite(Number(n.cornerRadius)) && Number(n.cornerRadius) > 0) radii.push(Number(n.cornerRadius));
  });

  // typography: a text style named like a heading (or the largest) → display; body-named (or commonest) → body
  const typography: Record<string, any> = {};
  const heading = texts.find((t) => /(head|display|title|\bh1\b|hero)/i.test(t.name)) || texts.slice().sort((a, b) => b.size - a.size)[0];
  const bodyName = texts.find((t) => /(body|paragraph|text|base|content)/i.test(t.name));
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
    return await res.json();
  } finally { clearTimeout(t); }
}

// URL → Design tokens, end to end (fetch + map). The endpoint hands the result to designFromTokens.
export async function figmaUrlToTokens(url: string, token: string): Promise<{ colors: Record<string, string>; typography: Record<string, any>; radius?: string }> {
  const key = figmaKeyFromUrl(url);
  if (!key) throw new Error('figma-bad-url');
  const file = await figmaFetchFile(key, token);
  return figmaFileToTokens(file);
}

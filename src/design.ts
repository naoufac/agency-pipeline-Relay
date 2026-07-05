// design.ts — FIGMA → REALITY. A produced site's visual identity can come from an EXTERNAL design
// source (a Figma file's exported variables, a Tokens-Studio export, or a Canva brand kit — all the
// same token shape) instead of the brief-derived theme. This is the ingestion SEAM: tokens in, a
// Design object out, honored by the renderer over the theme. The live Figma/Canva connector fills the
// same Design object; everything downstream (and every gate) works on the object, not the API.
//
// Deliberately NOT a pixel-for-pixel layout importer: Relay composes from verified sections (hero,
// collection, form, receipt…) so every produced page stays accessible, responsive, wired to the real
// DB, and gate-clean. What a design source DOES drive here is IDENTITY — palette, typography, shape —
// which is where "generic AI slop vs a real brand" is won.

export type Design = {
  palette?: { bg?: string; primary?: string; accent?: string; text?: string; surface?: string };
  fonts?: { display?: string; body?: string };
  radius?: string;
  source?: 'figma' | 'canva' | 'tokens' | 'manual';
};

const HEX = /^#[0-9a-f]{3,8}$/i;
// a font family we will put into a Google Fonts URL + a CSS var: letters, digits, spaces only (no
// quotes, no CSS/HTML/URL metacharacters — the family name is attacker-adjacent if it ever comes from
// an uploaded token file). Rejected names fall back to the theme font.
const SAFE_FONT = /^[A-Za-z0-9][A-Za-z0-9 ]{0,40}$/;
export const safeFont = (v: any): string | undefined => {
  const s = String(v ?? '').replace(/['"]/g, '').trim();
  return SAFE_FONT.test(s) ? s : undefined;
};
const hex = (v: any): string | undefined => (HEX.test(String(v ?? '').trim()) ? String(v).trim() : undefined);

// pull a leaf value out of the common token shapes: a raw string, or W3C `{ $value }`, or Figma
// variable `{ value }`, or `{ resolvedValue }` — tolerate all so one adapter serves Figma variables,
// Tokens Studio and Canva exports.
function leaf(v: any): any {
  if (v == null) return undefined;
  if (typeof v === 'string' || typeof v === 'number') return v;
  // typography tokens carry the family under fontFamily/family; colors under $value/value/hex
  if (typeof v === 'object') return v.$value ?? v.value ?? v.resolvedValue ?? v.hex ?? v.fontFamily ?? v.family ?? undefined;
  return undefined;
}
// find the first key in `obj` whose name matches `re`, return its leaf value
function pick(obj: any, re: RegExp): any {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of Object.keys(obj)) if (re.test(k)) { const lv = leaf(obj[k]); if (lv != null) return lv; }
  return undefined;
}

// TOKENS → DESIGN. Accepts a loose object (Figma variables export / Tokens Studio / Canva brand /
// a flat {colors,typography,radius}). Never throws; returns only the fields it could confidently map.
export function designFromTokens(raw: any, source: Design['source'] = 'figma'): Design {
  const t = (raw && typeof raw === 'object') ? raw : {};
  const colors = t.colors || t.color || t.palette || t.Colors || t;
  const type = t.typography || t.type || t.fonts || t.text || t.Typography || {};
  const design: Design = { source };

  const palette: NonNullable<Design['palette']> = {};
  const bg = hex(pick(colors, /^(bg|background|surface_?0|base|paper|canvas)$/i));
  const primary = hex(pick(colors, /^(primary|brand|main|accent_?1|action)$/i));
  const accent = hex(pick(colors, /^(accent|secondary|highlight|accent_?2)$/i));
  const text = hex(pick(colors, /^(text|ink|foreground|fg|body|neutral_?900|on_?background)$/i));
  const surface = hex(pick(colors, /^(surface|card|panel|elevated|surface_?1|muted_?bg)$/i));
  if (bg) palette.bg = bg;
  if (primary) palette.primary = primary;
  if (accent) palette.accent = accent;
  if (text) palette.text = text;
  if (surface) palette.surface = surface;
  if (Object.keys(palette).length) design.palette = palette;

  const display = safeFont(pick(type, /^(display|heading|headline|title|h1|primary)$/i) ?? (type as any).fontFamily ?? leaf(type));
  const body = safeFont(pick(type, /^(body|paragraph|text|base|content|secondary)$/i) ?? (type as any).fontFamily);
  if (display || body) design.fonts = { ...(display ? { display } : {}), ...(body ? { body } : {}) };

  const rad = leaf(t.radius ?? t.borderRadius ?? t.cornerRadius ?? pick(t, /(radius|corner)/i));
  if (rad != null) {
    const n = typeof rad === 'number' ? rad : parseFloat(String(rad));
    if (Number.isFinite(n) && n >= 0 && n <= 64) design.radius = /px|rem|em|%/.test(String(rad)) ? String(rad).trim() : `${n}px`;
  }
  return design;
}

// the Google Fonts <link> for a design's fonts (weights that cover display + body). Returns '' when
// there are no web fonts to load (system-font themes stay link-free, byte-identical to today).
export function fontLink(design: Design | undefined | null): string {
  const fams = [design?.fonts?.display, design?.fonts?.body].map(safeFont).filter((v, i, a) => v && a.indexOf(v) === i) as string[];
  if (!fams.length) return '';
  const q = fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700`).join('&');
  // referrerpolicy=no-referrer: don't leak the visitor's page URL to Google on the font request.
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" referrerpolicy="no-referrer" href="https://fonts.googleapis.com/css2?${q}&display=swap">`;
}

// the design tokens that DON'T affect legibility — fonts + radius. The PALETTE is folded into the
// renderer's contrast-guaranteed derivation instead (see render.ts), so it is NOT emitted here.
export function designTypeVars(design: Design | undefined | null): string {
  if (!design) return '';
  const out: string[] = [];
  if (safeFont(design.fonts?.display)) out.push(`--font-display:'${safeFont(design.fonts!.display)}'`);
  if (safeFont(design.fonts?.body)) out.push(`--font-body:'${safeFont(design.fonts!.body)}'`);
  if (design.radius && /^[0-9.]+(px|rem|em|%)$/.test(design.radius)) out.push(`--radius:${design.radius}`);
  return out.join(';');
}

// the CSS-var overrides a Design contributes (only the tokens it actually carries). Empty string when
// the design is absent/empty — the renderer then uses the theme, unchanged.
export function designVars(design: Design | undefined | null): string {
  if (!design) return '';
  const out: string[] = [];
  const p = design.palette || {};
  if (hex(p.primary)) out.push(`--primary:${p.primary}`);
  if (hex(p.bg)) out.push(`--bg:${p.bg}`);
  if (hex(p.accent)) out.push(`--accent:${p.accent}`);
  if (hex(p.text)) out.push(`--text:${p.text}`);
  if (hex(p.surface)) out.push(`--surface:${p.surface}`);
  if (safeFont(design.fonts?.display)) out.push(`--font-display:'${safeFont(design.fonts!.display)}'`);
  if (safeFont(design.fonts?.body)) out.push(`--font-body:'${safeFont(design.fonts!.body)}'`);
  if (design.radius && /^[0-9.]+(px|rem|em|%)$/.test(design.radius)) out.push(`--radius:${design.radius}`);
  return out.join(';');
}

// is a Design worth applying (carries at least one real token)?
export function hasDesign(design: Design | undefined | null): boolean {
  return !!design && (!!(design.palette && Object.keys(design.palette).length) || !!design.fonts || !!design.radius);
}

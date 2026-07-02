// layout.ts — the LAYOUT dimension (PQ1: distinct design per brief). Theme owns tokens (font, colour,
// spacing, shape); LAYOUT owns STRUCTURE — the hero treatment, the nav style, the section rhythm — so
// two businesses are not the same page recolored. Deterministic + brief-rooted + closed set, exactly
// like themes.ts/archetype.ts: chosen ONCE per project (consistent across every page), reproducible
// from the brief, and every variant is hand-built + WCAG-safe by construction. The LLM never picks it.
import type { ThemeName } from './themes.ts';
import type { Archetype } from './archetype.ts';

// hero: how the opening reads. image = full-bleed photo + overlay; split = text beside a framed photo;
// center = centered type, no photo (bold statement); editorial = oversized headline over a wide photo.
export type HeroVariant = 'image' | 'split' | 'center' | 'editorial';
// nav: standard = brand left / links right; centered = brand centered above links.
export type NavVariant = 'standard' | 'centered';
export interface Layout { hero: HeroVariant; nav: NavVariant; band: boolean; }

export const HERO_VARIANTS: HeroVariant[] = ['image', 'split', 'center', 'editorial'];

// FNV-1a — stable, dependency-free. Same brief → same layout, forever.
function hash(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

// Each theme gets a candidate hero list (best-fit first); the brief hash rotates within it, so two
// sites on the SAME theme still open differently, while every choice remains on-brief.
const HERO_BY_THEME: Record<ThemeName, HeroVariant[]> = {
  editorial: ['editorial', 'center', 'split'],
  modern:    ['split', 'image', 'center'],
  warm:      ['image', 'split', 'editorial'],
  bold:      ['center', 'image', 'editorial'],
  minimal:   ['center', 'editorial', 'split'],
};

export function chooseLayout(theme: ThemeName, archetype: Archetype, brief: string): Layout {
  const h = hash(String(brief || ''));
  const candidates = HERO_BY_THEME[theme] || HERO_VARIANTS;
  let hero = candidates[h % candidates.length];
  // a store/app leads with product/app imagery — never a photo-less centered hero for a catalog.
  if ((archetype === 'store' || archetype === 'app') && hero === 'center') hero = 'split';
  const nav: NavVariant = (theme === 'editorial' || theme === 'minimal') && (h & 1) ? 'centered' : 'standard';
  const band = ((h >> 3) & 1) === 1;   // alternate-surface section rhythm on ~half of sites
  return { hero, nav, band };
}

export function isHeroVariant(x: any): x is HeroVariant { return typeof x === 'string' && (HERO_VARIANTS as string[]).includes(x); }
export const DEFAULT_LAYOUT: Layout = { hero: 'image', nav: 'standard', band: false };

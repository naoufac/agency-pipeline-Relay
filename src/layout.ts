// layout.ts — the LAYOUT dimension (PQ1: distinct design per brief). Theme owns tokens (font, colour,
// spacing, shape); LAYOUT owns STRUCTURE — the hero treatment, the nav style, the section rhythm — so
// two businesses are not the same page recolored. Deterministic + brief-rooted + closed set, exactly
// like themes.ts/archetype.ts: chosen ONCE per project (consistent across every page), reproducible
// from the brief, and every variant is hand-built + WCAG-safe by construction. The LLM never picks it.
import type { ThemeName } from './themes.ts';
import type { Archetype } from './archetype.ts';

// hero: how the opening reads. image = full-bleed photo + overlay; split = text beside a framed photo;
// center = centered type, no photo (bold statement); editorial = oversized headline over a wide photo.
// poster = full-bleed photo, headline pinned bottom-left on a gradient scrim, oversized display type.
// ledger = no photo: thin top rule, eyebrow, massive left-aligned headline, lead in narrow right column.
export type HeroVariant = 'image' | 'split' | 'center' | 'editorial' | 'poster' | 'ledger';
// nav: standard = brand left / links right; centered = brand centered above links.
export type NavVariant = 'standard' | 'centered';
// cards: how the card wall reads. photo = current top-image stack; horizontal = image-beside-text;
// overlay = full-bleed image with bottom-pinned text on a dark scrim.
// minimal = borderless, no photo, numbered 01/02/03 eyebrows, hairline dividers.
export type CardVariant = 'photo' | 'horizontal' | 'overlay' | 'minimal';

// SECTION MODES — each major section type has two render modes chosen independently from the hero
// (a second FNV seed on brief + section type, so a site's section rhythm varies independently of
// its hero). Old Layout objects without sectionModes still render: missing fields fall back to the
// classic default (the first mode), so no produced site ever breaks on a schema addition.
export type FeaturesMode    = 'grid' | 'rail';        // rail = horizontal scroll-snap on mobile, 3-across desktop
export type TestimonialsMode = 'grid' | 'spotlight';  // spotlight = one large quote + attributions row
export type StatsMode       = 'row' | 'inline';       // inline = stats woven into a sentence band
export interface SectionModes { features: FeaturesMode; testimonials: TestimonialsMode; stats: StatsMode; }

// Layout is intentionally forward-extensible: any field absent in an old saved params.layout object
// is treated as the default — old sites render identically, new sites gain the new dimensions.
export interface Layout { hero: HeroVariant; nav: NavVariant; band: boolean; cards?: CardVariant; sectionModes?: SectionModes; }

export const HERO_VARIANTS: HeroVariant[] = ['image', 'split', 'center', 'editorial', 'poster', 'ledger'];
export const CARD_VARIANTS: CardVariant[] = ['photo', 'horizontal', 'overlay', 'minimal'];

// FNV-1a — stable, dependency-free. Same brief → same layout, forever.
function hash(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

// Each theme gets a candidate hero list (best-fit first); the brief hash rotates within it, so two
// sites on the SAME theme still open differently, while every choice remains on-brief.
// poster: bold imagery, strong statement — suits bold/warm/modern themes.
// ledger: no-photo editorial / legal look — suits editorial/minimal themes only.
const HERO_BY_THEME: Record<ThemeName, HeroVariant[]> = {
  editorial: ['editorial', 'ledger', 'center', 'split'],
  modern:    ['split', 'image', 'center', 'poster'],
  warm:      ['image', 'split', 'poster', 'editorial'],
  bold:      ['poster', 'center', 'image', 'editorial'],
  minimal:   ['ledger', 'center', 'editorial', 'split'],
};

// Different bit-shift from hero (h >> 5 vs h % candidates.length) so cards and hero don't correlate.
// minimal card: suited to editorial/minimal themes (borderless, no photo, numbered).
const CARDS_BY_THEME: Record<ThemeName, CardVariant[]> = {
  editorial: ['minimal', 'horizontal', 'overlay', 'photo'],
  modern:    ['photo', 'overlay', 'horizontal'],
  warm:      ['photo', 'horizontal', 'overlay'],
  bold:      ['overlay', 'photo', 'horizontal'],
  minimal:   ['minimal', 'horizontal', 'photo'],
};

// Second FNV seed for section-mode selection: same brief + section type → same mode, but uncorrelated
// with the hero hash (different FNV IV so bits don't align with the hero/card selectors).
function hashSection(brief: string, sectionType: string): number {
  // XOR a different IV to get a fully independent hash family per section type.
  let h = 0x6b173f9c;
  const s = brief + '\0' + sectionType;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function chooseLayout(theme: ThemeName, archetype: Archetype, brief: string): Layout {
  const h = hash(String(brief || ''));
  const candidates = HERO_BY_THEME[theme] || HERO_VARIANTS;
  let hero = candidates[h % candidates.length];
  // a store/app leads with product/app imagery — never a photo-less hero for a catalog.
  // PQ1: demote to the theme's own next photo-led candidate, NOT a hard 'split' (the hard demotion
  // funneled every modern-theme store/app into the same split hero — the panel's 7.3/10 sameness).
  // ledger and center are both photo-less; poster/image/split/editorial all carry imagery.
  if ((archetype === 'store' || archetype === 'app') && (hero === 'center' || hero === 'ledger'))
    hero = candidates.find(v => v !== 'center' && v !== 'ledger') || 'image';
  // centered nav reads right on editorial/minimal/warm; the hash keeps it ~half of those.
  const nav: NavVariant = (theme === 'editorial' || theme === 'minimal' || theme === 'warm') && (h & 1) ? 'centered' : 'standard';
  const band = ((h >> 3) & 1) === 1;   // alternate-surface section rhythm on ~half of sites
  const cardCandidates = CARDS_BY_THEME[theme] || CARD_VARIANTS;
  const cards: CardVariant = cardCandidates[(h >> 5) % cardCandidates.length];
  // Section modes: each section type picks its mode independently of the hero (different hash seed).
  // This is the real "few patterns" fix — section bodies all looked identical before.
  const b = String(brief || '');
  const sectionModes: SectionModes = {
    features:     (hashSection(b, 'features')     & 1) ? 'rail'      : 'grid',
    testimonials: (hashSection(b, 'testimonials') & 1) ? 'spotlight' : 'grid',
    stats:        (hashSection(b, 'stats')        & 1) ? 'inline'    : 'row',
  };
  return { hero, nav, band, cards, sectionModes };
}

export function isHeroVariant(x: any): x is HeroVariant { return typeof x === 'string' && (HERO_VARIANTS as string[]).includes(x); }
export function isCardVariant(x: any): x is CardVariant { return typeof x === 'string' && (CARD_VARIANTS as string[]).includes(x); }
export const DEFAULT_LAYOUT: Layout = { hero: 'image', nav: 'standard', band: false, cards: 'photo' };

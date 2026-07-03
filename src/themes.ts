// DESIGN LANGUAGES ("themes") — the rootedness layer.
// A brief is classified into ONE archetype; the renderer expands that archetype into a full
// type / rhythm / shape system so a law firm reads like a law firm and a bakery like a bakery —
// not the same template wearing different colours.
//
// Zero-trust intact: this is STRUCTURE, so it is composed, not authored. The LLM may at most NAME an
// archetype (validated against this closed set, with a deterministic brief-derived fallback). It never
// writes CSS. The renderer still derives the WCAG-safe palette from bg+primary; a theme only changes
// typography, spacing rhythm, shape and photo ART-DIRECTION (grade/tint/crop — the image-hero overlay
// keeps its fixed dark floor, so no treatment can break contrast).

export type ThemeName = 'editorial' | 'modern' | 'warm' | 'bold' | 'minimal';
export const THEME_NAMES: ThemeName[] = ['editorial', 'modern', 'warm', 'bold', 'minimal'];
export const DEFAULT_THEME: ThemeName = 'modern';

type Theme = {
  fontDisplay: 'Grotesk' | 'Inter' | 'Fraunces';
  fontBody: 'Inter' | 'Grotesk';
  vars: Record<string, string>; // CSS custom-property overrides (DS_CSS carries the defaults)
  tone: string;                 // copy-tone hint for the build agent — NOT visual authority
};

// Each theme is a coherent, deliberate set of choices. The visible levers that make sites feel like
// different studios made them: typeface pairing, type scale, whitespace rhythm, corner shape, border
// weight, button shape, hero alignment (via the body class, see components.ts).
const T: Record<ThemeName, Theme> = {
  // Law / consulting / finance / architecture / luxury — big serif, hairline rules, generous air.
  editorial: {
    fontDisplay: 'Fraunces', fontBody: 'Inter',
    vars: {
      '--h1': 'clamp(2.7rem,6.5vw,5rem)', '--h2': 'clamp(1.9rem,4.2vw,3rem)', '--h3': '1.3rem',
      '--display-weight': '420', '--display-tracking': '-.012em', '--display-leading': '1.05',
      '--body-size': '1.06rem', '--body-leading': '1.7',
      '--section-y': 'clamp(64px,9vw,130px)', '--radius': '4px', '--btn-radius': '0',
      '--btn-border': '1px solid currentColor',
      '--border-w': '1px', '--container': '1080px',
      '--eyebrow-transform': 'uppercase', '--eyebrow-tracking': '.16em', '--eyebrow-weight': '600',
      // art-direction · gravure: desaturated, ink-tinted, sharp gallery frames, portrait crops
      '--photo-filter': 'saturate(.58) contrast(1.06)', '--photo-tint': '.12', '--photo-tint-blend': 'multiply',
      '--photo-radius': '0px', '--crop-hero-split': '4/5', '--crop-hero-wide': '21/9', '--crop-split': '4/5',
      '--hero-tint-mix': '20%',
    },
    tone: 'measured, authoritative, refined — full sentences, zero hype',
  },
  // SaaS / product / tech — the confident default: geometric sans, pill button, no border.
  modern: {
    fontDisplay: 'Grotesk', fontBody: 'Inter',
    vars: {
      '--h1': 'clamp(2.3rem,6vw,4.2rem)', '--h2': 'clamp(1.7rem,4vw,2.7rem)', '--h3': '1.25rem',
      '--display-weight': '700', '--display-tracking': '-.02em', '--display-leading': '1.08',
      '--body-size': '1rem', '--body-leading': '1.6',
      '--section-y': 'clamp(52px,8vw,108px)', '--radius': '14px', '--btn-radius': '999px',
      '--border-w': '1px', '--container': '1140px',
      '--eyebrow-transform': 'uppercase', '--eyebrow-tracking': '.1em', '--eyebrow-weight': '700',
      // art-direction · clean: true colour, crisp, softly rounded, wide product-led crops
      '--photo-filter': 'saturate(1.05) contrast(1.04)', '--photo-tint': '.08', '--photo-tint-blend': 'multiply',
      '--photo-radius': '16px', '--crop-hero-split': '16/11', '--crop-hero-wide': '2.2/1', '--crop-split': '3/2',
      '--hero-tint-mix': '28%',
    },
    tone: 'crisp, confident, product-led — short, concrete lines',
  },
  // Bakery / cafe / wellness / craft — soft serif, soft-rectangle button (not pill), cosy spacing.
  warm: {
    fontDisplay: 'Fraunces', fontBody: 'Inter',
    vars: {
      '--h1': 'clamp(2.2rem,5.6vw,3.9rem)', '--h2': 'clamp(1.7rem,4vw,2.6rem)', '--h3': '1.25rem',
      '--display-weight': '500', '--display-tracking': '-.004em', '--display-leading': '1.12',
      '--body-size': '1.04rem', '--body-leading': '1.72',
      '--section-y': 'clamp(56px,8vw,104px)', '--radius': '22px', '--btn-radius': '10px',
      '--border-w': '1px', '--container': '1120px',
      '--eyebrow-transform': 'none', '--eyebrow-tracking': '.02em', '--eyebrow-weight': '600',
      // art-direction · golden: sun-warmed grade, soft-light brand cast, generous corners, cosy crops
      '--photo-filter': 'sepia(.16) saturate(1.14) brightness(1.03)', '--photo-tint': '.22', '--photo-tint-blend': 'soft-light',
      '--photo-radius': '26px', '--crop-hero-split': '5/4', '--crop-hero-wide': '16/7', '--crop-split': '4/3',
      '--hero-tint-mix': '34%',
    },
    tone: 'warm, inviting, human — sensory and welcoming',
  },
  // Agency / fitness / events / fashion — oversized type, tight tracking, pill buttons, heavy weight.
  bold: {
    fontDisplay: 'Grotesk', fontBody: 'Inter',
    vars: {
      '--h1': 'clamp(2.9rem,8.5vw,6rem)', '--h2': 'clamp(2rem,5vw,3.4rem)', '--h3': '1.35rem',
      '--display-weight': '700', '--display-tracking': '-.035em', '--display-leading': '.98',
      '--body-size': '1.05rem', '--body-leading': '1.6',
      '--section-y': 'clamp(60px,9vw,124px)', '--radius': '4px', '--btn-radius': '999px',
      '--btn-weight': '800',
      '--border-w': '2px', '--container': '1180px',
      '--eyebrow-transform': 'uppercase', '--eyebrow-tracking': '.14em', '--eyebrow-weight': '700',
      // art-direction · punch: deep blacks, saturated, hard edges, cinematic + square crops
      '--photo-filter': 'contrast(1.16) saturate(1.2)', '--photo-tint': '.16', '--photo-tint-blend': 'multiply',
      '--photo-radius': '0px', '--crop-hero-split': '4/5', '--crop-hero-wide': '2.4/1', '--crop-split': '1/1',
      '--hero-tint-mix': '44%',
    },
    tone: 'punchy, high-energy, declarative — short, bold statements',
  },
  // Portfolio / photography / design studio — single typeface, small scale, maximum air, ghost button.
  minimal: {
    fontDisplay: 'Inter', fontBody: 'Inter',
    vars: {
      '--h1': 'clamp(2rem,5vw,3.3rem)', '--h2': 'clamp(1.5rem,3.4vw,2.2rem)', '--h3': '1.15rem',
      '--display-weight': '600', '--display-tracking': '-.02em', '--display-leading': '1.1',
      '--body-size': '1rem', '--body-leading': '1.7',
      '--section-y': 'clamp(72px,10vw,150px)', '--radius': '6px', '--btn-radius': '6px',
      '--btn-bg': 'transparent', '--btn-color': 'var(--primary)',
      '--btn-border': '1.5px solid var(--primary)',
      '--btn-hover-bg': 'var(--primary)', '--btn-hover-color': 'var(--on-primary)',
      '--border-w': '1px', '--container': '1000px',
      '--eyebrow-transform': 'uppercase', '--eyebrow-tracking': '.18em', '--eyebrow-weight': '500',
      // art-direction · mono: full grayscale, no tint, near-sharp corners, portrait crops
      '--photo-filter': 'grayscale(1) contrast(1.05)', '--photo-tint': '0', '--photo-tint-blend': 'multiply',
      '--photo-radius': '2px', '--crop-hero-split': '4/5', '--crop-hero-wide': '3/1', '--crop-split': '4/5',
      '--hero-tint-mix': '0%',
    },
    tone: 'spare, calm, understated — few words, lots of restraint',
  },
};

// BRAND PALETTES — the distinctness axis. The LLM's invented palettes CLUSTER (a law firm and a
// skate shop drew near-identical greens the same day — the agency panel's finding). Identity is
// STRUCTURE, so it is composed: each theme owns a hand-built pool (every pair bg+primary passes the
// renderer's WCAG derivation); the brief hash rotates within it, and a colour word in the brief
// ("a sage green spa") nudges to the nearest pool hue. Deterministic: same brief → same palette.
export type BrandPalette = { bg: string; primary: string };
const BRAND_POOLS: Record<ThemeName, BrandPalette[]> = {
  editorial: [
    { bg: '#fbfaf7', primary: '#1c2a3a' },   // ink navy on cream
    { bg: '#faf7f2', primary: '#5a2328' },   // oxblood on ivory
    { bg: '#f7f6f3', primary: '#233329' },   // deep forest on stone
    { bg: '#fbfaf7', primary: '#2d2a26' },   // charcoal on cream
    { bg: '#f6f4ef', primary: '#3a3357' },   // aubergine on parchment
  ],
  modern: [
    { bg: '#ffffff', primary: '#4f46e5' },   // indigo
    { bg: '#ffffff', primary: '#0f766e' },   // teal
    { bg: '#fafafa', primary: '#1d4ed8' },   // blue
    { bg: '#ffffff', primary: '#7c3aed' },   // violet
    { bg: '#fafbfc', primary: '#0f172a' },   // slate ink
  ],
  warm: [
    { bg: '#fff8f1', primary: '#b5532a' },   // terracotta
    { bg: '#faf6ee', primary: '#6b6b23' },   // olive
    { bg: '#fdf6ec', primary: '#8a4f2d' },   // clay
    { bg: '#fbf3ee', primary: '#7a3b3f' },   // brick rose
    { bg: '#f9f5ec', primary: '#4e6151' },   // sage
  ],
  bold: [
    { bg: '#0c0c0d', primary: '#ff4d2e' },   // signal orange on black
    { bg: '#0b0b10', primary: '#e11d48' },   // punch red
    { bg: '#0a0f0d', primary: '#22c55e' },   // acid green
    { bg: '#0b1020', primary: '#38bdf8' },   // electric blue
    { bg: '#111111', primary: '#facc15' },   // taxi yellow
  ],
  minimal: [
    { bg: '#ffffff', primary: '#111111' },
    { bg: '#fcfcfc', primary: '#1f2937' },   // gunmetal
    { bg: '#fbfbfa', primary: '#26251f' },   // warm black
    { bg: '#ffffff', primary: '#0a0a0a' },
  ],
};

const hue = (hex: string): number => {
  let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return -1;   // achromatic
  const d = mx - mn;
  const x = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return x * 60;
};
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
// colour words a client actually writes in a brief → target hue (achromatic words are left to the hash)
const COLOR_WORDS: [RegExp, number][] = [
  [/\b(red|crimson|scarlet)\b/, 0], [/\b(orange|terracotta|rust|amber)\b/, 25],
  [/\b(yellow|gold(en)?|mustard)\b/, 50], [/\b(green|olive|sage|forest|emerald)\b/, 130],
  [/\b(teal|turquoise|aqua|cyan)\b/, 180], [/\b(blue|navy|azure|cobalt)\b/, 225],
  [/\b(purple|violet|lavender|aubergine|plum)\b/, 280], [/\b(pink|rose|magenta|fuchsia)\b/, 330],
];
const hash32 = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

export function paletteFor(theme: ThemeName, brief: string): BrandPalette {
  const pool = BRAND_POOLS[theme] || BRAND_POOLS[DEFAULT_THEME];
  const b = deburr(String(brief || '').toLowerCase());
  for (const [re, target] of COLOR_WORDS) if (re.test(b)) {
    const chromatic = pool.filter(p => hue(p.primary) >= 0);
    if (chromatic.length) return chromatic.reduce((best, p) => hueDist(hue(p.primary), target) < hueDist(hue(best.primary), target) ? p : best);
  }
  return pool[(hash32(b) >>> 7) % pool.length];   // different bits than hero/cards — axes stay uncorrelated
}

export function isTheme(x: any): x is ThemeName { return typeof x === 'string' && (THEME_NAMES as string[]).includes(x); }
export function themeFonts(name: ThemeName) { return { display: T[name].fontDisplay, body: T[name].fontBody }; }
export function themeVars(name: ThemeName): string { return Object.entries(T[name].vars).map(([k, v]) => `${k}:${v}`).join(';'); }
export function themeTone(name: ThemeName): string { return T[name].tone; }

// Deterministic, brief-rooted classification. First matching rule wins, so order is precedence.
// `warm` (very specific food/craft words) goes first; `modern` is BEFORE `editorial` so a product brief
// that also mentions a domain ("financial planning SOFTWARE", "legaltech PLATFORM") reads as a product,
// not a firm. The input is de-accented before matching so "café"/"résumé" match their ASCII keywords
// (JS \b word boundaries don't fire next to non-ASCII letters like é).
const RULES: [ThemeName, RegExp][] = [
  ['warm', /\b(bakery|baker|cafe|coffee|roaster|roastery|restaurant|bistro|brasserie|eatery|diner|deli|taqueria|taco|pizzeria|pizza|burger|ramen|noodle|sushi|steakhouse|grill|\bpub\b|gastropub|brewery|brewpub|distillery|vineyard|winery|patisserie|creamery|gelato|food|menu|kitchen|catering|grocer|butcher|wellness|spa|salon|yoga|massage|florist|flower|ceramic|pottery|craft|artisan|handmade|tea ?house|tea ?room|farm|garden|candle|skincare|beauty|bath ?house)\b/],
  ['modern', /\b(saas|software|app\b|platform|\bapi\b|tech\w*|\bai\b|machine ?learning|dashboard|b2b|product|startup|cloud|developer|dev ?tool\w*|fintech|crypto|web3|analytics|automation|cyber\w*|devops|infrastructure)\b/],
  ['editorial', /\b(law|legal|attorney|lawyer|advocate|counsel|consult\w*|advisory|finance|financial|bank\w*|wealth|capital|invest\w*|equity|architect\w*|real ?estate|realty|propert\w*|insurance|notary|account\w*|\btax\b|clinic|medical|dental|university|college|institute|academy|journal|magazine|editorial|publish\w*|museum|heritage|luxury|jewel\w*|chambers|\bpartners?\b)\b/],
  ['bold', /\b(agency|fitness|gym|crossfit|workout|sport\w*|athlet\w*|events?|festival|conference|music|band|\bdj\b|nightclub|nightlife|fashion|streetwear|sneaker\w*|apparel|esports|gaming|tattoo|barber|energy ?drink)\b/],
  ['minimal', /\b(portfolio|photograph\w*|videograph\w*|filmmaker|design\w* studio|personal site|resume|\bcv\b|\bartist\b|gallery|minimal\w*)\b/],
];

const deburr = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');   // strip accents: café -> cafe

export function classifyTheme(brief: string): ThemeName {
  const b = ' ' + deburr(String(brief || '').toLowerCase()) + ' ';
  for (const [name, re] of RULES) if (re.test(b)) return name;
  return DEFAULT_THEME;
}

// The planner's resolver: trust an LLM-named archetype only if it's in the closed set; otherwise
// classify the brief deterministically. Either way the result is bounded and reproducible.
export function themeFor(named: any, brief: string): ThemeName {
  return isTheme(named) ? named : classifyTheme(brief);
}

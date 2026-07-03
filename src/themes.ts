// DESIGN LANGUAGES ("themes") — the rootedness layer.
// A brief is classified into ONE archetype; the renderer expands that archetype into a full
// type / rhythm / shape system so a law firm reads like a law firm and a bakery like a bakery —
// not the same template wearing different colours.
//
// Zero-trust intact: this is STRUCTURE, so it is composed, not authored. The LLM may at most NAME an
// archetype (validated against this closed set, with a deterministic brief-derived fallback). It never
// writes CSS. The renderer still derives the WCAG-safe palette from bg+primary; a theme only changes
// typography, spacing rhythm and shape — none of which can break contrast.

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
    },
    tone: 'spare, calm, understated — few words, lots of restraint',
  },
};

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

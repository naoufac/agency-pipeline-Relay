// Deterministic proof for the theme/identity system.
// For every theme: render a representative page through the REAL renderPage, then run the same gates
// site_renders enforces (valid HTML structure · zero external/unbundled assets · no [Placeholder] copy ·
// a non-blank chromium screenshot > 3KB) PLUS a WCAG AA assertion on the rendered text/bg palette,
// at BOTH mobile (390px) and desktop (1280px). Exits non-zero on any failure. No API key required.
//
//   npm run theme:check
import { mkdirSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderPage } from './render.ts';
import { screenshot, closeBrowser } from './browser.ts';
import { THEME_NAMES, type ThemeName } from './themes.ts';
import { DS_CSS } from './components.ts';

const OUT = new URL('../sites/_themecheck/', import.meta.url);

function rgb(h: string) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lum([r, g, b]: number[]) { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
function contrast(a: string, b: string) { const L1 = lum(rgb(a)), L2 = lum(rgb(b)); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); }

// fitting brand colours per theme (the renderer derives the rest of the palette, WCAG-safe, from these)
const COLOURS: Record<ThemeName, { bg: string; primary: string }> = {
  editorial: { bg: '#fbfaf7', primary: '#1a1a2e' },
  modern:    { bg: '#ffffff', primary: '#4f46e5' },
  warm:      { bg: '#fff8f1', primary: '#b5532a' },
  bold:      { bg: '#0c0c0d', primary: '#ff4d2e' },
  minimal:   { bg: '#ffffff', primary: '#111111' },
};

// real, specific copy (NO bracketed Title-Case — the gate rejects [Placeholders]); exercises every section
function sampleSpec(theme: ThemeName) {
  const c = COLOURS[theme];
  return {
    brand: { name: 'Northgate', cta: 'Get in touch', tokens: { bg: c.bg, primary: c.primary, accent: c.primary } },
    sections: [
      { type: 'hero', eyebrow: 'Established 1998', headline: 'Work that holds up over time', lead: 'A studio built around one idea: do fewer things, and do them properly, for people who notice the difference.', cta: 'Start a project' },
      { type: 'features', title: 'What we do', intro: 'Three things we are known for.', items: [
        { title: 'Discovery', body: 'We learn the real problem before we touch a single pixel.' },
        { title: 'Delivery', body: 'We ship on a schedule you can plan a launch around.' },
        { title: 'Support', body: 'We stay long after launch, because the first week is never the last.' } ] },
      { type: 'split', eyebrow: 'Our approach', title: 'Built with care, measured twice', body: 'Every engagement starts with the same question and ends with something you are proud to put your name on. We work in small teams, in the open, with no surprises at the end.', cta: 'Read our approach' },
      { type: 'stats', title: 'By the numbers', items: [{ value: '12 yrs', label: 'in business' }, { value: '480+', label: 'projects shipped' }, { value: '98%', label: 'would refer us' }] },
      { type: 'pricing', title: 'Simple pricing', intro: 'No surprises.', plans: [
        { name: 'Starter', price: '$0', period: 'mo', body: 'For trying it out.', features: ['One project', 'Community support'], cta: 'Start free' },
        { name: 'Pro', price: '$29', period: 'mo', featured: true, body: 'For working teams.', features: ['Unlimited projects', 'Priority support', 'Custom domain'], cta: 'Get Pro' },
        { name: 'Studio', price: '$99', period: 'mo', body: 'For agencies.', features: ['Everything in Pro', 'White-label', 'SLA'], cta: 'Contact us' }] },
      { type: 'testimonials', title: 'What clients say', items: [
        { quote: 'They shipped in a week what others quoted a quarter for.', name: 'Dana R.', role: 'Founder, Northwind' },
        { quote: 'Calm, fast, and the result just worked.', name: 'Sam O.', role: 'Head of Ops' }] },
      { type: 'faq', title: 'Questions', items: [{ q: 'How long does it take?', a: 'Most projects ship within two weeks.' }, { q: 'Do you offer support?', a: 'Yes — every plan includes it.' }] },
      { type: 'cta', headline: 'Ready when you are', body: 'Tell us what you are building and we will tell you, honestly, whether we are the right fit.', cta: 'Book a call' },
      { type: 'feed', title: 'From the community', intro: 'Recent additions from people like you.', form: 'listing', empty: 'Be the first to add yours.' },
      { type: 'collection', title: 'On the menu', intro: 'A few of our favourites.', table: 'items', empty: 'Menu coming soon.' },
      { type: 'form', title: 'Get in touch', intro: 'Tell us about your project and we will reply within a day.', cta: 'Send message' },
    ],
  };
}

const PAGES = [{ slug: 'index', title: 'Home' }, { slug: 'about', title: 'About' }, { slug: 'contact', title: 'Contact' }];

// the structural / asset / placeholder gates, identical in spirit to verify.ts `site_renders`
function staticGate(html: string): string | null {
  const lo = html.toLowerCase();
  if (!/<html|<!doctype/.test(lo.slice(0, 400)) || !/<body|<div|<section/.test(lo)) return 'not valid HTML structure';
  if (/src\s*=\s*["']?https?:|url\(\s*["']?https?:|<link\b[^>]*href\s*=\s*["']?https?:|\bapp\.css\b|via\.placeholder/i.test(html))
    return 'external/unbundled asset reference';
  const ph = html.match(/\[[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}\]/);
  if (ph) return 'unfilled placeholder: ' + ph[0];
  return null;
}

async function shoot(path: string, shot: string, w: number, h: number) {
  try { writeFileSync(shot, await screenshot('file://' + path, { width: w, height: h })); } catch {}
  return existsSync(shot) ? statSync(shot).size : 0;
}

// PQ1 · ART-DIRECTION — the full closed-set photo-treatment axis every theme must carry
const PHOTO_VARS = ['--photo-filter', '--photo-tint', '--photo-tint-blend', '--photo-radius',
  '--crop-hero-split', '--crop-hero-wide', '--crop-split', '--hero-tint-mix'];
const cssVar = (html: string, name: string) => html.match(new RegExp(name.replace(/-/g, '\\-') + ':([^;}]+)[;}]'))?.[1]?.trim();

async function main() {
  rmSync(fileURLToPath(OUT), { recursive: true, force: true });
  mkdirSync(fileURLToPath(OUT), { recursive: true });
  let failures = 0;
  const grades = new Map<string, string>();   // theme -> --photo-filter (must DIFFER across themes)
  const cropSplit = new Set<string>(); const photoRadius = new Set<string>();

  for (const theme of THEME_NAMES) {
    const spec = sampleSpec(theme);
    const html = renderPage(spec, { pages: PAGES, slug: 'index', title: 'Home', projectId: '_themecheck', theme });
    const file = fileURLToPath(new URL(`${theme}.html`, OUT));
    writeFileSync(file, html);

    const problems: string[] = [];

    // 1. the body class actually carries the theme (proves wiring end-to-end)
    if (!new RegExp(`<body class="t-${theme}(\\s|")`).test(html)) problems.push('missing body class t-' + theme);

    // 2. structure / assets / placeholders
    const g = staticGate(html); if (g) problems.push(g);
    if (html.length < 400) problems.push('too small');

    // 2b. the page's inline <script> must be VALID JS — a broken emitted script silently kills every
    // client behaviour (collections never load, forms never submit). Parse it; fail hard if invalid.
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      try { new Function(m[1]); } catch (e: any) { problems.push('emitted <script> is invalid JS: ' + (e?.message ?? e)); }
    }

    // 3. WCAG AA on the rendered palette (derived deterministically from bg+primary)
    const bg = html.match(/--bg:(#[0-9a-fA-F]{3,8})/)?.[1];
    const text = html.match(/--text:(#[0-9a-fA-F]{3,8})/)?.[1];
    if (!bg || !text) problems.push('palette vars not found');
    else { const ratio = contrast(text, bg); if (ratio < 4.5) problems.push(`text/bg contrast ${ratio.toFixed(2)} < 4.5`); }

    // 3b. WCAG AA on the button text/background pair (AA 4.5).
    // Ghost (minimal): text is --primary on --bg. Filled: text is --on-primary on --primary.
    const primary = html.match(/--primary:(#[0-9a-fA-F]{3,8})/)?.[1];
    const onPrimary = html.match(/--on-primary:(#[0-9a-fA-F]{3,8})/)?.[1];
    if (!primary || !onPrimary) { problems.push('btn palette vars not found'); }
    else if (theme === 'minimal') {
      if (!bg) problems.push('ghost btn: --bg not found');
      else { const r = contrast(primary, bg); if (r < 4.5) problems.push(`ghost btn contrast ${r.toFixed(2)} < 4.5`); }
    } else {
      const r = contrast(onPrimary, primary);
      if (r < 4.5) problems.push(`btn contrast ${r.toFixed(2)} < 4.5`);
    }

    // 3c. ART-DIRECTION (PQ1): the theme carries the whole photo-treatment axis (grade, tint, crop,
    // frame) — a missing var silently collapses every site back to raw untreated stock.
    for (const v of PHOTO_VARS) if (!cssVar(html, v)) problems.push(`art-direction var ${v} missing`);
    const grade = cssVar(html, '--photo-filter'); if (grade) grades.set(theme, grade);
    const cs = cssVar(html, '--crop-hero-split'); if (cs) cropSplit.add(cs);
    const pr = cssVar(html, '--photo-radius'); if (pr) photoRadius.add(pr);

    // 4. real renders — non-blank screenshot at desktop AND mobile
    const dShot = fileURLToPath(new URL(`${theme}-desktop.png`, OUT));
    const mShot = fileURLToPath(new URL(`${theme}-mobile.png`, OUT));
    const dSize = await shoot(file, dShot, 1280, 860);
    const mSize = await shoot(file, mShot, 390, 844);
    if (dSize <= 3000) problems.push(`desktop shot blank (${dSize}b)`);
    if (mSize <= 3000) problems.push(`mobile shot blank (${mSize}b)`);

    if (problems.length) { failures++; console.log(`✗ ${theme.padEnd(10)} ${problems.join(' · ')}`); }
    else console.log(`✓ ${theme.padEnd(10)} renders · structure ok · no external assets · AA contrast · desktop ${dSize}b / mobile ${mSize}b`);
  }

  // ART-DIRECTION, cross-theme: five themes = five different photographic voices, applied by DS_CSS.
  // (No grade may be duplicated — a collapse here is exactly the "one studio look" the panel scored.)
  const adProblems: string[] = [];
  if (new Set(grades.values()).size !== THEME_NAMES.length)
    adProblems.push(`photo grades collapse: ${THEME_NAMES.length} themes share ${new Set(grades.values()).size} --photo-filter values`);
  if (cropSplit.size < 3) adProblems.push(`crop discipline collapse: only ${cropSplit.size} distinct --crop-hero-split values`);
  if (photoRadius.size < 3) adProblems.push(`photo framing collapse: only ${photoRadius.size} distinct --photo-radius values`);
  // DS_CSS must actually APPLY the axis — vars without hooks are decoration
  if (!/\.hero-bg\{[^}]*filter:var\(--photo-filter/.test(DS_CSS)) adProblems.push('DS_CSS: .hero-bg not graded');
  if (!/\.hero-overlay\{[^}]*color-mix\(in srgb,var\(--primary\) var\(--hero-tint-mix/.test(DS_CSS)) adProblems.push('DS_CSS: hero overlay not brand-tinted');
  if (!/\.hero-overlay\{[^}]*rgba\(0,0,0,\.34\)[^}]*rgba\(0,0,0,\.58\)/.test(DS_CSS)) adProblems.push('DS_CSS: hero overlay lost its fixed dark floor (AA)');
  for (const hook of ['.hero-split .hero-media::after', '.hero-editorial .hero-wide::after', '.split-media::after'])
    if (!DS_CSS.includes(hook)) adProblems.push(`DS_CSS: tint layer ${hook} missing`);
  if (!/\.pdp \.split-media img\{filter:none/.test(DS_CSS) || !/\.pdp \.split-media::after\{content:none/.test(DS_CSS))
    adProblems.push('DS_CSS: product photos must stay true colour (.pdp exemption missing)');
  if (adProblems.length) { failures++; console.log(`✗ art-direction ${adProblems.join(' · ')}`); }
  else console.log(`✓ art-direction ${grades.size} distinct grades · ${cropSplit.size} split crops · ${photoRadius.size} frames · tint layers + PDP exemption wired`);

  console.log(failures ? `\nFAILED: ${failures}/${THEME_NAMES.length} themes have problems` : `\nOK: all ${THEME_NAMES.length} themes render, pass the gate, and meet AA — output in sites/_themecheck/`);
  await closeBrowser();
  process.exit(failures ? 1 : 0);
}
main();

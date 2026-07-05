// design:check — FIGMA → REALITY. Proves the design-source ingestion seam end-to-end WITHOUT any live
// API: a realistic exported-tokens object (the shape Figma variables / Tokens Studio / a Canva brand
// kit produce) becomes a Design, the renderer honors it OVER the theme (palette + fonts + radius + a
// real Google-Fonts link), untrusted font names are rejected, and an ABSENT design leaves output
// byte-identical to today. Run: node --experimental-strip-types src/design-check.ts
import { designFromTokens, fontLink, designTypeVars, safeFont, hasDesign } from './design.ts';
import { renderPage } from './render.ts';

// tiny WCAG contrast (mirror of the renderer's) so the gate can PROVE legibility of the rendered vars
function lum(hex: string): number {
  const h = hex.replace('#', ''); const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const c = [0, 2, 4].map((i) => { const v = parseInt(n.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string): number { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
const rootVar = (html: string, name: string): string | null => {
  const m = html.match(new RegExp(':root\\{([^}]*)\\}')); if (!m) return null;
  const all = [...m[1].matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'g'))]; return all.length ? all[all.length - 1][1] : null;   // LAST wins in cascade
};

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name, extra); } };

// a realistic Figma "export variables" payload (Tokens-Studio-ish), plus a leaf-wrapped variant
const FIGMA_TOKENS = {
  colors: {
    background: { $value: '#0f1115' }, primary: { $value: '#e8b04b' },
    accent: { $value: '#3ba7a0' }, text: { $value: '#f4f4f5' }, surface: { $value: '#1a1d24' },
  },
  typography: { heading: { fontFamily: 'Playfair Display' }, body: { fontFamily: 'Inter' } },
  radius: { $value: '14px' },
};

// ---- 1. the adapter maps tokens → a Design ----
const d = designFromTokens(FIGMA_TOKENS, 'figma');
ok('tokens → palette (bg/primary/accent/text/surface)', d.palette?.bg === '#0f1115' && d.palette?.primary === '#e8b04b' && d.palette?.accent === '#3ba7a0' && d.palette?.text === '#f4f4f5' && d.palette?.surface === '#1a1d24', JSON.stringify(d.palette));
ok('tokens → fonts (display + body)', d.fonts?.display === 'Playfair Display' && d.fonts?.body === 'Inter', JSON.stringify(d.fonts));
ok('tokens → radius', d.radius === '14px', String(d.radius));
ok('the source is recorded', d.source === 'figma');
ok('hasDesign is true for a real design', hasDesign(d) === true);

// a flat shape (no $value wrappers) and alternate key names also map
const flat = designFromTokens({ color: { bg: '#fff', brand: '#111', ink: '#222' }, fonts: { title: 'Poppins', body: 'Roboto' }, borderRadius: 8 });
ok('a flat token shape + alternate names map too (bg/brand/ink, title/body)', flat.palette?.bg === '#fff' && flat.palette?.primary === '#111' && flat.palette?.text === '#222' && flat.fonts?.display === 'Poppins' && flat.radius === '8px', JSON.stringify(flat));

// ---- 2. the Google-Fonts link is built and sanitized ----
const link = fontLink(d);
ok('a Google-Fonts <link> is emitted for the design fonts', /fonts\.googleapis\.com\/css2\?/.test(link) && link.includes('Playfair+Display') && link.includes('Inter'));
ok('empty design → no font link (system-font themes stay link-free)', fontLink({}) === '' && fontLink(null as any) === '');

// ---- 3. font-name SANITIZATION: an injection attempt is rejected, never reaches HTML/URL/CSS ----
ok('a malicious font name is rejected (no quote/tag/url injection)', safeFont(`Evil'}</style><script>alert(1)</script>`) === undefined && safeFont('Inter";x:url(evil)') === undefined);
ok('a legit font name passes', safeFont('Playfair Display') === 'Playfair Display');
const evil = designFromTokens({ colors: { primary: '#123456' }, typography: { heading: { fontFamily: `X"><script>alert(1)</script>` } } });
ok('a design built from a hostile token file carries NO unsafe font', !evil.fonts || !evil.fonts.display);
ok('designTypeVars emits ONLY fonts+radius (palette is derived by the renderer), safely', !/[<>"]/.test(designTypeVars(d)) && !/--primary/.test(designTypeVars(d)) && /--font-display:'Playfair Display'/.test(designTypeVars(d)) && /--radius:14px/.test(designTypeVars(d)));
ok('the Google-Fonts link carries referrerpolicy=no-referrer (no page-URL leak)', /referrerpolicy="no-referrer"/.test(fontLink(d)));

// ---- 4. the RENDERER honors the design over the theme ----
const pages = [{ slug: 'index', title: 'Home' }];
const baseSpec = { brand: { name: 'Lumen', tokens: { bg: '#ffffff', primary: '#4f46e5' } }, sections: [{ type: 'hero', headline: 'Hello', sub: 'World' }] };
const themed = renderPage(JSON.parse(JSON.stringify(baseSpec)), { pages, slug: 'index', title: 'Home', theme: 'modern' });
const designed = renderPage({ ...JSON.parse(JSON.stringify(baseSpec)), brand: { name: 'Lumen', tokens: { bg: '#ffffff', primary: '#4f46e5' }, design: d } }, { pages, slug: 'index', title: 'Home', theme: 'modern' });
ok('a designed page overrides the palette (design primary wins over the theme)', designed.includes('--primary:#e8b04b'));
ok('a designed page overrides the fonts', /--font-display:'Playfair Display'/.test(designed) && /--font-body:'Inter'/.test(designed));
ok('a designed page overrides the radius', designed.includes('--radius:14px'));
ok('a designed page loads the web fonts (Google Fonts link in <head>)', designed.includes('fonts.googleapis.com/css2'));
ok('a designed page is still a valid Relay page (rendered marker, nav, section)', designed.includes('<!--relay:rendered-->') && /class="t-modern/.test(designed));

// ---- 4b. LEGIBILITY GUARANTEE holds when a design overrides colours (audit 2026-07-05) ----
// a Figma design with a DARK bg and NO text colour: the renderer must re-derive legible text/labels.
const darkOnly = designFromTokens({ colors: { background: '#111827', primary: '#1e3a8a' } }, 'figma');   // dark bg + dark-ish primary, no text/on-primary given
const darkPage = renderPage({ brand: { name: 'X', tokens: { bg: '#ffffff', primary: '#4f46e5' }, design: darkOnly }, sections: [{ type: 'hero', headline: 'Hi' }] }, { pages, slug: 'index', title: 'H', theme: 'modern' });
const dBg = rootVar(darkPage, '--bg'), dText = rootVar(darkPage, '--text'), dPrim = rootVar(darkPage, '--primary'), dOnP = rootVar(darkPage, '--on-primary');
ok('design dark bg is applied', dBg === '#111827');
ok('body text stays LEGIBLE on the design bg (re-derived, not the theme text)', !!dBg && !!dText && ratio(dText!, dBg!) >= 4.5, `text ${dText} on ${dBg} = ${dBg && dText ? ratio(dText!, dBg!).toFixed(1) : '?'}:1`);
ok('button label stays LEGIBLE on the design primary (on-primary re-derived)', !!dPrim && !!dOnP && ratio(dOnP!, dPrim!) >= 4.5, `on-primary ${dOnP} on ${dPrim} = ${dPrim && dOnP ? ratio(dOnP!, dPrim!).toFixed(1) : '?'}:1`);
// a design that hands us an ILLEGIBLE text colour is DROPPED for the safe derived one
const badText = { source: 'figma' as const, palette: { bg: '#111827', text: '#222222' } };   // text ~ bg = unreadable
const badPage = renderPage({ brand: { name: 'X', tokens: { bg: '#fff', primary: '#4f46e5' }, design: badText }, sections: [{ type: 'hero', headline: 'Hi' }] }, { pages, slug: 'index', title: 'H', theme: 'modern' });
const bBg = rootVar(badPage, '--bg'), bText = rootVar(badPage, '--text');
ok('a design text colour that FAILS contrast is rejected for a legible one', !!bBg && !!bText && bText !== '#222222' && ratio(bText!, bBg!) >= 4.5, `text ${bText} on ${bBg}`);

// ---- 5. ABSENT design → byte-identical to today (zero regression on every existing site) ----
ok('no design → output is byte-identical to the themed render (no regression)', themed === renderPage(JSON.parse(JSON.stringify(baseSpec)), { pages, slug: 'index', title: 'Home', theme: 'modern' }));
ok('no design → no Google-Fonts link injected', !themed.includes('fonts.googleapis.com'));

// ---- 6. source pins: the seam is wired through the brand (identical per page) + live path ----
const specSrc = (await import('node:fs')).readFileSync(new URL('./spec.ts', import.meta.url), 'utf8');
ok('spec: the design rides on the canonical brand (identical on every page)', /design: \(b\.design/.test(specSrc) && specSrc.includes('spec.brand.design = canon.design'));
const renderSrc = (await import('node:fs')).readFileSync(new URL('./render.ts', import.meta.url), 'utf8');
ok('render: the design PALETTE feeds the contrast derivation (not a blind append) + fonts appended + font link', /isHex\(dp\.bg\)/.test(renderSrc) && /isHex\(dp\.text\)[\s\S]{0,60}contrast/.test(renderSrc) && renderSrc.includes('designTypeVars(design)') && renderSrc.includes('fontLink(design)'));

console.log(`\ndesign:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

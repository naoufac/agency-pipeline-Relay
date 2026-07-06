// figma:check — the LIVE Figma connector. Proves the PURE mapping (figmaFileToTokens) against a
// realistic /v1/files/:key response — named colour + text styles bound to nodes → canonical tokens →
// a legible Design. No network. Plus the URL parser + endpoint/UI wiring pins.
import { figmaKeyFromUrl, figmaFileToTokens } from './figma.ts';
import { designFromTokens, hasDesign } from './design.ts';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.error('  ✗', n, e); } };

// ---- URL / key parsing ----
ok('figma URL (design) → key', figmaKeyFromUrl('https://www.figma.com/design/AbcD1234efGh/My-Brand?node-id=1') === 'AbcD1234efGh');
ok('figma URL (file) → key', figmaKeyFromUrl('https://figma.com/file/ZZ99xx8877QQ/Kit') === 'ZZ99xx8877QQ');
ok('a bare key is accepted', figmaKeyFromUrl('AbcD1234efGh') === 'AbcD1234efGh');
ok('a non-figma URL → null', figmaKeyFromUrl('https://example.com/x') === null);

// ---- a realistic Figma file: styles map + nodes that BIND those styles (the documented shape) ----
const FILE = {
  name: 'Brand', styles: {
    'S:bg': { name: 'Background/Base', styleType: 'FILL' },
    'S:pri': { name: 'Brand/Primary', styleType: 'FILL' },
    'S:txt': { name: 'Text/Body', styleType: 'FILL' },
    'S:acc': { name: 'Accent/Highlight', styleType: 'FILL' },
    'S:h': { name: 'Heading/Display', styleType: 'TEXT' },
    'S:b': { name: 'Body/Paragraph', styleType: 'TEXT' },
  },
  document: { id: '0', children: [
    { id: '1', type: 'FRAME', cornerRadius: 12, styles: { fill: 'S:bg' }, fills: [{ type: 'SOLID', color: { r: 0.06, g: 0.07, b: 0.09 } }], children: [
      { id: '2', type: 'RECTANGLE', cornerRadius: 12, styles: { fill: 'S:pri' }, fills: [{ type: 'SOLID', color: { r: 0.91, g: 0.69, b: 0.29 } }] },
      { id: '3', type: 'RECTANGLE', styles: { fill: 'S:acc' }, fills: [{ type: 'SOLID', color: { r: 0.23, g: 0.65, b: 0.63 } }] },
      { id: '4', type: 'TEXT', styles: { text: 'S:h', fill: 'S:txt' }, fills: [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.98 } }], style: { fontFamily: 'Playfair Display', fontSize: 40 } },
      { id: '5', type: 'TEXT', styles: { text: 'S:b' }, style: { fontFamily: 'Inter', fontSize: 16 } },
    ] },
  ] },
};

const tk = figmaFileToTokens(FILE);
ok('colours: named FILL styles → canonical keys (bg/primary/text/accent)', tk.colors.background === '#0f1217' && tk.colors.primary === '#e8b04a' && tk.colors.text === '#f5f5fa' && tk.colors.accent === '#3ba6a1', JSON.stringify(tk.colors));
ok('typography: heading style → display, body style → body', tk.typography.heading?.fontFamily === 'Playfair Display' && tk.typography.body?.fontFamily === 'Inter', JSON.stringify(tk.typography));
ok('radius: the common corner radius → px', tk.radius === '12px', String(tk.radius));

// the mapped tokens flow through the SAME designFromTokens → a real, legible Design
const design = designFromTokens(tk, 'figma');
ok('figma tokens → a usable Design (palette + fonts + radius)', hasDesign(design) && design.palette?.primary === '#e8b04a' && design.fonts?.display === 'Playfair Display' && design.radius === '12px', JSON.stringify(design));

// robustness: an empty / junk file never throws, yields no design
ok('an empty file maps to no usable design (no throw)', !hasDesign(designFromTokens(figmaFileToTokens({}), 'figma')));
ok('a file with unnamed styles yields nothing mappable (no throw)', !hasDesign(designFromTokens(figmaFileToTokens({ document: { children: [{ type: 'RECTANGLE', fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] }] } }), 'figma')));

// ---- AUDIT 2026-07-06 fixes ----
// ALPHA: a semi-transparent fill is composited over white, never shipped as a wrong opaque colour.
const alphaFile = { styles: { 'S:p': { name: 'Primary', styleType: 'FILL' } },
  document: { children: [{ type: 'RECT', styles: { fill: 'S:p' }, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 0.5 } }] }] } };
ok('alpha: a 50%-black fill composites over white (#808080), not opaque #000000', figmaFileToTokens(alphaFile).colors.primary === '#808080', figmaFileToTokens(alphaFile).colors.primary);

// HEADING pick: a tiny name-matched caption must NOT beat a large display style.
const capFile = { styles: { 'S:cap': { name: 'Heading/Caption', styleType: 'TEXT' }, 'S:disp': { name: 'Display/Hero', styleType: 'TEXT' } },
  document: { children: [
    { type: 'TEXT', styles: { text: 'S:cap' }, style: { fontFamily: 'Tiny', fontSize: 8 } },
    { type: 'TEXT', styles: { text: 'S:disp' }, style: { fontFamily: 'Big Serif', fontSize: 48 } }] } };
ok('heading: the LARGEST heading-named style wins (48px Display, not the 8px caption)', figmaFileToTokens(capFile).typography.heading?.fontFamily === 'Big Serif', JSON.stringify(figmaFileToTokens(capFile).typography));

// COLOUR MODE: a style overridden on ONE instance still resolves to its majority colour.
const overFile = { styles: { 'S:p': { name: 'Primary', styleType: 'FILL' } },
  document: { children: [
    { type: 'R', styles: { fill: 'S:p' }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
    { type: 'R', styles: { fill: 'S:p' }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
    { type: 'R', styles: { fill: 'S:p' }, fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }] }] } };   // one override
ok('colour: a single overridden instance loses to the style majority (#ff0000, not #00ff00)', figmaFileToTokens(overFile).colors.primary === '#ff0000', figmaFileToTokens(overFile).colors.primary);

// LEAF classification: "Text/Background" is a background, not text.
const tbFile = { styles: { 'S:x': { name: 'Text/Background', styleType: 'FILL' } },
  document: { children: [{ type: 'R', styles: { fill: 'S:x' }, fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1 } }] }] } };
ok('classify: "Text/Background" → background (leaf segment wins), not text', figmaFileToTokens(tbFile).colors.background === '#1a1a1a' && !figmaFileToTokens(tbFile).colors.text, JSON.stringify(figmaFileToTokens(tbFile).colors));

// SIZE CAP: the fetch bounds the response (source pin — no live network here).
const figSrc = (await import('node:fs')).readFileSync(new URL('./figma.ts', import.meta.url), 'utf8');
ok('fetch: the Figma response is size-capped (bounded stream read, no unbounded res.json)', figSrc.includes('figma-too-large') && /received > MAX/.test(figSrc) && figSrc.includes('getReader'));

// ---- wiring pins ----
const serverSrc = (await import('node:fs')).readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
ok('server: the /design endpoint imports the live Figma path (figmaUrl branch)', serverSrc.includes('figmaUrlToTokens') && /b\.figmaUrl/.test(serverSrc));
ok('server: no FIGMA_TOKEN degrades to a clear message (not a 500)', serverSrc.includes('figma-not-connected') && /Figma is not connected yet/.test(serverSrc));
const appjs = (await import('node:fs')).readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
ok('board: the Design tab has an "Import from Figma" URL field', appjs.includes('Import from Figma') && appjs.includes('figmaUrl:u'));

console.log(`\nfigma:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

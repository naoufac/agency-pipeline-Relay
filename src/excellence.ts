// Excellence layer: compile Tailwind (vendored standalone binary) against a page and inline the
// result + real base64 fonts, producing one self-contained, gate-safe, modern HTML file.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_FACES } from './fonts.ts';

const TW = fileURLToPath(new URL('../tools/tailwindcss', import.meta.url));

// appended to the Tailwind input: real inline fonts + a tasteful base layer
const BASE_CSS = FONT_FACES + `
:root{ --font-display:"Grotesk"; --font-body:"Inter"; }
html{ scroll-behavior:smooth; }
body{ font-family:var(--font-body),system-ui,-apple-system,sans-serif; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
h1,h2,h3,h4,.font-display{ font-family:var(--font-display),system-ui,sans-serif; letter-spacing:-0.02em; }
.font-serif-display{ font-family:"Fraunces",Georgia,serif; letter-spacing:-0.01em; }
/* mobile safety net — a produced site must never overflow or cut off its nav on a phone */
html,body{ overflow-x:hidden; }
@media (max-width:680px){
  nav ul, header ul{ flex-wrap:wrap; }
  nav > div, header > div, header > nav{ flex-wrap:wrap; gap:.45rem .8rem; }
  nav, header{ max-width:100vw; }
}
`;

export function tailwindAvailable(): boolean { return existsSync(TW); }

// Returns the page with compiled Tailwind + inline fonts injected. Never throws — on any
// failure it returns the input unchanged so a build is never broken by the excellence step.
export function applyExcellence(html: string): string {
  if (!existsSync(TW)) {
    console.error('[excellence] tailwindcss binary missing at ' + TW + ' — shipping UN-STYLED html. Run `bash tools/setup.sh`.');
    return html;
  }
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'relay-tw-'));
    const pagePath = join(dir, 'page.html');
    writeFileSync(pagePath, html);
    // source(none) disables Tailwind v4's broad auto-detection (which scans the whole tree, ~1min);
    // @source scopes scanning to JUST this page -> ~150ms, only the utilities this page uses.
    writeFileSync(join(dir, 'in.css'), `@import "tailwindcss" source(none);\n@source "${pagePath}";\n` + BASE_CSS);
    execFileSync(TW, ['-i', join(dir, 'in.css'), '-o', join(dir, 'out.css'), '--minify'], { timeout: 20000, stdio: 'ignore' });
    let css = readFileSync(join(dir, 'out.css'), 'utf8');
    css = css.replace(/^\s*\/\*[\s\S]*?\*\//, '').trim();           // strip leading license comment (contains a URL)
    if (!css) { console.error('[excellence] tailwind produced empty css — shipping un-styled html.'); return html; }
    const style = `<style>${css}</style>`;
    // drop any stylesheet <link> / app.css the agent may have added; inline our compiled CSS instead
    let out = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, '').replace(/<link\b[^>]*app\.css[^>]*>/gi, '');
    if (/<\/head>/i.test(out)) return out.replace(/<\/head>/i, style + '</head>');
    if (/<body[^>]*>/i.test(out)) return out.replace(/(<body[^>]*>)/i, '$1' + style);
    return style + out;
  } catch (e: any) { console.error('[excellence] compile failed — shipping un-styled html:', e?.message ?? e); return html; }
  finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }
}

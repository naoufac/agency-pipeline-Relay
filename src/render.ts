// Deterministic page renderer: a structured spec -> perfect HTML, assembled from vetted components.
// No LLM touches structure/CSS/nav/contrast here. spec = { brand:{name,cta,tokens}, sections:[{type,...}] }.
import { DS_CSS, navBar, footer, SECTIONS, esc } from './components.ts';

const isHex = (v: any) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim());
function rgb(h: string) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lum([r, g, b]: number[]) { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
function contrast(a: string, b: string) { const L1 = lum(rgb(a)), L2 = lum(rgb(b)); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); }
const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
function mix(a: string, b: string, t: number) { const x = rgb(a), y = rgb(b); return '#' + [0, 1, 2].map(i => hex(x[i] * (1 - t) + y[i] * t)).join(''); }
const pickOn = (bg: string) => contrast('#ffffff', bg) >= contrast('#0b1220', bg) ? '#ffffff' : '#0b1220';   // readable text for a bg
const FONTS = new Set(['Grotesk', 'Inter', 'Fraunces']);
const font = (n: any, fb: string) => (FONTS.has(String(n)) ? String(n) : fb);

export function renderPage(spec: any, ctx: { pages: any[]; slug: string; title: string; projectId?: string }): string {
  const t = (spec && spec.brand && spec.brand.tokens) || {};
  const bg = isHex(t.bg) ? t.bg.trim() : '#ffffff';
  const primary = isHex(t.primary) ? t.primary.trim() : '#4f46e5';
  // GUARANTEE legibility deterministically (no guessing): derive the whole palette from bg + primary.
  const text = (isHex(t.text) && contrast(t.text, bg) >= 4.5) ? t.text.trim() : pickOn(bg);
  const onPrimary = pickOn(primary);
  const accent = (isHex(t.accent) && contrast(t.accent, bg) >= 3) ? t.accent.trim() : primary;
  const vars = `:root{` +
    `--primary:${primary};--on-primary:${onPrimary};--accent:${accent};--bg:${bg};` +
    `--surface:${isHex(t.surface) ? t.surface.trim() : mix(text, bg, 0.96)};--text:${text};` +
    `--muted:${mix(text, bg, 0.42)};--line:${mix(text, bg, 0.86)};--radius:${/^\d+px$|^\d+rem$/.test(t.radius) ? t.radius : '14px'};` +
    `--font-display:'${font(t.font_display, 'Grotesk')}';--font-body:'${font(t.font_body, 'Inter')}'}`;

  const brand = (spec && spec.brand && spec.brand.name) || 'Studio';
  const sections = ((spec && spec.sections) || []).map((s: any) => (SECTIONS[s.type] || (() => ''))(s)).join('\n');
  return `<!doctype html><html lang="en"><head><!--relay:rendered--><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ctx.title)}${brand ? ' — ' + esc(brand) : ''}</title>
<style>${vars}
${DS_CSS}</style></head>
<body>
${navBar(brand, ctx.pages, ctx.slug, spec && spec.brand && spec.brand.cta)}
<main>
${sections}
</main>
${footer(brand, ctx.pages)}
<script>window.RELAY_PID=${JSON.stringify(ctx.projectId || '')};function relaySubmit(e){e.preventDefault();var f=e.target,d={};new FormData(f).forEach(function(v,k){d[k]=v});var m=f.querySelector('.rform-msg'),b=f.querySelector('button');if(b)b.disabled=true;fetch('/api/site/'+window.RELAY_PID+'/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({form:f.dataset.form,data:d})}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(){f.reset();if(m){m.hidden=false;m.textContent='Thanks — we got your message.'}}).catch(function(){if(m){m.hidden=false;m.textContent='Sorry, something went wrong — please try again.'}}).finally(function(){if(b)b.disabled=false});return false}</script>
</body></html>`;
}

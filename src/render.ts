// Deterministic page renderer: a structured spec -> perfect HTML, assembled from vetted components.
// No LLM touches structure/CSS/nav/contrast here. spec = { brand:{name,cta,tokens}, sections:[{type,...}] }.
import { DS_CSS, navBar, footer, SECTIONS, esc } from './components.ts';
import { themeFor, themeFonts, themeVars } from './themes.ts';

const isHex = (v: any) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim());
function rgb(h: string) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lum([r, g, b]: number[]) { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
function contrast(a: string, b: string) { const L1 = lum(rgb(a)), L2 = lum(rgb(b)); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); }
const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
function mix(a: string, b: string, t: number) { const x = rgb(a), y = rgb(b); return '#' + [0, 1, 2].map(i => hex(x[i] * (1 - t) + y[i] * t)).join(''); }
const pickOn = (bg: string) => contrast('#ffffff', bg) >= contrast('#0b1220', bg) ? '#ffffff' : '#0b1220';   // readable text for a bg

export function renderPage(spec: any, ctx: { pages: any[]; slug: string; title: string; projectId?: string; theme?: string; forms?: Record<string, any[]>; primaryTable?: string }): string {
  const t = (spec && spec.brand && spec.brand.tokens) || {};
  const bg = isHex(t.bg) ? t.bg.trim() : '#ffffff';
  const primary = isHex(t.primary) ? t.primary.trim() : '#4f46e5';
  // The brief roots the visual identity: a deterministic THEME owns typography, rhythm and shape
  // (fonts/scale/spacing/radius/border) — the model never authors any of it.
  const theme = themeFor(ctx.theme, '');
  const tf = themeFonts(theme);
  // GUARANTEE legibility deterministically (no guessing): derive the whole palette from bg + primary.
  const text = (isHex(t.text) && contrast(t.text, bg) >= 4.5) ? t.text.trim() : pickOn(bg);
  const onPrimary = pickOn(primary);
  const accent = (isHex(t.accent) && contrast(t.accent, bg) >= 3) ? t.accent.trim() : primary;
  const vars = `:root{` +
    `--primary:${primary};--on-primary:${onPrimary};--accent:${accent};--bg:${bg};` +
    `--surface:${isHex(t.surface) ? t.surface.trim() : mix(text, bg, 0.96)};--text:${text};` +
    `--muted:${mix(text, bg, 0.42)};--line:${mix(text, bg, 0.86)};` +
    `--font-display:'${tf.display}';--font-body:'${tf.body}';${themeVars(theme)}}`;

  const brand = (spec && spec.brand && spec.brand.name) || 'Studio';
  // Resolve each CTA to the RIGHT page by its INTENT (never one global page, never "last page"):
  // an explicit model-provided link → else a keyword match on the button text → else a sensible
  // fallback (contact/about/home). Every button goes somewhere real AND relevant.
  const pgs = ctx.pages || [];
  const findPage = (re: RegExp) => pgs.find((p: any) => re.test(p.slug) || re.test(String(p.title || '').toLowerCase()));
  const fallbackCta = `${(findPage(/contact|touch|reach|enquir/) || findPage(/about|story/) || pgs[0] || { slug: 'index' }).slug}.html`;
  const CTA_GROUPS: [RegExp, RegExp][] = [
    [/contact|touch|reach|email|enquir|quote|message/, /contact|reach|touch|quote|enquir/],
    [/shop|buy|browse|store|product|catalog|menu|order|cart/, /shop|store|product|catalog|menu|order/],
    [/book|reserv|appointment|schedul|table/, /book|reserv|appointment|schedul/],
    [/sign|join|start|get ?started|register|subscrib|apply|member|account|join us/, /sign|join|start|register|apply|member|account|get-?started/],
    [/about|story|who we|team|mission/, /about|story|team|mission/],
    [/pric|plan|package/, /pric|plan|package/],
    [/service|what we|feature/, /service|feature|what-we/],
  ];
  const resolveCta = (raw: any, text: any): string => {
    if (raw) { const r = String(raw).replace(/\.html$/, ''); if (pgs.some((p: any) => p.slug === r)) return r + '.html'; }
    const t = String(text || '').toLowerCase();
    for (const [tr, sr] of CTA_GROUPS) if (tr.test(t)) { const p = findPage(sr); if (p) return p.slug + '.html'; }
    return fallbackCta;
  };
  const link = (raw: any, text: any) => resolveCta(raw, text);
  const sections = ((spec && spec.sections) || []).map((s: any) => (SECTIONS[s.type] || (() => ''))(s, { link, forms: ctx.forms, primaryTable: (ctx as any).primaryTable })).join('\n');
  return `<!doctype html><html lang="en"><head><!--relay:rendered--><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ctx.title)}${brand ? ' — ' + esc(brand) : ''}</title>
<style>${vars}
${DS_CSS}</style></head>
<body class="t-${theme}">
${navBar(brand, ctx.pages, ctx.slug, spec && spec.brand && spec.brand.cta, resolveCta(spec && spec.brand && spec.brand.ctaLink, spec && spec.brand && spec.brand.cta))}
<main>
${sections}
</main>
${footer(brand, ctx.pages)}
<script>window.RELAY_PID=${JSON.stringify(ctx.projectId || '')};function relaySubmit(e){e.preventDefault();var f=e.target,d={};new FormData(f).forEach(function(v,k){d[k]=v});var m=f.querySelector('.rform-msg'),b=f.querySelector('button');if(b)b.disabled=true;var tbl=f.getAttribute('data-table');var url=tbl?('/api/site/'+window.RELAY_PID+'/data/'+encodeURIComponent(tbl)):('/api/site/'+window.RELAY_PID+'/submit');fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({form:f.dataset.form,data:d})}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(res){if(res&&res.ok===false)throw 0;f.reset();if(m){m.hidden=false;m.textContent=tbl?'Added ✓':'Thanks — we got your message.'}if(tbl&&window.__relayLoad)window.__relayLoad();}).catch(function(){if(m){m.hidden=false;m.textContent='Sorry, something went wrong — please try again.'}}).finally(function(){if(b)b.disabled=false});return false}
/* live read paths: .feed reads form submissions, .collection reads a real DB table. Both no-op under
   file:// (the gate) and populate over HTTP. textContent ONLY — server data is never injected as HTML. */
function __rcards(el,items){if(!items||!items.length)return;el.innerHTML='';var IMG=/image|photo|avatar|cover|logo|thumb|picture|banner/i,MONEY=/price|amount|cost|total|fee|budget|salary|rate/i;items.slice(0,12).forEach(function(o){o=o||{};var keys=Object.keys(o).filter(function(k){return['id','created_at','password_hash','password'].indexOf(k)<0&&o[k]!=null&&o[k]!==''});var tk=['name','title','business','listing','label'].filter(function(k){return o[k]})[0]||keys[0];var card=document.createElement('div');card.className='card';var imgk=keys.filter(function(k){return IMG.test(k)&&typeof o[k]==='string'&&/^(https?:|\/)/.test(o[k])})[0];if(imgk){var im=document.createElement('img');im.src=o[imgk];im.alt='';im.loading='lazy';im.style.cssText='width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;margin-bottom:12px';im.onerror=function(){im.remove()};card.appendChild(im);}if(tk){var h=document.createElement('h3');h.textContent=String(o[tk]);card.appendChild(h);}keys.filter(function(k){return k!==tk&&k!==imgk}).slice(0,6).forEach(function(k){var v=o[k],p=document.createElement('p');if(typeof v==='boolean'){if(!v)return;p.textContent='✓ '+k.replace(/_/g,' ');}else if(MONEY.test(k)&&!isNaN(parseFloat(v))){p.textContent='$'+parseFloat(v).toFixed(2);p.style.fontWeight='600';}else{p.textContent=String(v).slice(0,180);}card.appendChild(p);});el.appendChild(card);});}
window.__relayLoad=function(){var pid=window.RELAY_PID;if(!pid)return;
Array.prototype.forEach.call(document.querySelectorAll('.feed[data-feed]'),function(el){fetch('/api/submissions?id='+encodeURIComponent(pid)+'&form='+encodeURIComponent(el.getAttribute('data-feed'))).then(function(r){return r.json()}).then(function(d){__rcards(el,((d&&d.submissions)||[]).map(function(s){return s.data||{}}))}).catch(function(){})});
Array.prototype.forEach.call(document.querySelectorAll('.collection[data-table]'),function(el){fetch('/api/site/'+encodeURIComponent(pid)+'/data/'+encodeURIComponent(el.getAttribute('data-table'))).then(function(r){return r.json()}).then(function(d){__rcards(el,(d&&d.rows)||[])}).catch(function(){})});};
window.__relayLoad();</script>
</body></html>`;
}

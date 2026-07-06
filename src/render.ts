// Deterministic page renderer: a structured spec -> perfect HTML, assembled from vetted components.
import { isLocale, clientDict } from './i18n.ts';
// No LLM touches structure/CSS/nav/contrast here. spec = { brand:{name,cta,tokens}, sections:[{type,...}] }.
// ARC C: DS_CSS_BODY is the static design-system CSS written to assets/ds-<hash8>.css;
// dsCssHash computes the filename deterministically — renderPage emits the href, runner.ts writes the file.
import { DS_CSS_BODY, dsCssHash, navBar, footer, SECTIONS, esc, ctaParts } from './components.ts';
import { themeFor, themeFonts, themeVars } from './themes.ts';
import { DEFAULT_LAYOUT, isHeroVariant, isCardVariant, type Layout } from './layout.ts';
import { PRIVATE_READ } from './schema.ts';
import { metaDescription } from './seo.ts';
import { designTypeVars, fontLink, hasDesign } from './design.ts';
import { ldScript, organizationLd, websiteLd, breadcrumbLd, productLd, articleLd, faqPageLd, extractBusinessFacts, bizTypeFor } from './jsonld.ts';

const isHex = (v: any) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim());
function rgb(h: string) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lum([r, g, b]: number[]) { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
function contrast(a: string, b: string) { const L1 = lum(rgb(a)), L2 = lum(rgb(b)); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); }
const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
function mix(a: string, b: string, t: number) { const x = rgb(a), y = rgb(b); return '#' + [0, 1, 2].map(i => hex(x[i] * (1 - t) + y[i] * t)).join(''); }
const pickOn = (bg: string) => contrast('#ffffff', bg) >= contrast('#0b1220', bg) ? '#ffffff' : '#0b1220';   // readable text for a bg

// the slug of the page carrying the site's form — CTAs that resolve there land AT the form (anchor),
// so "Book now" from any page arrives at the actual booking form, never at the top of a page.
export const formPageSlug = (site: any): string | undefined =>
  ((site && site.pages) || []).find((p: any) => (p.sections || []).some((s: any) => s && s.type === 'form'))?.slug;

// FS2 — does this site keep visitor receipts/accounts? True when any form targets a private
// visitor-record table; drives the footer's Find-my-booking / My-bookings doors on every page.
export const receiptsEnabled = (site: any): boolean =>
  ((site && site.pages) || []).some((p: any) => (p.sections || []).some((s: any) => s && s.type === 'form' && typeof s.table === 'string' && PRIVATE_READ.test(s.table)));

export function renderPage(spec: any, ctx: { pages: any[]; slug: string; title: string; projectId?: string; theme?: string; layout?: Layout; forms?: Record<string, any[]>; primaryTable?: string; formSlug?: string; accountLinks?: boolean; locale?: string; siteBase?: string; localBusiness?: boolean; bizType?: string }): string {
  // LAYOUT (structure) is chosen once per project (params.layout) and passed here; a stray value falls
  // back to the safe default. Independent of THEME (tokens) — together they make sites distinct.
  const lay: Layout = (ctx.layout && isHeroVariant(ctx.layout.hero)) ? ctx.layout : DEFAULT_LAYOUT;
  const t = (spec && spec.brand && spec.brand.tokens) || {};
  // FIGMA → REALITY: an external design's PALETTE feeds the SAME contrast-guaranteed derivation as the
  // theme (never a blind CSS append) — a design that sets only a dark bg still gets legible text and
  // button labels, re-derived here. A design text/accent that FAILS contrast is dropped for the safe
  // derived value. Fonts + radius (which don't affect legibility) are appended after. (audit 2026-07-05)
  const design = (spec && spec.brand && spec.brand.design) || null;
  const dp: any = (hasDesign(design) && design && design.palette) || {};
  const bg = isHex(dp.bg) ? dp.bg.trim() : (isHex(t.bg) ? t.bg.trim() : '#ffffff');
  const primary = isHex(dp.primary) ? dp.primary.trim() : (isHex(t.primary) ? t.primary.trim() : '#4f46e5');
  // The brief roots the visual identity: a deterministic THEME owns typography, rhythm and shape.
  const theme = themeFor(ctx.theme, '');
  const tf = themeFonts(theme);
  // GUARANTEE legibility deterministically (no guessing): derive the whole palette from bg + primary,
  // preferring a design-supplied colour ONLY when it clears the contrast bar.
  const text = (isHex(dp.text) && contrast(dp.text, bg) >= 4.5) ? dp.text.trim()
    : (isHex(t.text) && contrast(t.text, bg) >= 4.5) ? t.text.trim() : pickOn(bg);
  const onPrimary = pickOn(primary);
  const accent = (isHex(dp.accent) && contrast(dp.accent, bg) >= 3) ? dp.accent.trim()
    : (isHex(t.accent) && contrast(t.accent, bg) >= 3) ? t.accent.trim() : primary;
  const surface = isHex(dp.surface) ? dp.surface.trim() : (isHex(t.surface) ? t.surface.trim() : mix(text, bg, 0.96));
  const dTypeVars = hasDesign(design) ? designTypeVars(design) : '';   // fonts + radius only (palette is derived above)
  const dFontLink = fontLink(design);
  const vars = `:root{` +
    `--primary:${primary};--on-primary:${onPrimary};--accent:${accent};--bg:${bg};` +
    `--surface:${surface};--text:${text};` +
    `--muted:${mix(text, bg, 0.42)};--line:${mix(text, bg, 0.86)};` +
    `--font-display:'${tf.display}';--font-body:'${tf.body}';${themeVars(theme)}${dTypeVars ? ';' + dTypeVars : ''}}`;

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
  // an "action" page is the natural destination for a CTA that has no exact match — a real place to
  // DO something, never silently "home". Order = intent priority.
  const actionPage = findPage(/contact|touch|reach|enquir|quote/) || findPage(/book|reserv|appointment|schedul/)
    || findPage(/order|checkout|cart|buy/) || findPage(/sign|join|start|register|apply|account/)
    || findPage(/shop|store|product|catalog|menu/) || findPage(/pric|plan/);
  const resolveCta = (raw: any, text: any): string => {
    let target: string | null = null;
    if (raw) { const r = String(raw).replace(/\.html$/, ''); if (pgs.some((p: any) => p.slug === r)) target = r; }
    if (!target) { const t = String(text || '').toLowerCase(); for (const [tr, sr] of CTA_GROUPS) if (tr.test(t)) { const p = findPage(sr); if (p) { target = p.slug; break; } } }
    if (!target) target = (actionPage ? actionPage.slug : fallbackCta.replace(/\.html$/, ''));
    // NEVER a circular button: a CTA that resolves to the page it's ON is the "every button reloads
    // home" bug. Redirect to the best OTHER action page, else the first different page. On a genuine
    // one-page site (landing) an on-page anchor to the final CTA/form is the only sensible target.
    if (target === ctx.slug) {
      // the page that HOSTS the site's form keeps its own CTAs: "Book now" in the hero scrolls to
      // the form below, it never bounces the visitor to another page (the book-page-to-home class)
      if (ctx.formSlug && ctx.formSlug === ctx.slug) return onPageAnchor;
      const other = (actionPage && actionPage.slug !== ctx.slug ? actionPage : pgs.find((p: any) => p.slug !== ctx.slug));
      if (other) target = other.slug;
      else return onPageAnchor;   // single-page site: jump to the real conversion section, never a reload
    }
    // FS0: the page carrying the site's form is a CONVERSION destination — land the visitor AT the
    // form. This also makes "every button routes to home" honest when home genuinely hosts the form.
    if (ctx.formSlug && target === ctx.formSlug && target !== ctx.slug) return target + '.html#contact-form';
    return target + '.html';
  };
  // single-page (landing) sites have no other page to link to — a CTA must anchor to the real
  // conversion section that exists on THIS page: the form, else the offer, else the final CTA band.
  const secTypes = new Set(((spec && spec.sections) || []).map((s: any) => String(s && s.type)));
  const onPageAnchor = secTypes.has('form') ? '#contact-form' : secTypes.has('offer') ? '#offer' : secTypes.has('cta') ? '#get-started' : '#';
  const link = (raw: any, text: any) => resolveCta(raw, text);
  const loc = isLocale(ctx.locale) ? ctx.locale : 'en';
  // ARC F: pass sectionModes from the chosen Layout to section renderers so features/testimonials/stats
  // can each vary their structure independently of the hero (different hash seed per section type).
  // Old Layout objects that lack sectionModes will have undefined here → renderers fall back to the
  // classic default mode (grid / grid / row), so no produced site ever breaks on a schema addition.
  const sections = ((spec && spec.sections) || []).map((s: any) => (SECTIONS[s.type] || (() => ''))(s, { link, forms: ctx.forms, primaryTable: (ctx as any).primaryTable, hero: lay.hero, locale: loc, sectionModes: lay.sectionModes })).join('\n');
  const desc = metaDescription(spec);
  // STRUCTURED DATA (schema.org): the home page carries Organization/LocalBusiness + WebSite; a product
  // page carries Product (name/price/availability); inner pages carry a breadcrumb. Deterministic.
  const isHome = /^index$/i.test(ctx.slug) || (ctx.pages && ctx.pages[0] && ctx.slug === ctx.pages[0].slug);
  const ld: any[] = [];
  if (isHome) {
    // Use the pre-computed bizType (most-specific schema.org @type: Restaurant, Dentist, HairSalon, …)
    // when provided; fall back to the old boolean flag for back-compat with existing tests/live renders
    // that haven't migrated to bizType yet.
    const bt = ctx.bizType || (ctx.localBusiness ? 'LocalBusiness' : 'Organization');
    // ARC G: extract telephone/email/address/openingHours from the page spec's brand + sections.
    // extractBusinessFacts() expects a site-model-shaped object; we build a lightweight proxy from
    // what renderPage already has — brand fields (spec.brand) + this page's sections — which covers
    // the data the home page carries (contact info is almost always on the home page or in the brand).
    const facts = extractBusinessFacts({ brand: spec && spec.brand, pages: [{ sections: (spec && spec.sections) || [] }] });
    ld.push(organizationLd({ name: brand, base: ctx.siteBase, logo: 'icon-512.png', bizType: bt, ...facts }));
    ld.push(websiteLd({ name: brand, base: ctx.siteBase }));
  }
  const prodSec = ((spec && spec.sections) || []).find((s: any) => s && s.type === 'product' && s.row && typeof s.row === 'object');
  if (prodSec) {
    const r = prodSec.row;
    const img = Object.keys(r).find((k) => /image|photo|picture|cover|thumb/i.test(k) && typeof r[k] === 'string' && (/^https?:/.test(r[k]) || String(r[k]).startsWith('/')));
    const pk = Object.keys(r).find((k) => /^(price|amount|cost)$/i.test(k));
    ld.push(productLd({ name: String(r.title || r.name || ctx.title), description: r.description || r.body, image: img ? r[img] : undefined, price: pk ? r[pk] : undefined, currency: (loc && loc !== 'en') ? 'EUR' : 'USD', inStock: typeof r.stock === 'number' ? r.stock > 0 : undefined, base: ctx.siteBase, brandName: brand }));
  }
  const artSec = ((spec && spec.sections) || []).find((s: any) => s && s.type === 'article' && s.row && typeof s.row === 'object');
  if (artSec) {
    const r = artSec.row;
    const img = Object.keys(r).find((k) => /image|photo|cover|picture|thumb/i.test(k) && typeof r[k] === 'string' && (/^https?:/.test(r[k]) || String(r[k]).startsWith('/')));
    const bodyKey = ['excerpt', 'summary', 'body', 'content', 'text'].find((k) => typeof r[k] === 'string' && r[k].trim());
    const author = ['author', 'author_name', 'byline', 'writer'].map((k) => r[k]).find((v) => typeof v === 'string' && v.trim());
    ld.push(articleLd({ headline: String(r.title || r.name || r.headline || ctx.title), image: img ? r[img] : undefined, datePublished: r.published_at || r.date || r.created_at, author: author as string, description: bodyKey ? r[bodyKey] : undefined, base: ctx.siteBase, url: ctx.slug + '.html', publisher: brand }));
  }
  // ARC G: FAQ schema — when this page has a 'faq' section with items, emit a FAQPage block.
  // Only emitted on pages that HAVE a faq section; Google indexes the Q&A for "People also ask".
  const faqSec = ((spec && spec.sections) || []).find((s: any) => s && s.type === 'faq' && Array.isArray(s.items));
  if (faqSec) {
    const faqLd = faqPageLd(faqSec.items);
    if (faqLd) ld.push(faqLd);
  }
  const bc = breadcrumbLd({ pages: ctx.pages || [], slug: ctx.slug, title: ctx.title, base: ctx.siteBase });
  if (bc && !isHome) ld.push(bc);
  const ldBlock = ldScript(ld);
  // CANONICAL URL: every page should declare its own canonical href when the public base is known
  // (the <slug>.naples.agency wildcard). This prevents duplicate-content issues when a page is
  // served both from the static file path and from the live CMS path.
  // Omit cleanly (no empty href="") when siteBase is unknown (dev/fixture renders).
  const canonicalHref = ctx.siteBase
    ? `${ctx.siteBase.replace(/\/+$/, '')}/${ctx.slug === 'index' ? '' : ctx.slug + '.html'}`
    : null;
  // og:image should be an ABSOLUTE URL so social cards resolve it. If we have a public base, use it.
  const ogImage = ctx.siteBase ? `${ctx.siteBase.replace(/\/+$/, '')}/icon-512.png` : 'icon-512.png';
  // ARC C: The static DS CSS (font-faces + layout rules) lives in an external file named by content-hash.
  // renderPage derives the href deterministically (same hash fn, same text) so every caller agrees on
  // the filename without any I/O — runner.ts writes the file separately.
  const dsHash = dsCssHash(DS_CSS_BODY);
  const dsHref = `assets/ds-${dsHash}.css`;
  const html = `<!doctype html><html lang="${loc}"><head><!--relay:rendered--><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ctx.title)}${brand ? ' — ' + esc(brand) : ''}</title>
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="${primary}">
<link rel="apple-touch-icon" href="icon-192.png">${dFontLink ? '\n' + dFontLink : ''}
${canonicalHref ? `<link rel="canonical" href="${esc(canonicalHref)}">` : ''}
${desc ? `\n<meta name="description" content="${esc(desc)}">` : ''}
<meta property="og:title" content="${esc(ctx.title)}${brand ? ' — ' + esc(brand) : ''}">
${desc ? `<meta property="og:description" content="${esc(desc)}">` : ''}
<meta property="og:image" content="${esc(ogImage)}">${ldBlock ? '\n' + ldBlock : ''}
<style>${vars}</style>
<link rel="stylesheet" href="${dsHref}"></head>
<body class="t-${theme} l-hero-${lay.hero} l-cards-${isCardVariant(lay.cards) ? lay.cards : 'photo'}${lay.band ? ' l-band' : ''}">
${(() => { const nc = ctaParts(spec && spec.brand && spec.brand.cta, spec && spec.brand && spec.brand.ctaLink); return navBar(brand, ctx.pages, ctx.slug, nc?.text, nc ? resolveCta(nc.link, nc.text) : '#', lay.nav, loc); })()}
<main>
${sections}
</main>
${footer(brand, ctx.pages, !!ctx.accountLinks, loc)}
<script>window.RELAY_PID=${JSON.stringify(ctx.projectId || '')};window.RELAY_T=${JSON.stringify(clientDict(loc))};
/* PWA: register the offline shell — only over http(s); the file:// gates render without it */
if('serviceWorker' in navigator&&/^https?:$/.test(location.protocol)){navigator.serviceWorker.register('sw.js').catch(function(){})}
function relaySubmit(e){e.preventDefault();var f=e.target,d={};new FormData(f).forEach(function(v,k){d[k]=v});var m=f.querySelector('.rform-msg'),b=f.querySelector('button');if(b)b.disabled=true;var tbl=f.getAttribute('data-table');var url=tbl?('/api/site/'+window.RELAY_PID+'/data/'+encodeURIComponent(tbl)):('/api/site/'+window.RELAY_PID+'/submit');fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({form:f.dataset.form,data:d})}).then(function(r){return r.json().catch(function(){throw 0})}).then(function(res){if(!res||res.ok!==true)throw (res&&res.error)||0;if(res&&res.ref&&res.table){window.location.href='receipt-'+res.table+'-'+res.ref+'.html';return}f.reset();if(m){m.hidden=false;m.textContent=tbl?RELAY_T.added_ok:RELAY_T.thanks_msg}if(tbl&&window.__relayLoad)window.__relayLoad();}).catch(function(err){if(m){m.hidden=false;m.textContent=(typeof err==='string'&&err)?err:RELAY_T.error_retry}}).finally(function(){if(b)b.disabled=false});return false}
/* FS1: find-my-booking — resolve a pasted reference code to its receipt page; or mail the links (no enumeration). */
window.relayFindCode=function(e){e.preventDefault();var f=e.target,m=f.querySelector('.rform-msg');var code=String((new FormData(f)).get('code')||'').trim();if(!code)return false;fetch('/api/site/'+window.RELAY_PID+'/receipt/'+encodeURIComponent(code)).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){if(d&&d.page){window.location.href=d.page}else throw 0}).catch(function(){if(m){m.hidden=false;m.textContent=RELAY_T.no_receipt_code}});return false};
window.relayVisitorRequest=function(e){e.preventDefault();var f=e.target,m=f.querySelector('.rform-msg'),b=f.querySelector('button');var em=(new FormData(f)).get('email');if(b)b.disabled=true;fetch('/api/site/'+window.RELAY_PID+'/visitor/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:em})}).then(function(r){return r.json()}).then(function(){f.reset();if(m){m.hidden=false;m.textContent=RELAY_T.check_inbox}}).catch(function(){if(m){m.hidden=false;m.textContent=RELAY_T.generic_error}}).finally(function(){if(b)b.disabled=false});return false};
window.relayVisitorLogout=function(){fetch('/api/site/'+window.RELAY_PID+'/visitor/logout',{method:'POST'}).then(function(){window.location.href='account.html'}).catch(function(){window.location.href='account.html'})};
/* LIFECYCLE: visitor self-cancels their booking from the receipt — the server re-enforces the cancellation window. */
window.relayCancel=function(btn,tbl,ref,thing){var box=btn.parentNode,m=box.querySelector('.rform-msg');var fill=function(s){return String(s||'').split('{x}').join(thing)};if(!window.confirm(fill(RELAY_T.cancel_confirm_q)))return;btn.disabled=true;fetch('/api/site/'+window.RELAY_PID+'/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({table:tbl,ref:ref})}).then(function(r){return r.json()}).then(function(res){if(res&&res.ok){btn.remove();if(m){m.hidden=false;m.textContent=fill(res.error==='already'?RELAY_T.cancel_already:RELAY_T.cancel_done)}}else{var k=(res&&res.error==='too_late')?'cancel_closed':'cancel_failed';if(m){m.hidden=false;m.textContent=fill(RELAY_T[k]||RELAY_T.cancel_failed)}btn.disabled=false}}).catch(function(){if(m){m.hidden=false;m.textContent=fill(RELAY_T.cancel_failed)}btn.disabled=false});};
window.relayFindMail=function(e){e.preventDefault();var f=e.target,m=f.querySelector('.rform-msg'),b=f.querySelector('button');var em=(new FormData(f)).get('email');if(b)b.disabled=true;fetch('/api/site/'+window.RELAY_PID+'/receipt-mail',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:em})}).then(function(r){return r.json()}).then(function(){f.reset();if(m){m.hidden=false;m.textContent=RELAY_T.links_on_way}}).catch(function(){if(m){m.hidden=false;m.textContent=RELAY_T.generic_error}}).finally(function(){if(b)b.disabled=false});return false};
/* SEARCH: a grid with >=8 loaded rows gets a filter box — pure client, textContent only */
function __searchbox(el,count){if(count<8||el.__hasSearch||!el.parentNode)return;el.__hasSearch=1;var w=document.createElement('input');w.type='search';w.placeholder=RELAY_T.search_ph;w.className='grid-search';w.setAttribute('aria-label',RELAY_T.search_aria);w.oninput=function(){var q=w.value.toLowerCase().trim();Array.prototype.forEach.call(el.children,function(c){c.style.display=!q||(c.textContent||'').toLowerCase().indexOf(q)>=0?'':'none'})};el.parentNode.insertBefore(w,el)}
/* live read paths: .feed reads form submissions, .collection reads a real DB table. Both no-op under
   file:// (the gate) and populate over HTTP. textContent ONLY — server data is never injected as HTML. */
function __rcards(el,items,tbl){if(!items||!items.length)return;var BLOG=/^(posts|articles|news|stories|guides|recipes)$/i;var blog=tbl&&BLOG.test(tbl);var SVC=/service|practice|treatment|package|course|plan|session|offering|consult|menu|dish|drink|beverage/i;var svc=!blog&&tbl&&SVC.test(tbl);el.innerHTML='';var IMG=/image|photo|avatar|cover|logo|thumb|picture|banner/i,MONEY=/price|amount|cost|total|fee|budget|salary|rate/i;var NOISE=function(s){return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(s)||/^#?\\d+(\\.\\d+)?$/.test(s)};var ISOD=/^\\d{4}-\\d{2}-\\d{2}T/;items.slice(0,12).forEach(function(o){o=o||{};var keys=Object.keys(o).filter(function(k){return['id','created_at','password_hash','password'].indexOf(k)<0&&o[k]!=null&&o[k]!==''});var tk=['name','title','business','listing','label'].filter(function(k){return o[k]})[0]||keys.filter(function(k){return !NOISE(String(o[k]))&&!ISOD.test(String(o[k]))})[0]||keys[0];var card=document.createElement('div');card.className='card';var moneyLast=[];var imgk=keys.filter(function(k){return IMG.test(k)&&typeof o[k]==='string'&&(/^https?:/.test(o[k])||o[k].charAt(0)==='/')})[0];var phref=(blog&&/^\d+$/.test(String(o.id)))?('post-'+o.id+'.html'):null;if(imgk){var im=document.createElement('img');im.src=o[imgk];im.alt='';im.loading='lazy';im.style.cssText='width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:var(--radius);margin-bottom:12px';im.onerror=function(){im.remove()};if(phref){var pa=document.createElement('a');pa.href=phref;pa.appendChild(im);card.appendChild(pa)}else card.appendChild(im);card.classList.add('has-img');}if(tk){var h=document.createElement('h3');if(phref){var ta=document.createElement('a');ta.href=phref;ta.textContent=String(o[tk]);ta.style.cssText='color:inherit;text-decoration:none';h.appendChild(ta)}else h.textContent=String(o[tk]);card.appendChild(h);}keys.filter(function(k){return k!==tk&&k!==imgk&&!(blog&&/^(body|content|text|article|full_text)$/.test(k))}).slice(0,6).forEach(function(k){var v=o[k],p=document.createElement('p');if(typeof v==='boolean'){if(!v||svc||blog||/active|enabled|visible|published/.test(k))return;p.textContent='✓ '+k.replace(/_/g,' ');}else if(MONEY.test(k)&&!isNaN(parseFloat(v))){var mv=parseFloat(v);if(svc){if(mv>0)moneyLast.push(RELAY_T.from_price+__moneyS(mv));return}p.textContent=__money(mv);p.style.fontWeight='600';}else{var s=String(v);if(ISOD.test(s))p.textContent=new Date(s).toDateString();else if(NOISE(s))return;else p.textContent=s.slice(0,180);}card.appendChild(p);});moneyLast.forEach(function(t){var mp=document.createElement('p');mp.textContent=t;mp.style.cssText='color:var(--muted);font-size:.95rem;margin-top:.4rem';card.appendChild(mp)});el.appendChild(card);});__searchbox(el,items.length);}
window.__relayLoad=function(){var pid=window.RELAY_PID;if(!pid)return;
Array.prototype.forEach.call(document.querySelectorAll('.feed[data-feed]'),function(el){fetch('/api/submissions?id='+encodeURIComponent(pid)+'&form='+encodeURIComponent(el.getAttribute('data-feed'))).then(function(r){return r.json()}).then(function(d){__rcards(el,((d&&d.submissions)||[]).map(function(s){return s.data||{}}))}).catch(function(){})});
Array.prototype.forEach.call(document.querySelectorAll('.collection[data-table]'),function(el){var tbl=el.getAttribute('data-table');fetch('/api/site/'+encodeURIComponent(pid)+'/data/'+encodeURIComponent(tbl)).then(function(r){return r.json()}).then(function(d){__rcards(el,(d&&d.rows)||[],tbl)}).catch(function(){})});
/* PQ2: shop grid — real products from the DB, each with Add-to-cart (client cart; order priced server-side).
   PDP: on the real products table, image + title link to the product's own live page (product-<id>.html). */
Array.prototype.forEach.call(document.querySelectorAll('.products[data-products]'),function(el){var tbl=el.getAttribute('data-products');fetch('/api/site/'+encodeURIComponent(pid)+'/data/'+encodeURIComponent(tbl)).then(function(r){return r.json()}).then(function(d){var rows=((d&&d.rows)||[]).filter(function(o){return o&&o.id!=null});if(!rows.length)return;el.innerHTML='';var IMG=/image|photo|picture|thumb/i;rows.slice(0,24).forEach(function(o){var card=document.createElement('div');card.className='card';var keys=Object.keys(o);var dhref=(tbl==='products'&&/^\\d+$/.test(String(o.id)))?('product-'+o.id+'.html'):null;var imgk=keys.filter(function(k){return IMG.test(k)&&typeof o[k]==='string'&&(/^https?:/.test(o[k])||o[k].charAt(0)==='/')})[0];if(imgk){var im=document.createElement('img');im.src=o[imgk];im.alt='';im.loading='lazy';im.style.cssText='width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--radius);margin-bottom:12px';im.onerror=function(){im.remove()};if(dhref){var la=document.createElement('a');la.className='p-imglink';la.href=dhref;la.appendChild(im);card.appendChild(la)}else card.appendChild(im);card.classList.add('has-img')}var title=String(o.title||o.name||('#'+o.id));var h=document.createElement('h3');if(dhref){var ta=document.createElement('a');ta.href=dhref;ta.textContent=title;h.appendChild(ta)}else h.textContent=title;card.appendChild(h);var pk=keys.filter(function(k){return /^(price|amount|cost)$/.test(k)})[0];var price=pk?parseFloat(o[pk]):NaN;if(isFinite(price)){var pr=document.createElement('div');pr.className='p-price';pr.textContent=__money(price);card.appendChild(pr)}var desc=String(o.description||o.body||'').slice(0,120);if(desc){var dp=document.createElement('p');dp.textContent=desc;card.appendChild(dp)}if(isFinite(price)){if(o._variants>0&&dhref){var ch=document.createElement('a');ch.className='btn p-choose';ch.href=dhref;ch.textContent=RELAY_T.choose_options;card.appendChild(ch)}else{var stk=typeof o.stock==='number'?o.stock:null;if(stk!==null&&stk>=1&&stk<=5){var sl=document.createElement('p');sl.className='muted';sl.textContent=RELAY_T.only_n_left.replace('{n}',stk);card.appendChild(sl)}var add=document.createElement('button');add.type='button';if(stk===0){add.className='btn p-add p-soldout';add.textContent=RELAY_T.sold_out;add.disabled=true}else{add.className='btn p-add';add.textContent=RELAY_T.add_to_cart;add.onclick=function(){window.relayCartAdd({id:o.id,title:title,price:price},add)}}card.appendChild(add)}}el.appendChild(card)});__searchbox(el,rows.length)}).catch(function(){})});
__cartRender();
/* PAYMENTS v1: the checkout's payment box — the store's ACTIVE payment options, read live
   from the owner-editable payment_options table. Empty/unreachable → the box stays hidden. */
Array.prototype.forEach.call(document.querySelectorAll('[data-payopts]'),function(el){fetch('/api/site/'+window.RELAY_PID+'/data/payment_options').then(function(r){return r.json()}).then(function(d){var rows=((d&&d.rows)||[]).filter(function(o){return o&&o.name&&o.active!==false});if(!rows.length)return;rows.slice(0,6).forEach(function(o){var c=document.createElement('div');c.className='payopt';var h=document.createElement('b');h.textContent=String(o.name).slice(0,80);c.appendChild(h);if(o.details){var p=document.createElement('p');p.textContent=String(o.details).slice(0,300);c.appendChild(p)}el.appendChild(c)});el.hidden=false}).catch(function(){})});
/* FS5: slot picker — free times for the chosen date (and chosen resource), tappable. The hidden input
   carries the real timestamp; if the slots API is unreachable the picker degrades to a plain date field. */
Array.prototype.forEach.call(document.querySelectorAll('.slotchips[data-slots]'),function(box){var form=box.closest('form');if(!form)return;var tbl=box.getAttribute('data-slots');var fld=box.getAttribute('data-field');var dateEl=form.querySelector('input[data-slotdate="'+fld+'"]');var hid=form.querySelector('input[data-slot="'+fld+'"]');if(!dateEl||!hid)return;if(!dateEl.value){var d=new Date(Date.now()+86400000);dateEl.value=d.toISOString().slice(0,10);}function load(){var qs='date='+encodeURIComponent(dateEl.value);Array.prototype.forEach.call(form.querySelectorAll('select[data-ref]'),function(s){if(s.name&&s.value)qs+='&'+encodeURIComponent(s.name)+'='+encodeURIComponent(s.value)});fetch('/api/site/'+window.RELAY_PID+'/slots/'+encodeURIComponent(tbl)+'?'+qs).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){var slots=(d&&d.slots)||[];box.innerHTML='';slots.forEach(function(s){var b=document.createElement('button');b.type='button';b.textContent=s.t;if(!s.free)b.disabled=true;else b.onclick=function(){hid.value=dateEl.value+'T'+s.t+':00';Array.prototype.forEach.call(box.querySelectorAll('button'),function(x){x.classList.remove('on')});b.classList.add('on')};box.appendChild(b)});if(!slots.length){var m=document.createElement('span');m.className='muted';m.textContent=RELAY_T.no_times;box.appendChild(m)}}).catch(function(){hid.removeAttribute('name');dateEl.name=fld;box.remove()})}dateEl.addEventListener('change',function(){hid.value='';load()});Array.prototype.forEach.call(form.querySelectorAll('select[data-ref]'),function(s){s.addEventListener('change',function(){hid.value='';load()})});load()});
/* M2: relation dropdowns — a select[data-ref] fills with the referenced table's REAL records (value=id, label=display column). textContent only. */
Array.prototype.forEach.call(document.querySelectorAll('select[data-ref]'),function(el){fetch('/api/site/'+encodeURIComponent(pid)+'/data/'+encodeURIComponent(el.getAttribute('data-ref'))).then(function(r){return r.json()}).then(function(d){var rows=((d&&d.rows)||[]).filter(function(o){return o&&o.id!=null}).sort(function(a,b){return(a.id||0)-(b.id||0)});if(!rows.length)return;while(el.options.length>1)el.remove(1);var dc=el.getAttribute('data-display');rows.slice(0,100).forEach(function(o){var op=document.createElement('option');op.value=o.id;op.textContent=String((dc&&o[dc]!=null)?o[dc]:(o.name||o.title||('#'+o.id)));el.appendChild(op)})}).catch(function(){})});};
/* PQ2: client cart (localStorage, per site). Prices here are DISPLAY ONLY — the server recomputes the
   order total from the database and snapshots unit prices; a tampered client cannot change what is charged. */
function __cart(){try{return JSON.parse(localStorage.getItem('relay_cart_'+window.RELAY_PID)||'[]')}catch(e){return[]}}
function __cartSave(c){try{localStorage.setItem('relay_cart_'+window.RELAY_PID,JSON.stringify(c))}catch(e){}__cartRender()}
function __money(n){var v=(Math.round(n*100)/100).toFixed(2);return RELAY_T.meur?v.replace('.',',')+' €':'$'+v}
function __moneyS(n){return RELAY_T.meur?(n%1?n.toFixed(2).replace('.',','):n.toFixed(0))+' €':'$'+(n%1?n.toFixed(2):n.toFixed(0))}
window.relayCartAdd=function(p,btn){var c=__cart();var f=null;for(var i=0;i<c.length;i++)if(c[i].id===p.id&&(c[i].variant||null)===(p.variant||null))f=c[i];if(f)f.qty=Math.min(99,f.qty+1);else c.push({id:p.id,title:p.title,price:p.price,qty:1,variant:p.variant||null});__cartSave(c);if(btn){var t=btn.textContent;btn.textContent=RELAY_T.added_ok;setTimeout(function(){btn.textContent=t},1200)}};
/* PQ2: variant pills — pick an option, then Add carries it (title shows "Tee — XL"; price display-only, the server re-prices) */
window.relayVarPick=function(b){var box=b.closest('.varpick');if(!box)return;Array.prototype.forEach.call(box.querySelectorAll('.varpill'),function(x){x.classList.remove('on')});b.classList.add('on');var m=(box.parentElement||document).querySelector('.varmsg');if(m)m.hidden=true};
window.relayCartAddVariant=function(btn,p){var root=btn.closest('.pdp-info')||document;var sel=root.querySelector('.varpick .varpill.on');var m=root.querySelector('.varmsg');if(!sel){if(m){m.hidden=false;m.textContent=RELAY_T.pick_option}return}var vp=sel.getAttribute('data-vprice');var price=(vp!==null&&vp!=='')?parseFloat(vp):p.price;window.relayCartAdd({id:p.id,title:p.title+' — '+(sel.getAttribute('data-vname')||''),price:price,variant:Number(sel.getAttribute('data-vid'))},btn)};
function __cartRender(){Array.prototype.forEach.call(document.querySelectorAll('[data-cart]'),function(el){var c=__cart();el.innerHTML='';if(!c.length){var e=document.createElement('p');e.className='cart-empty';e.textContent=RELAY_T.cart_empty;el.appendChild(e);return}var full=el.getAttribute('data-cart')==='full';var tot=0;c.forEach(function(it,i){tot+=it.price*it.qty;var ln=document.createElement('div');ln.className='cart-line';var t=document.createElement('span');t.className='cl-title';t.textContent=it.title;ln.appendChild(t);if(full){var q=document.createElement('span');q.className='cart-qty';var m=document.createElement('button');m.type='button';m.textContent='−';m.onclick=function(){var c2=__cart();c2[i].qty=Math.max(1,c2[i].qty-1);__cartSave(c2)};var n=document.createElement('span');n.textContent=String(it.qty);var pl=document.createElement('button');pl.type='button';pl.textContent='+';pl.onclick=function(){var c2=__cart();c2[i].qty=Math.min(99,c2[i].qty+1);__cartSave(c2)};q.appendChild(m);q.appendChild(n);q.appendChild(pl);ln.appendChild(q);var rm=document.createElement('button');rm.type='button';rm.className='cart-remove';rm.setAttribute('aria-label',RELAY_T.remove);rm.textContent='✕';rm.onclick=function(){var c2=__cart();c2.splice(i,1);__cartSave(c2)};ln.appendChild(rm)}else{var qn=document.createElement('span');qn.className='muted';qn.textContent='× '+it.qty;ln.appendChild(qn)}var lp=document.createElement('span');lp.textContent=__money(it.price*it.qty);ln.appendChild(lp);el.appendChild(ln)});var tl=document.createElement('div');tl.className='cart-total';var a=document.createElement('span');a.textContent=RELAY_T.total;var b2=document.createElement('span');b2.textContent=__money(tot);tl.appendChild(a);tl.appendChild(b2);el.appendChild(tl);if(full){var act=document.createElement('div');act.className='cart-actions';var go=document.createElement('a');go.className='btn';go.href='checkout.html';go.textContent=RELAY_T.proceed_checkout;act.appendChild(go);el.appendChild(act)}})}
window.relayCheckout=function(e){e.preventDefault();var f=e.target,m=f.querySelector('.rform-msg'),b=f.querySelector('button');var c=__cart();var items=[];for(var i=0;i<c.length;i++){var ln={id:c[i].id,qty:c[i].qty};if(c[i].variant)ln.variant=c[i].variant;items.push(ln)}if(!items.length){if(m){m.hidden=false;m.textContent=RELAY_T.cart_empty_add}return false}var buyer={};new FormData(f).forEach(function(v,k){buyer[k]=v});if(b)b.disabled=true;fetch('/api/site/'+window.RELAY_PID+'/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({buyer:buyer,items:items})}).then(function(r){return r.json()}).then(function(res){if(!res||!res.ok)throw (res&&res.error)||0;try{localStorage.removeItem('relay_cart_'+window.RELAY_PID)}catch(e2){}__cartRender();f.reset();if(res.ref){window.location.href='receipt-orders-'+res.ref+'.html';return}if(m){m.hidden=false;m.textContent=RELAY_T.order_placed+res.order+RELAY_T.total_sep+__money(res.total)}}).catch(function(err){if(m){m.hidden=false;m.textContent=(typeof err==='string'&&err)?err:RELAY_T.generic_error}}).finally(function(){if(b)b.disabled=false});return false};
window.__relayLoad();</script>
</body></html>`;
  // FORCE the ONE business name: the model writes the literal token {{brand}} wherever the name appears in
  // copy (it is never allowed to write a name); the system substitutes the single locked brand here. This is
  // what makes the brand name in BODY COPY system-owned, not an LLM choice — identical on every page.
  return html
    .replace(/\{\{\s*brand\s*\}\}/gi, esc(brand))   // the ONE name, filled deterministically
    .replace(/\{\{[^}]*\}\}/g, esc(brand));          // defensive: any stray token also becomes the brand (never ship a raw token)
}

// The SKELETON — hand-built, responsive, accessible, token-driven section components.
// The LLM never writes these; it only chooses sections + copy + brand tokens. Structure can't be wrong.
import { FONT_FACES } from './fonts.ts';

export const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
const q = (query: string, cls = '') => `<img data-q="${esc(query)}" alt="" class="${cls}" loading="lazy">`;
const humanize = (s: string) => String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// Design-system CSS. Responsive, CSS-only hamburger (no JS), fixed spacing/type scale. Inlined per page.
export const DS_CSS = FONT_FACES + `
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font-family:var(--font-body),system-ui,-apple-system,sans-serif;font-size:var(--body-size,1rem);color:var(--text);background:var(--bg);line-height:var(--body-leading,1.6);-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}a{color:inherit}
h1,h2,h3{font-family:var(--font-display),system-ui,sans-serif;font-weight:var(--display-weight,700);line-height:var(--display-leading,1.08);letter-spacing:var(--display-tracking,-.02em);margin:0 0 .4em;color:var(--text)}
h1{font-size:var(--h1,clamp(2.3rem,6vw,4.2rem))}h2{font-size:var(--h2,clamp(1.7rem,4vw,2.7rem))}h3{font-size:var(--h3,1.25rem)}
p{margin:0 0 1rem}
.container{width:100%;max-width:var(--container,1140px);margin:0 auto;padding:0 24px}
.section{padding:var(--section-y,clamp(52px,8vw,108px)) 0}
.eyebrow{display:inline-block;font-size:.78rem;font-weight:var(--eyebrow-weight,700);letter-spacing:var(--eyebrow-tracking,.1em);text-transform:var(--eyebrow-transform,uppercase);color:var(--accent);margin-bottom:1rem}
.muted{color:var(--muted)}.lead{font-size:1.18rem;max-width:56ch}
.btn{display:inline-flex;align-items:center;gap:.5rem;background:var(--primary);color:var(--on-primary);font-weight:600;padding:.85rem 1.6rem;border-radius:var(--btn-radius,var(--radius));text-decoration:none;border:0;cursor:pointer;transition:filter .15s;font-family:inherit;font-size:1rem}
.btn:hover{filter:brightness(1.07)}
/* nav — CSS-only hamburger via checkbox */
.nav{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--bg) 80%,transparent);backdrop-filter:blur(10px);border-bottom:var(--border-w,1px) solid var(--line)}
.nav-inner{display:flex;align-items:center;gap:20px;max-width:var(--container,1140px);margin:0 auto;padding:14px 24px;position:relative}
.nav-brand{font-family:var(--font-display);font-weight:700;font-size:1.3rem;text-decoration:none;color:var(--text)}
.nav-links{display:flex;align-items:center;gap:4px;margin-left:auto;list-style:none;padding:0;margin-top:0;margin-bottom:0}
.nav-links a{text-decoration:none;color:var(--muted);font-weight:500;font-size:.95rem;padding:.45rem .75rem;border-radius:8px}
.nav-links a:hover,.nav-links a[aria-current]{color:var(--text);background:color-mix(in srgb,var(--text) 7%,transparent)}
.nav-links .btn{color:var(--on-primary);margin-left:6px}
.nav-toggle{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.nav-burger{display:none;margin-left:auto;font-size:1.7rem;line-height:1;cursor:pointer;user-select:none;padding:.1rem .4rem;color:var(--text)}
@media(max-width:760px){
  .nav-burger{display:block}
  .nav-links{display:none;position:absolute;top:100%;left:0;right:0;margin:0;flex-direction:column;align-items:stretch;gap:2px;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px 16px;box-shadow:0 14px 34px -16px rgba(0,0,0,.35)}
  .nav-toggle:checked~.nav-links{display:flex}
  .nav-links a{padding:.7rem .6rem;font-size:1.02rem}.nav-links .btn{margin:.4rem 0 0;justify-content:center}
}
/* hero */
.hero{position:relative;overflow:hidden}
.hero-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
.hero-overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.34),rgba(0,0,0,.58));z-index:1}
.hero .container{position:relative;z-index:2}
.hero.on-image,.hero.on-image h1{color:#fff}.hero.on-image .lead{color:rgba(255,255,255,.92)}.hero.on-image .eyebrow{color:#fff;opacity:.9}
.hero-inner{max-width:720px;padding:clamp(84px,14vw,184px) 0}
.hero .lead{margin:1rem 0 2rem}.hero .btn{font-size:1.05rem}
/* grids */
.grid{display:grid;gap:24px}.grid-3{grid-template-columns:repeat(3,1fr)}
@media(max-width:880px){.grid-3{grid-template-columns:1fr 1fr}}@media(max-width:560px){.grid-3{grid-template-columns:1fr}}
.card{background:var(--surface);border:var(--border-w,1px) solid var(--line);border-radius:var(--radius);padding:28px}
.card h3{margin-bottom:.35em}.card p{color:var(--muted);margin:0}
/* split */
.split{display:grid;grid-template-columns:1fr 1fr;gap:clamp(28px,5vw,64px);align-items:center}
.split.rev .split-media{order:2}
@media(max-width:760px){.split{grid-template-columns:1fr}.split.rev .split-media{order:0}}
.split-media img{width:100%;border-radius:var(--radius);aspect-ratio:4/3;object-fit:cover}
/* gallery */
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
@media(max-width:760px){.gallery{grid-template-columns:1fr 1fr}}
.gallery img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:var(--radius)}
/* cta */
.cta{background:var(--primary);color:var(--on-primary);border-radius:calc(var(--radius) + 6px);padding:clamp(44px,7vw,80px);text-align:center}
.cta h2{color:var(--on-primary)}.cta p{opacity:.92;max-width:48ch;margin:0 auto 1.6rem}.cta .btn{background:var(--bg);color:var(--text)}
/* footer */
.footer{border-top:var(--border-w,1px) solid var(--line);padding:44px 0;color:var(--muted)}
.footer-inner{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;align-items:center}
.footer-links a{color:var(--muted);text-decoration:none;margin-left:18px}.footer-links a:hover{color:var(--text)}
/* form (full-stack: posts to a real API -> Postgres) */
.formwrap{max-width:560px}
.rform{display:flex;flex-direction:column;gap:14px;margin-top:1.6rem}
.rform label{display:flex;flex-direction:column;gap:6px;font-size:.88rem;font-weight:600;color:var(--text)}
.rform input,.rform textarea{font:inherit;padding:.72rem .9rem;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);width:100%}
.rform input:focus,.rform textarea:focus{outline:0;border-color:var(--primary)}
.rform textarea{min-height:120px;resize:vertical}.rform .btn{align-self:flex-start}
.rform .rcheck{flex-direction:row;align-items:center;gap:8px;font-weight:500}.rform .rcheck input{width:auto}
.rform-msg{margin:.4rem 0 0;font-weight:600;color:var(--accent)}
/* pricing */
.price-amt{font-family:var(--font-display);font-size:2.2rem;font-weight:700;margin:.4rem 0}.price-amt span{font-size:1rem;color:var(--muted);font-weight:500}
.card.price.feat{border-color:var(--primary);border-width:2px}
.price-feats{list-style:none;padding:0;margin:1rem 0;display:grid;gap:.5rem}.price-feats li{color:var(--muted);padding-left:1.4rem;position:relative}.price-feats li:before{content:"✓";position:absolute;left:0;color:var(--accent);font-weight:700}
.card.price .btn{margin-top:.6rem;width:100%;justify-content:center}
/* testimonials */
.quote .qtext{font-size:1.05rem;margin:0 0 1rem;color:var(--text)}.quote .qby{display:flex;flex-direction:column;gap:2px}
/* faq accordion */
.faq-item{border-bottom:1px solid var(--line)}.faq-item summary{cursor:pointer;font-weight:600;padding:1rem 0;list-style:none}.faq-item summary::-webkit-details-marker{display:none}.faq-item summary:after{content:"+";float:right;color:var(--muted)}.faq-item[open] summary:after{content:"–"}.faq-item p{padding:0 0 1.1rem}
/* stats */
.stats{text-align:center}.stat-n{font-family:var(--font-display);font-size:clamp(2rem,5vw,2.8rem);font-weight:700;color:var(--primary);line-height:1}
@media(max-width:560px){.stats{grid-template-columns:1fr 1fr}}
/* ============================================================================
   LAYOUT VARIANTS (src/layout.ts) — STRUCTURE, chosen once per project. Body carries
   l-hero-<variant>; nav carries nav-<variant>; l-band alternates section surfaces. Each is
   responsive + uses the contrast-guaranteed palette, so no variant can be illegible or broken.
   ============================================================================ */
/* HERO · split — copy beside a framed photo (no overlay; text on --bg) */
.hero-split .hero-split-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:clamp(28px,5vw,72px);align-items:center;padding:clamp(56px,10vw,120px) 0}
.hero-split .hero-copy .lead{margin:1rem 0 2rem}
.hero-split .hero-media img{width:100%;aspect-ratio:5/4;object-fit:cover;border-radius:calc(var(--radius) + 6px)}
@media(max-width:840px){.hero-split .hero-split-grid{grid-template-columns:1fr;gap:32px;padding:clamp(48px,12vw,80px) 0}.hero-split .hero-media{order:-1}}
/* HERO · center — centered statement, no photo */
.hero-center{text-align:center}
.hero-center .hero-inner{max-width:820px;margin:0 auto;padding:clamp(80px,14vw,180px) 0}
.hero-center .lead{margin-left:auto;margin-right:auto}
.hero-center .eyebrow{margin-left:auto;margin-right:auto}
/* HERO · editorial — oversized headline, wide photo beneath, lead + CTA below */
.hero-editorial{padding:clamp(48px,8vw,96px) 0 0}
.hero-editorial .hero-head{max-width:var(--container)}
.hero-editorial .hero-head h1{font-size:clamp(2.8rem,9vw,6.2rem);margin:.2em 0 .5em}
.hero-editorial .hero-wide{margin:clamp(24px,4vw,48px) 0}
.hero-editorial .hero-wide img{width:100%;aspect-ratio:21/9;object-fit:cover;border-radius:var(--radius)}
.hero-editorial .hero-foot{max-width:620px}
.hero-editorial .hero-foot .lead{margin:0 0 1.6rem}
/* NAV · centered — brand stacked above centered links */
@media(min-width:761px){
  .nav-centered .nav-inner{flex-direction:column;gap:12px;padding-top:20px;padding-bottom:16px}
  .nav-centered .nav-brand{margin:0 auto;font-size:1.5rem}
  .nav-centered .nav-links{margin:0 auto}
}
/* section rhythm — alternating surface bands (only when l-band) for real vertical variety */
.l-band main>.section:nth-of-type(even){background:var(--surface)}
`;

export function navBar(brand: string, pages: any[], current: string, ctaText?: string, ctaHref = '#', variant = 'standard') {
  const links = pages.map(p => `<li><a href="${esc(p.slug)}.html"${p.slug === current ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('');
  return `<nav class="nav nav-${esc(variant)}"><div class="nav-inner">
  <a class="nav-brand" href="index.html">${esc(brand)}</a>
  <input type="checkbox" id="navmenu" class="nav-toggle" aria-hidden="true">
  <label for="navmenu" class="nav-burger" aria-label="Toggle menu">☰</label>
  <ul class="nav-links">${links}${ctaText ? `<li><a class="btn" href="${esc(ctaHref)}">${esc(ctaText)}</a></li>` : ''}</ul>
</div></nav>`;
}
export function footer(brand: string, pages: any[]) {
  return `<footer class="footer"><div class="container"><div class="footer-inner">
  <span>© ${esc(brand)}</span><div class="footer-links">${pages.map(p => `<a href="${esc(p.slug)}.html">${esc(p.title)}</a>`).join('')}</div>
</div></div></footer>`;
}

// section components — each takes a content object, returns perfect HTML
type SecOpts = { link?: (raw: any, text: any) => string; forms?: Record<string, any[]>; primaryTable?: string; hero?: string };
const href = (o: SecOpts | undefined, raw: any, text: any) => esc(o?.link ? o.link(raw, text) : '#');
// A CTA value may be a STRING or an OBJECT ({text/label, link/href}). Normalize to {text, link} or null
// so a button is NEVER `esc(object)` ("[object Object]") and never renders with an empty label.
export function ctaParts(raw: any, sectionLink?: any): { text: string; link: any } | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') { const t = raw.trim(); return t ? { text: t, link: sectionLink } : null; }
  if (typeof raw === 'object') { const t = String(raw.text ?? raw.label ?? raw.title ?? raw.cta ?? raw.name ?? '').trim(); return t ? { text: t, link: raw.link ?? raw.href ?? raw.url ?? raw.page ?? sectionLink } : null; }
  const t = String(raw).trim(); return t ? { text: t, link: sectionLink } : null;
}
// Render a button only when there's real label text; resolve its destination via the renderer's link fn.
const btn = (o: SecOpts | undefined, raw: any, sectionLink?: any) => { const c = ctaParts(raw, sectionLink); return c ? `<a class="btn" href="${href(o, c.link, c.text)}">${esc(c.text)}</a>` : ''; };
export const SECTIONS: Record<string, (s: any, o?: SecOpts) => string> = {
  // HERO — one of four STRUCTURALLY different treatments (chosen per project by src/layout.ts, passed
  // in o.hero). Each is hand-built + WCAG-safe: image uses white-on-overlay; split/center/editorial use
  // the contrast-guaranteed --text on --bg. Copy shape (eyebrow/headline/lead/cta) is identical across
  // variants, so the composer never has to know which one renders.
  hero: (s, o) => {
    const v: string = (o && o.hero) || 'image';
    const eyebrow = s.eyebrow ? `<span class="eyebrow">${esc(s.eyebrow)}</span>` : '';
    const lead = s.lead ? `<p class="lead">${esc(s.lead)}</p>` : '';
    const cta = btn(o, s.cta, s.link);
    const copy = `${eyebrow}<h1>${esc(s.headline)}</h1>${lead}${cta}`;
    if (v === 'split') return `<header class="hero hero-split"><div class="container"><div class="hero-split-grid">
      <div class="hero-copy">${copy}</div>
      <div class="hero-media">${s.image ? q(s.image, 'hero-photo') : ''}</div>
    </div></div></header>`;
    if (v === 'center') return `<header class="hero hero-center"><div class="container"><div class="hero-inner">${copy}</div></div></header>`;
    if (v === 'editorial') return `<header class="hero hero-editorial"><div class="container">
      <div class="hero-head">${eyebrow}<h1>${esc(s.headline)}</h1></div>
      ${s.image ? `<div class="hero-wide">${q(s.image, 'hero-photo')}</div>` : ''}
      <div class="hero-foot">${lead}${cta}</div>
    </div></header>`;
    // image (default): full-bleed photo + overlay
    return `<header class="hero on-image">${s.image ? `${q(s.image, 'hero-bg')}<div class="hero-overlay"></div>` : ''}
      <div class="container"><div class="hero-inner">${copy}</div></div></header>`;
  },
  features: (s) => `<section class="section"><div class="container">
    ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
    <div class="grid grid-3" style="margin-top:2.6rem">${(s.items || []).map((it: any) => `<div class="card"><h3>${esc(it.title)}</h3><p>${esc(it.body)}</p></div>`).join('')}</div>
  </div></section>`,
  split: (s, o) => `<section class="section"><div class="container"><div class="split ${s.reverse ? 'rev' : ''}">
    <div class="split-media">${q(s.image || 'abstract brand texture')}</div>
    <div>${s.eyebrow ? `<span class="eyebrow">${esc(s.eyebrow)}</span>` : ''}<h2>${esc(s.title)}</h2><p class="muted">${esc(s.body)}</p>${btn(o, s.cta, s.link)}</div>
  </div></div></section>`,
  gallery: (s) => `<section class="section"><div class="container">${s.title ? `<h2 style="margin-bottom:2rem">${esc(s.title)}</h2>` : ''}
    <div class="gallery">${(s.images || []).slice(0, 6).map((x: string) => q(x)).join('')}</div></div></section>`,
  cta: (s, o) => `<section class="section" id="get-started"><div class="container"><div class="cta">
    <h2>${esc(s.headline)}</h2>${s.body ? `<p>${esc(s.body)}</p>` : ''}${btn(o, s.cta, s.link)}
  </div></div></section>`,
  // pricing — tiered plans (one may be featured)
  pricing: (s, o) => `<section class="section"><div class="container">
    ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
    <div class="grid grid-3" style="margin-top:2.6rem">${(s.plans || []).slice(0, 3).map((p: any) => `<div class="card price${p.featured ? ' feat' : ''}">
      ${p.featured ? '<span class="eyebrow">Most popular</span>' : ''}<h3>${esc(p.name)}</h3>
      <div class="price-amt">${esc(p.price)}${p.period ? `<span>/${esc(p.period)}</span>` : ''}</div>
      ${p.body ? `<p class="muted">${esc(p.body)}</p>` : ''}
      <ul class="price-feats">${(p.features || []).slice(0, 8).map((f: string) => `<li>${esc(f)}</li>`).join('')}</ul>
      ${p.cta ? `<a class="btn" href="${href(o, p.link, p.cta)}">${esc(p.cta)}</a>` : ''}
    </div>`).join('')}</div></div></section>`,
  // testimonials — quote cards
  testimonials: (s) => `<section class="section"><div class="container">
    ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
    <div class="grid grid-3" style="margin-top:2.4rem">${(s.items || []).slice(0, 6).map((t: any) => `<div class="card quote">
      <p class="qtext">“${esc(t.quote)}”</p><div class="qby"><b>${esc(t.name)}</b>${t.role ? `<span class="muted">${esc(t.role)}</span>` : ''}</div>
    </div>`).join('')}</div></div></section>`,
  // faq — CSS-only accordion (native <details>)
  faq: (s) => `<section class="section"><div class="container" style="max-width:820px">
    ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}
    <div class="faq" style="margin-top:1.8rem">${(s.items || []).slice(0, 10).map((f: any) => `<details class="faq-item"><summary>${esc(f.q)}</summary><p class="muted">${esc(f.a)}</p></details>`).join('')}</div>
  </div></section>`,
  // stats — big-number band
  stats: (s) => `<section class="section"><div class="container">
    ${s.title ? `<h2 style="text-align:center;margin-bottom:2rem">${esc(s.title)}</h2>` : ''}
    <div class="grid grid-3 stats">${(s.items || []).slice(0, 4).map((x: any) => `<div class="stat"><div class="stat-n">${esc(x.value)}</div><div class="muted">${esc(x.label)}</div></div>`).join('')}</div>
  </div></section>`,
  // logos — "trusted by" social-proof band: plain text marks (no external images → gate-safe)
  logos: (s) => `<section class="section" style="padding-block:2.6rem"><div class="container">
    ${s.title ? `<p class="muted" style="text-align:center;letter-spacing:.08em;text-transform:uppercase;font-size:.8rem;margin-bottom:1.4rem">${esc(s.title)}</p>` : ''}
    <div style="display:flex;flex-wrap:wrap;gap:1.6rem 2.6rem;justify-content:center;align-items:center;opacity:.78">${(s.items || []).slice(0, 8).map((n: any) => `<span style="font-weight:700;font-size:1.05rem">${esc(n)}</span>`).join('')}</div>
  </div></section>`,
  // offer — the conversion core of a landing page: deliverable + price anchor + risk reversal + ONE action
  offer: (s, o) => `<section class="section" id="offer"><div class="container" style="max-width:760px">
    <div class="card" style="text-align:center;padding:2.8rem 2rem">
      ${s.eyebrow ? `<span class="eyebrow">${esc(s.eyebrow)}</span>` : ''}<h2>${esc(s.title)}</h2>
      ${s.body ? `<p class="lead muted">${esc(s.body)}</p>` : ''}
      ${(s.bullets && s.bullets.length) ? `<ul class="price-feats" style="display:inline-block;text-align:left;margin:1.4rem auto 0">${s.bullets.slice(0, 8).map((b: string) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${s.price ? `<div class="price-amt" style="margin-top:1rem">${esc(s.price)}${s.period ? `<span>/${esc(s.period)}</span>` : ''}</div>` : ''}
      <div style="margin-top:1.4rem">${btn(o, s.cta, s.link)}</div>
      ${s.guarantee ? `<p class="muted" style="font-size:.9rem;margin-top:1rem">${esc(s.guarantee)}</p>` : ''}
    </div>
  </div></section>`,
  // LIVE DB read: a list rendered from the project's REAL database table (data-table). Empty-state at
  // build/gate time (file://); filled from /api/site/:id/data/:table when served over HTTP.
  collection: (s, o) => {
    // use the model's table if it's a real one; otherwise fall back to the primary catalog table
    const t = (s.table && (!o?.forms || o.forms[s.table])) ? s.table : (o?.primaryTable || s.table || 'items');
    const table = esc(t);
    const empty = esc(s.empty || 'Nothing here yet.');
    return `<section class="section"><div class="container">
      ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
      <div class="grid grid-3 collection" data-table="${table}" style="margin-top:2.4rem"><p class="muted feed-empty">${empty}</p></div>
    </div></section>`;
  },
  // FULL-STACK read path: a LIVE list of the site's own submissions to one named form (a directory /
  // listings / reviews / wall). Renders an empty-state at build/gate time (file://, no server) and is
  // filled by the renderer's feed loader when served over HTTP. data-feed = the form name it reads.
  feed: (s) => {
    const form = esc(s.form || 'listing');
    const empty = esc(s.empty || 'Nothing here yet — be the first to add one.');
    return `<section class="section"><div class="container">
      ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
      <div class="grid grid-3 feed" data-feed="${form}" style="margin-top:2.4rem"><p class="muted feed-empty">${empty}</p></div>
    </div></section>`;
  },
  // FULL-STACK write path. Default → a contact form into `site_submissions`. With `table` (and the
  // renderer-provided schema for it) → a typed "add a record" form whose fields are GENERATED from the
  // real table's columns and which writes a REAL row to /api/site/<id>/data/<table> (then the matching
  // collection refreshes). The model picks the table + copy; the system configures the fields.
  form: (s, o) => {
    const tcols = (s.table && o?.forms && Array.isArray(o.forms[s.table]) && o.forms[s.table].length) ? o.forms[s.table] : null;
    const dataTable = tcols ? s.table : '';
    const inputType = (c: any) => /bool/.test(c.type) ? 'checkbox'
      : /int|numeric|real|double|decimal/.test(c.type) ? 'number'
      : /date|time/.test(c.type) ? 'date'
      : (/desc|message|note|bio|content|about|detail|summary|story/.test(c.name) ? 'textarea' : (/email/.test(c.name) ? 'email' : 'text'));
    const fields = tcols
      ? tcols.map((c: any) => ({ name: c.name, label: humanize(c.name.replace(/_id$/, '')), type: inputType(c), required: !c.nullable, ref: c.ref, display: c.display, rawType: c.type }))
      : (Array.isArray(s.fields) && s.fields.length ? s.fields : [
          { name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'message', label: 'Message', type: 'textarea', required: true }]);
    const field = (f: any) => {
      const req = f.required === false ? '' : ' required';
      // RELATION (M2): a real FK renders as a <select> of the referenced table's records — options are
      // loaded live from the data API (empty under file:// so the static gate still passes).
      if (f.ref) return `<label>${esc(f.label)}<select name="${esc(f.name)}" data-ref="${esc(f.ref)}"${f.display ? ` data-display="${esc(f.display)}"` : ''}${req}><option value="">Choose…</option></select></label>`;
      if (f.type === 'checkbox') return `<label class="rcheck"><input type="checkbox" name="${esc(f.name)}"> ${esc(f.label)}</label>`;
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea name="${esc(f.name)}"${req}></textarea></label>`;
      const step = f.type === 'number' ? (/int/.test(String(f.rawType || '')) ? ' step="1"' : ' step="0.01" min="0"') : '';
      return `<label>${esc(f.label)}<input name="${esc(f.name)}" type="${esc(f.type || 'text')}"${req}${step}></label>`;
    };
    return `<section class="section" id="contact-form"><div class="container"><div class="formwrap">
      ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
      <form class="rform" data-form="${esc(s.form || dataTable || 'contact')}"${dataTable ? ` data-table="${esc(dataTable)}"` : ''} onsubmit="return relaySubmit(event)">
        ${fields.map(field).join('')}
        <button class="btn" type="submit">${esc(s.cta || (dataTable ? 'Add' : 'Send'))}</button>
        <p class="rform-msg" hidden></p>
      </form>
    </div></div></section>`;
  },
};

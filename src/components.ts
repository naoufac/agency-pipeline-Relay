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
.btn{display:inline-flex;align-items:center;gap:.5rem;background:var(--btn-bg,var(--primary));color:var(--btn-color,var(--on-primary));font-weight:var(--btn-weight,600);padding:.85rem 1.6rem;border-radius:var(--btn-radius,var(--radius));text-decoration:none;border:var(--btn-border,0);cursor:pointer;transition:filter .15s,background .15s,color .15s;font-family:inherit;font-size:1rem}
.btn:hover{filter:brightness(1.07);background:var(--btn-hover-bg,var(--btn-bg,var(--primary)));color:var(--btn-hover-color,var(--btn-color,var(--on-primary)))}
/* nav — CSS-only hamburger via checkbox */
.nav{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--bg) 80%,transparent);backdrop-filter:blur(10px);border-bottom:var(--border-w,1px) solid var(--line)}
.nav-inner{display:flex;align-items:center;gap:20px;max-width:var(--container,1140px);margin:0 auto;padding:14px 24px;position:relative}
.nav-brand{font-family:var(--font-display);font-weight:700;font-size:1.3rem;text-decoration:none;color:var(--text)}
.nav-links{display:flex;align-items:center;gap:4px;margin-left:auto;list-style:none;padding:0;margin-top:0;margin-bottom:0}
.nav-links a{text-decoration:none;color:var(--muted);font-weight:500;font-size:.95rem;padding:.45rem .75rem;border-radius:8px}
.nav-links a:hover,.nav-links a[aria-current]{color:var(--text);background:color-mix(in srgb,var(--text) 7%,transparent)}
.nav-links .btn{color:var(--btn-color,var(--on-primary));margin-left:6px}
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
.hero-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;filter:var(--photo-filter,none)}
/* ART-DIRECTION (PQ1): the scrim is BRAND-TINTED per theme (--hero-tint-mix mixes --primary into the
   bottom layer) but the black gradient FLOOR is fixed — white hero text can never lose its AA footing */
.hero-overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.34),rgba(0,0,0,.58)),color-mix(in srgb,var(--primary) var(--hero-tint-mix,0%),transparent);z-index:1}
.hero .container{position:relative;z-index:2}
/* on-image = white text; a dark brand-tinted gradient sits UNDER the photo so if the photo ever fails
   to load, the hero is an intentional dark branded panel (white text stays legible) — never a grey void */
.hero.on-image{background:linear-gradient(135deg,color-mix(in srgb,var(--primary) 68%,#0b1220),#0b1220)}
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
.split-media{position:relative}
.split-media img{width:100%;border-radius:var(--photo-radius,var(--radius));aspect-ratio:var(--crop-split,4/3);object-fit:cover;filter:var(--photo-filter,none)}
.split-media::after{content:'';position:absolute;inset:0;background:var(--primary);opacity:var(--photo-tint,0);mix-blend-mode:var(--photo-tint-blend,multiply);border-radius:var(--photo-radius,var(--radius));pointer-events:none}
/* products stay TRUE COLOUR — art-direction grades editorial imagery, never what's for sale */
.pdp .split-media img{filter:none;aspect-ratio:4/3;border-radius:var(--radius)}
.pdp .split-media::after{content:none}
/* gallery */
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
@media(max-width:760px){.gallery{grid-template-columns:1fr 1fr}}
.gallery img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:var(--photo-radius,var(--radius));filter:var(--photo-filter,none)}
/* cta */
.cta{background:var(--primary);color:var(--on-primary);border-radius:calc(var(--radius) + 6px);padding:clamp(44px,7vw,80px);text-align:center}
.cta h2{color:var(--on-primary)}.cta p{opacity:.92;max-width:48ch;margin:0 auto 1.6rem}.cta .btn{background:var(--bg);color:var(--text)}
/* footer */
.footer{border-top:var(--border-w,1px) solid var(--line);padding:44px 0;color:var(--muted)}
.footer-inner{display:flex;justify-content:space-between;gap:16px 24px;flex-wrap:wrap;align-items:center}
/* footer links WRAP (never force horizontal overflow, no matter how many pages) */
.footer-links{display:flex;flex-wrap:wrap;gap:8px 18px;justify-content:flex-end;min-width:0}
.footer-links a{color:var(--muted);text-decoration:none}.footer-links a:hover{color:var(--text)}
@media(max-width:560px){.footer-inner{flex-direction:column;align-items:flex-start}.footer-links{justify-content:flex-start}}
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
/* HERO · split — copy beside a framed photo (no overlay; text on --bg). Crop + frame + grade come
   from the theme's art-direction axis, so two split heroes on different themes read as different shoots */
.hero-split .hero-split-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:clamp(28px,5vw,72px);align-items:center;padding:clamp(56px,10vw,120px) 0}
.hero-split .hero-copy .lead{margin:1rem 0 2rem}
.hero-split .hero-media{position:relative}
.hero-split .hero-media img{width:100%;aspect-ratio:var(--crop-hero-split,5/4);object-fit:cover;border-radius:var(--photo-radius,calc(var(--radius) + 6px));filter:var(--photo-filter,none)}
.hero-split .hero-media::after{content:'';position:absolute;inset:0;background:var(--primary);opacity:var(--photo-tint,0);mix-blend-mode:var(--photo-tint-blend,multiply);border-radius:var(--photo-radius,calc(var(--radius) + 6px));pointer-events:none}
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
.hero-editorial .hero-wide{margin:clamp(24px,4vw,48px) 0;position:relative}
.hero-editorial .hero-wide img{width:100%;aspect-ratio:var(--crop-hero-wide,21/9);object-fit:cover;border-radius:var(--photo-radius,var(--radius));filter:var(--photo-filter,none)}
.hero-editorial .hero-wide::after{content:'';position:absolute;inset:0;background:var(--primary);opacity:var(--photo-tint,0);mix-blend-mode:var(--photo-tint-blend,multiply);border-radius:var(--photo-radius,var(--radius));pointer-events:none}
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
/* ============================================================================
   STORE PRIMITIVES (PQ2) — product grid with add-to-cart, cart, checkout. All data rendered via
   textContent (never innerHTML of server data); prices shown client-side are display-only — the
   ORDER total is computed server-side from the database, never trusted from the client.
   ============================================================================ */
.p-price{font-family:var(--font-display);font-weight:700;font-size:1.15rem;margin:.3rem 0 .8rem}
.p-add{width:100%;justify-content:center}
.p-soldout{opacity:.5;cursor:not-allowed}
.cart-box{background:var(--surface);border:var(--border-w,1px) solid var(--line);border-radius:var(--radius);padding:22px}
.cart-line{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
.cart-line:last-of-type{border-bottom:0}
.cart-line .cl-title{flex:1;font-weight:600}
.cart-qty{display:inline-flex;align-items:center;gap:8px}
.cart-qty button{font:inherit;width:28px;height:28px;border:1px solid var(--line);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer;line-height:1}
.cart-remove{background:none;border:0;color:var(--muted);cursor:pointer;font-size:1.1rem;padding:4px}
.cart-total{display:flex;justify-content:space-between;font-weight:700;font-size:1.15rem;padding-top:14px}
.cart-empty{color:var(--muted);padding:8px 0}
.cart-actions{margin-top:18px}
/* STORE · product detail page (PDP) — server-rendered per request from the live product row */
.pdp-crumb{margin:0 0 1.6rem}.pdp-crumb a{color:var(--muted);text-decoration:none;font-weight:600}.pdp-crumb a:hover{color:var(--text)}
.pdp-noimg{width:100%;aspect-ratio:4/3;border-radius:var(--radius);background:linear-gradient(135deg,color-mix(in srgb,var(--primary) 68%,#0b1220),#0b1220);display:flex;align-items:center;justify-content:center;color:#fff;font-family:var(--font-display);font-size:3.4rem;font-weight:700}
.pdp-info h1{font-size:clamp(1.9rem,4vw,2.7rem)}
.pdp-info .p-price{font-size:1.55rem;margin:.2rem 0 1.1rem}
.pdp-meta{list-style:none;padding:0;margin:1.2rem 0;display:grid;gap:.45rem;color:var(--muted)}
.pdp-meta b{color:var(--text);font-weight:600}
.pdp-info .p-add{width:auto;min-width:220px}
.pdp-cartlink{margin-top:1rem}.pdp-cartlink a{color:var(--muted)}
/* shop cards: image + title link to the product's own page */
.products .card h3 a{color:inherit;text-decoration:none}.products .card h3 a:hover{text-decoration:underline}
.products .card a.p-imglink{display:block}
/* FS1 · receipt (record) + find-my-booking */
.receipt-box{max-width:640px;margin:0 auto}
.receipt-ref{background:var(--surface);border:1px dashed var(--line);border-radius:var(--radius);padding:16px 20px;margin:1.2rem 0;text-align:center}
.receipt-ref code{font-size:1.25rem;font-weight:700;letter-spacing:.06em;word-break:break-all}
.receipt-ref .muted{display:block;font-size:.85rem;margin-top:.4rem}
.receipt-meta{list-style:none;padding:0;margin:1.2rem 0;display:grid;gap:.5rem}
.receipt-meta b{font-weight:600}
.receipt-status{display:inline-block;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:.3rem .9rem;font-weight:600;margin:.2rem 0 .8rem}
/* ============================================================================
   CARD ANATOMY VARIANTS (PQ1-B) — body.l-cards-<variant>. Applied via CSS-only to
   .collection .card, .products .card, .feed .card (DOM unchanged, only has-img class added).
   photo: 3-col grid, current look — no new rules needed.
   ============================================================================ */
/* horizontal — 2-col outer grid; card.has-img = side-by-side image + text */
body.l-cards-horizontal .collection,body.l-cards-horizontal .products,body.l-cards-horizontal .feed{grid-template-columns:1fr 1fr}
@media(max-width:760px){body.l-cards-horizontal .collection,body.l-cards-horizontal .products,body.l-cards-horizontal .feed{grid-template-columns:1fr}}
body.l-cards-horizontal .collection .card.has-img,body.l-cards-horizontal .products .card.has-img,body.l-cards-horizontal .feed .card.has-img{display:grid;grid-template-columns:42% 1fr;column-gap:16px;align-items:start;padding:0}
body.l-cards-horizontal .collection .card.has-img>img,body.l-cards-horizontal .feed .card.has-img>img,body.l-cards-horizontal .products .card.has-img>a.p-imglink{grid-row:1/span 9;height:100%!important;aspect-ratio:auto!important;object-fit:cover;margin:0!important;border-radius:var(--radius) 0 0 var(--radius)!important;width:100%}
body.l-cards-horizontal .products .card.has-img>a.p-imglink img{height:100%!important;aspect-ratio:auto!important;object-fit:cover;margin:0!important;border-radius:var(--radius) 0 0 var(--radius)!important;width:100%}
body.l-cards-horizontal .collection .card.has-img>:not(img):not(a.p-imglink),body.l-cards-horizontal .products .card.has-img>:not(img):not(a.p-imglink),body.l-cards-horizontal .feed .card.has-img>:not(img):not(a.p-imglink){padding:16px 16px 0}
body.l-cards-horizontal .collection .card.has-img>:not(img):not(a.p-imglink):last-child,body.l-cards-horizontal .products .card.has-img>:not(img):not(a.p-imglink):last-child,body.l-cards-horizontal .feed .card.has-img>:not(img):not(a.p-imglink):last-child{padding-bottom:16px}
@media(max-width:560px){body.l-cards-horizontal .collection .card.has-img,body.l-cards-horizontal .products .card.has-img,body.l-cards-horizontal .feed .card.has-img{grid-template-columns:1fr}body.l-cards-horizontal .collection .card.has-img>img,body.l-cards-horizontal .feed .card.has-img>img,body.l-cards-horizontal .products .card.has-img>a.p-imglink{grid-row:auto;height:auto!important;aspect-ratio:16/9!important;border-radius:var(--radius) var(--radius) 0 0!important}}
/* overlay — card.has-img is a poster; text is WHITE on a dark scrim (AA by construction, not theme-derived) */
body.l-cards-overlay .collection .card.has-img,body.l-cards-overlay .products .card.has-img,body.l-cards-overlay .feed .card.has-img{position:relative;aspect-ratio:4/5;overflow:hidden;padding:0;display:flex;flex-direction:column;justify-content:flex-end}
body.l-cards-overlay .collection .card.has-img>img,body.l-cards-overlay .feed .card.has-img>img{position:absolute;inset:0;width:100%!important;height:100%!important;object-fit:cover;margin:0!important;border-radius:0!important}
body.l-cards-overlay .products .card.has-img>a.p-imglink{position:absolute;inset:0;display:block}
body.l-cards-overlay .products .card.has-img>a.p-imglink img{width:100%!important;height:100%!important;object-fit:cover;margin:0!important;border-radius:0!important}
body.l-cards-overlay .collection .card.has-img::after,body.l-cards-overlay .products .card.has-img::after,body.l-cards-overlay .feed .card.has-img::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(11,18,32,.82),transparent 65%);z-index:1;pointer-events:none}
body.l-cards-overlay .collection .card.has-img>:not(img):not(a.p-imglink),body.l-cards-overlay .products .card.has-img>:not(img):not(a.p-imglink),body.l-cards-overlay .feed .card.has-img>:not(img):not(a.p-imglink){position:relative;z-index:2;color:#fff;padding:0 16px}
body.l-cards-overlay .collection .card.has-img>:not(img):not(a.p-imglink):last-child,body.l-cards-overlay .products .card.has-img>:not(img):not(a.p-imglink):last-child,body.l-cards-overlay .feed .card.has-img>:not(img):not(a.p-imglink):last-child{padding-bottom:16px}
body.l-cards-overlay .collection .card.has-img .muted,body.l-cards-overlay .products .card.has-img .muted,body.l-cards-overlay .feed .card.has-img .muted{color:rgba(255,255,255,.85)}
body.l-cards-overlay .collection .card.has-img .btn,body.l-cards-overlay .products .card.has-img .btn,body.l-cards-overlay .feed .card.has-img .btn{position:relative;z-index:3}
body.l-cards-overlay .collection .card.has-img p,body.l-cards-overlay .products .card.has-img p,body.l-cards-overlay .feed .card.has-img p{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
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
export function footer(brand: string, pages: any[], accountLinks = false) {
  // FS2: receipt-enabled apps carry the visitor's two standing doors in the footer — identical on
  // every page (rendered unconditionally per site), so the consistency gates hold by construction.
  const extras = accountLinks ? `<a href="find.html">Find my booking</a><a href="account.html">My bookings</a>` : '';
  return `<footer class="footer"><div class="container"><div class="footer-inner">
  <span>© ${esc(brand)}</span><div class="footer-links">${pages.map(p => `<a href="${esc(p.slug)}.html">${esc(p.title)}</a>`).join('')}${extras}</div>
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
    // image (default): full-bleed photo + overlay. The `on-image` (white text) treatment is applied
    // ONLY when a photo is actually present — otherwise the hero is a clean, legible typographic hero
    // on the brand bg (never a grey void when Pexels returns nothing).
    return `<header class="hero${s.image ? ' on-image' : ''}">${s.image ? `${q(s.image, 'hero-bg')}<div class="hero-overlay"></div>` : ''}
      <div class="container"><div class="hero-inner">${copy}</div></div></header>`;
  },
  // STORE (PQ2) · products — a real shop grid: cards load from the live products table and each
  // carries an Add-to-cart button (client cart; the order itself is priced server-side).
  products: (s, o) => {
    const t = esc((s.table && o?.forms && o.forms[s.table]) ? s.table : (o?.primaryTable || s.table || 'products'));
    return `<section class="section" id="shop"><div class="container">
    ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
    <div class="grid grid-3 products" data-products="${t}" style="margin-top:2.4rem"><p class="muted feed-empty">${esc(s.empty || 'Loading the collection…')}</p></div>
  </div></section>`;
  },
  // STORE · cart — line items, quantity controls, total; rendered entirely by the client runtime.
  cart: (s) => `<section class="section" id="cart"><div class="container" style="max-width:760px">
    ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
    <div class="cart-box" data-cart="full"><p class="cart-empty">Your cart is empty.</p></div>
  </div></section>`,
  // STORE · checkout — buyer details + order summary; submit posts the cart to /api/site/:id/order,
  // which recomputes the total from the database and writes order + order_items in one transaction.
  checkout: (s) => `<section class="section" id="checkout"><div class="container" style="max-width:640px">
    ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
    <div class="cart-box" data-cart="summary" style="margin:1.4rem 0"><p class="cart-empty">Your cart is empty.</p></div>
    <form class="rcheckout rform" onsubmit="return relayCheckout(event)">
      <label>Full name<input name="customer_name" type="text" required></label>
      <label>Email<input name="email" type="email" required></label>
      <label>Phone<input name="phone" type="text"></label>
      <label>Notes<textarea name="notes"></textarea></label>
      <button class="btn" type="submit">${esc(s.cta || 'Place order')}</button>
      <p class="rform-msg" hidden></p>
    </form>
  </div></section>`,
  // STORE · product — the DETAIL page for ONE real product row (PDP). SYSTEM-ONLY: deliberately NOT
  // in spec.ts KNOWN, so a composed model can never emit it — cms/live.ts synthesizes it per request
  // from the live DB row (price/description/photo edits show on the very next load). Every value is
  // escaped server-side; Add-to-cart joins the same client cart (the order is still priced server-side).
  product: (s) => {
    const row = (s && s.row && typeof s.row === 'object') ? s.row : {};
    const keys = Object.keys(row).filter(k => !['id', 'created_at', '_image'].includes(k) && row[k] != null && row[k] !== '' && !/pass|secret|token|hash|salt|api_?key|private|credential/i.test(k));   // defense-in-depth: mirrors appdb's SENSITIVE strip
    const titleKey = ['title', 'name', 'label'].find(k => typeof row[k] === 'string' && row[k].trim());
    const title = String(titleKey ? row[titleKey] : ('#' + (row.id ?? '')));
    const descKey = ['description', 'body', 'details', 'summary', 'about'].find(k => typeof row[k] === 'string' && row[k].trim());
    const IMG = /image|photo|picture|thumb|cover/i;
    const imgKey = keys.find(k => IMG.test(k) && typeof row[k] === 'string' && (/^https?:/.test(row[k]) || row[k].charAt(0) === '/'));
    const safeUrl = (v: any) => typeof v === 'string' && (/^https?:/.test(v) || v.charAt(0) === '/');   // never javascript:/data: — same rule as every card image
    const img = (safeUrl(row._image) ? row._image : '') || (imgKey ? String(row[imgKey]) : '');
    const priceKey = keys.find(k => /^(price|amount|cost)$/.test(k) && isFinite(parseFloat(row[k])));
    const price = priceKey ? Math.round(parseFloat(row[priceKey]) * 100) / 100 : NaN;
    const stock = row.stock != null ? Number(row.stock) : null;
    const meta = keys.filter(k => k !== titleKey && k !== descKey && k !== imgKey && k !== priceKey).slice(0, 6).map(k => {
      const v = row[k];
      if (typeof v === 'boolean') return v ? `<li>✓ ${esc(humanize(k))}</li>` : '';
      if (isFinite(Number(v)) && Number(v) === 0) return '';   // "Weight Grams: 0" is spec noise, not information (pg numerics arrive as strings)
      const money = /price|amount|cost|fee|rate/i.test(k) && isFinite(parseFloat(v));
      return `<li><b>${esc(humanize(k))}:</b> ${esc(money ? '$' + parseFloat(v).toFixed(2) : String(v).slice(0, 200))}</li>`;
    }).join('');
    const back = (s.back && s.back.slug) ? s.back : null;
    // no photo -> an intentional dark branded panel with the product initial — never a grey void
    const media = img ? `<img src="${esc(img)}" alt="${esc(title)}">` : `<div class="pdp-noimg">${esc((title.trim().charAt(0) || '·').toUpperCase())}</div>`;
    return `<section class="section pdp"><div class="container">
    ${back ? `<p class="pdp-crumb"><a href="${esc(back.slug)}.html">← ${esc(back.title || 'Back')}</a></p>` : ''}
    <div class="split">
      <div class="split-media">${media}</div>
      <div class="pdp-info">
        <h1>${esc(title)}</h1>
        ${isFinite(price) ? `<div class="p-price">$${price.toFixed(2)}</div>` : ''}
        ${descKey ? `<p class="lead muted">${esc(String(row[descKey]))}</p>` : ''}
        ${meta ? `<ul class="pdp-meta">${meta}</ul>` : ''}
        ${isFinite(price) && row.id != null ? (() => { if (stock === 0) return `<button type="button" class="btn p-add p-soldout" disabled>Sold out</button>`; const note = stock != null && stock >= 1 && stock <= 5 ? `<p class="muted">Only ${stock} left</p>` : ''; return note + `<button type="button" class="btn p-add" onclick="relayCartAdd(${esc(JSON.stringify({ id: row.id, title, price }))},this)">Add to cart</button>`; })() : ''}
        ${s.cartSlug ? `<p class="pdp-cartlink"><a href="${esc(String(s.cartSlug))}.html">View cart →</a></p>` : ''}
      </div>
    </div>
  </div></section>`;
  },
  // FS1 · record — the RECEIPT for one visitor-submitted row (booking/order/message). SYSTEM-ONLY
  // (not in spec KNOWN): cms/live.ts synthesizes it per request from the live row; the reference
  // code comes from the visitor's own URL, never from the row (reads strip it as a secret).
  record: (s) => {
    const row = (s && s.row && typeof s.row === 'object') ? s.row : {};
    const keys = Object.keys(row).filter(k => !['id', 'created_at', '_image'].includes(k) && row[k] != null && row[k] !== '' && !/pass|secret|token|hash|salt|api_?key|private|credential/i.test(k));
    const status = typeof row.status === 'string' && row.status.trim() ? row.status.trim() : '';
    const meta = keys.filter(k => k !== 'status').slice(0, 8).map(k => {
      const v = row[k];
      if (typeof v === 'boolean') return v ? `<li>✓ ${esc(humanize(k))}</li>` : '';
      if (isFinite(Number(v)) && Number(v) === 0) return '';   // zero-valued numerics are spec noise (same rule as PDP meta)
      const shown = (v instanceof Date) ? v.toDateString()      // a raw JS date dump is not a receipt line
        : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? new Date(v).toDateString()
        : String(v).slice(0, 200);
      return `<li><b>${esc(humanize(k))}:</b> ${esc(shown)}</li>`;
    }).join('');
    const back = (s.back && s.back.slug) ? s.back : null;
    return `<section class="section receipt"><div class="container"><div class="receipt-box">
    ${back ? `<p class="pdp-crumb"><a href="${esc(back.slug)}.html">← ${esc(back.title || 'Back')}</a></p>` : ''}
    <span class="eyebrow">${esc(s.eyebrow || 'Request received')}</span>
    <h1>${esc(s.title || 'We got it — here is your receipt')}</h1>
    ${status ? `<span class="receipt-status">Status: ${esc(status)}</span>` : ''}
    <div class="receipt-ref"><code>${esc(String(s.refCode || ''))}</code><span class="muted">Save this reference code — it is the key to this page.</span></div>
    ${meta ? `<ul class="receipt-meta">${meta}</ul>` : ''}
    ${s.findSlug ? `<p class="muted">Lost the link? Retrieve it anytime at <a href="${esc(String(s.findSlug))}.html">${esc(String(s.findTitle || 'Find my booking'))}</a>.</p>` : ''}
  </div></div></section>`;
  },
  // FS1 · find — paste the reference code (or ask for an email with the links). SYSTEM-ONLY, served
  // live at find.html. No enumeration: the email path always answers "sent" and mails only real matches.
  find: (s) => `<section class="section" id="find"><div class="container"><div class="receipt-box">
    <span class="eyebrow">${esc(s.eyebrow || 'Your receipts')}</span>
    <h1>${esc(s.title || 'Find my booking')}</h1>
    <form class="rform" onsubmit="return relayFindCode(event)" style="margin-bottom:2rem">
      <label>Reference code<input name="code" type="text" required minlength="16" placeholder="e.g. 3f9c…"></label>
      <button class="btn" type="submit">Open my receipt</button>
      <p class="rform-msg" hidden></p>
    </form>
    <form class="rform" onsubmit="return relayFindMail(event)">
      <label>…or email me my links<input name="email" type="email" required placeholder="you@example.com"></label>
      <button class="btn" type="submit">Email me</button>
      <p class="rform-msg" hidden></p>
    </form>
  </div></div></section>`,
  // FS2 · signin — email in, magic link out. SYSTEM-ONLY; served live at account.html (signed out).
  signin: (s) => `<section class="section" id="signin"><div class="container"><div class="receipt-box">
    <span class="eyebrow">${esc(s.eyebrow || 'Your account')}</span>
    <h1>${esc(s.title || 'Sign in')}</h1>
    <p class="lead muted">Enter your email — we'll send you a sign-in link. No password, ever.</p>
    <form class="rform" onsubmit="return relayVisitorRequest(event)">
      <label>Email<input name="email" type="email" required placeholder="you@example.com"></label>
      <button class="btn" type="submit">Email me a sign-in link</button>
      <p class="rform-msg" hidden></p>
    </form>
  </div></div></section>`,
  // FS2 · records — "My bookings": the signed-in visitor's rows across the app's private tables,
  // each opening its own receipt. SYSTEM-ONLY; rendered server-side from the verified email.
  records: (s) => {
    const items: any[] = Array.isArray(s.items) ? s.items : [];
    const cards = items.map((it: any) => {
      const row = it.row || {};
      const title = ['title', 'name', 'customer_name'].map(k => row[k]).find(v => typeof v === 'string' && v.trim()) || ('#' + (row.id ?? ''));
      const status = typeof row.status === 'string' && row.status.trim() ? `<span class="receipt-status">${esc(row.status)}</span>` : '';
      const when = row.created_at instanceof Date ? row.created_at.toDateString() : String(row.created_at || '').slice(0, 10);
      const open = it.ref ? `<a class="btn" href="receipt-${esc(it.table)}-${esc(it.ref)}.html" style="margin-top:.8rem">Open</a>` : '';
      return `<div class="card"><p class="muted" style="margin-bottom:.3rem">${esc(humanize(String(it.table)))}${when ? ' · ' + esc(when) : ''}</p><h3>${esc(String(title))}</h3>${status}${open}</div>`;
    }).join('');
    return `<section class="section" id="records"><div class="container">
    <span class="eyebrow">Signed in as ${esc(String(s.email || ''))}</span>
    <h1>${esc(s.title || 'My bookings')}</h1>
    ${items.length ? `<div class="grid grid-3" style="margin-top:2rem">${cards}</div>` : `<p class="lead muted">Nothing here yet — once you book, it shows up right here.</p>`}
    <p style="margin-top:2rem"><button type="button" class="btn" onclick="relayVisitorLogout()" style="background:var(--surface);color:var(--text);border:1px solid var(--line)">Sign out</button></p>
  </div></section>`;
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

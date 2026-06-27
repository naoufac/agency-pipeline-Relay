// The SKELETON — hand-built, responsive, accessible, token-driven section components.
// The LLM never writes these; it only chooses sections + copy + brand tokens. Structure can't be wrong.
import { FONT_FACES } from './fonts.ts';

export const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
const q = (query: string, cls = '') => `<img data-q="${esc(query)}" alt="" class="${cls}" loading="lazy">`;

// Design-system CSS. Responsive, CSS-only hamburger (no JS), fixed spacing/type scale. Inlined per page.
export const DS_CSS = FONT_FACES + `
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font-family:var(--font-body),system-ui,-apple-system,sans-serif;color:var(--text);background:var(--bg);line-height:1.6;-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}a{color:inherit}
h1,h2,h3{font-family:var(--font-display),system-ui,sans-serif;line-height:1.08;letter-spacing:-.02em;margin:0 0 .4em;color:var(--text)}
h1{font-size:clamp(2.3rem,6vw,4.2rem)}h2{font-size:clamp(1.7rem,4vw,2.7rem)}h3{font-size:1.25rem}
p{margin:0 0 1rem}
.container{width:100%;max-width:1140px;margin:0 auto;padding:0 24px}
.section{padding:clamp(52px,8vw,108px) 0}
.eyebrow{display:inline-block;font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:1rem}
.muted{color:var(--muted)}.lead{font-size:1.18rem;max-width:56ch}
.btn{display:inline-flex;align-items:center;gap:.5rem;background:var(--primary);color:var(--on-primary);font-weight:600;padding:.85rem 1.6rem;border-radius:var(--radius);text-decoration:none;border:0;cursor:pointer;transition:filter .15s;font-family:inherit;font-size:1rem}
.btn:hover{filter:brightness(1.07)}
/* nav — CSS-only hamburger via checkbox */
.nav{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--bg) 80%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav-inner{display:flex;align-items:center;gap:20px;max-width:1140px;margin:0 auto;padding:14px 24px;position:relative}
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
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:28px}
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
.footer{border-top:1px solid var(--line);padding:44px 0;color:var(--muted)}
.footer-inner{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;align-items:center}
.footer nav a{color:var(--muted);text-decoration:none;margin-left:18px}.footer nav a:hover{color:var(--text)}
/* form (full-stack: posts to a real API -> Postgres) */
.formwrap{max-width:560px}
.rform{display:flex;flex-direction:column;gap:14px;margin-top:1.6rem}
.rform label{display:flex;flex-direction:column;gap:6px;font-size:.88rem;font-weight:600;color:var(--text)}
.rform input,.rform textarea{font:inherit;padding:.72rem .9rem;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);width:100%}
.rform input:focus,.rform textarea:focus{outline:0;border-color:var(--primary)}
.rform textarea{min-height:120px;resize:vertical}.rform .btn{align-self:flex-start}
.rform-msg{margin:.4rem 0 0;font-weight:600;color:var(--accent)}
`;

export function navBar(brand: string, pages: any[], current: string, ctaText?: string) {
  const links = pages.map(p => `<li><a href="${esc(p.slug)}.html"${p.slug === current ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('');
  return `<nav class="nav"><div class="nav-inner">
  <a class="nav-brand" href="index.html">${esc(brand)}</a>
  <input type="checkbox" id="navmenu" class="nav-toggle" aria-hidden="true">
  <label for="navmenu" class="nav-burger" aria-label="Toggle menu">☰</label>
  <ul class="nav-links">${links}${ctaText ? `<li><a class="btn" href="#">${esc(ctaText)}</a></li>` : ''}</ul>
</div></nav>`;
}
export function footer(brand: string, pages: any[]) {
  return `<footer class="footer"><div class="container"><div class="footer-inner">
  <span>© ${esc(brand)}</span><nav>${pages.map(p => `<a href="${esc(p.slug)}.html">${esc(p.title)}</a>`).join('')}</nav>
</div></div></footer>`;
}

// section components — each takes a content object, returns perfect HTML
export const SECTIONS: Record<string, (s: any) => string> = {
  hero: (s) => `<header class="hero ${s.image ? 'on-image' : ''}">${s.image ? `${q(s.image, 'hero-bg')}<div class="hero-overlay"></div>` : ''}
    <div class="container"><div class="hero-inner">
      ${s.eyebrow ? `<span class="eyebrow">${esc(s.eyebrow)}</span>` : ''}<h1>${esc(s.headline)}</h1>
      ${s.lead ? `<p class="lead">${esc(s.lead)}</p>` : ''}${s.cta ? `<a class="btn" href="#">${esc(s.cta)}</a>` : ''}
    </div></div></header>`,
  features: (s) => `<section class="section"><div class="container">
    ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
    <div class="grid grid-3" style="margin-top:2.6rem">${(s.items || []).map((it: any) => `<div class="card"><h3>${esc(it.title)}</h3><p>${esc(it.body)}</p></div>`).join('')}</div>
  </div></section>`,
  split: (s) => `<section class="section"><div class="container"><div class="split ${s.reverse ? 'rev' : ''}">
    <div class="split-media">${q(s.image || 'abstract brand texture')}</div>
    <div>${s.eyebrow ? `<span class="eyebrow">${esc(s.eyebrow)}</span>` : ''}<h2>${esc(s.title)}</h2><p class="muted">${esc(s.body)}</p>${s.cta ? `<a class="btn" href="#">${esc(s.cta)}</a>` : ''}</div>
  </div></div></section>`,
  gallery: (s) => `<section class="section"><div class="container">${s.title ? `<h2 style="margin-bottom:2rem">${esc(s.title)}</h2>` : ''}
    <div class="gallery">${(s.images || []).slice(0, 6).map((x: string) => q(x)).join('')}</div></div></section>`,
  cta: (s) => `<section class="section"><div class="container"><div class="cta">
    <h2>${esc(s.headline)}</h2>${s.body ? `<p>${esc(s.body)}</p>` : ''}${s.cta ? `<a class="btn" href="#">${esc(s.cta)}</a>` : ''}
  </div></div></section>`,
  // FULL-STACK: a real form that posts to /api/site/<id>/submit -> Postgres
  form: (s) => {
    const fields = (Array.isArray(s.fields) && s.fields.length ? s.fields : [
      { name: 'name', label: 'Full name' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'message', label: 'Message', type: 'textarea' }]);
    return `<section class="section"><div class="container"><div class="formwrap">
      ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.intro ? `<p class="lead muted">${esc(s.intro)}</p>` : ''}
      <form class="rform" data-form="${esc(s.form || 'contact')}" onsubmit="return relaySubmit(event)">
        ${fields.map((f: any) => f.type === 'textarea'
          ? `<label>${esc(f.label)}<textarea name="${esc(f.name)}" required></textarea></label>`
          : `<label>${esc(f.label)}<input name="${esc(f.name)}" type="${esc(f.type || 'text')}" required></label>`).join('')}
        <button class="btn" type="submit">${esc(s.cta || 'Send')}</button>
        <p class="rform-msg" hidden></p>
      </form>
    </div></div></section>`;
  },
};

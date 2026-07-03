// dogfood.ts — the reviewer that mimics a human, now on Playwright (shared persistent browser; no
// hand-rolled CDP, no ws). It USES every produced site: visits every page at desktop + mobile, measures
// layout (header alignment, horizontal overflow), audits EVERY anchor (label sanity + dead href) and
// LOAD-TESTS every internal link target, TYPES into and SUBMITS the form (asserting the row landed — real
// table or submissions bucket), and judges collections against the data API (rows-in-DB-but-0-rendered =
// a real render bug). Verdict is LOAD-BEARING: content-level findings re-open the affected page builds
// with feedback (self-correcting loop). Auto-runs on completion → dogfood_reviews → shown per project.
import pg from 'pg';
import { ev } from './db.ts';
import * as appdb from './appdb.ts';
import { PRIVATE_READ } from './schema.ts';
import { FACADE_PAGE } from './archetype.ts';
import { withPage } from './browser.ts';

export type Issue = { page: string; viewport: string; kind: string; detail: string; severity: 'high' | 'medium' | 'low' };

// Self-correction: which findings a REBUILD-with-feedback can plausibly fix (content the LLM controls)
// vs. system/CSS issues a rebuild can't (header/overflow → surfaced to a developer instead).
const CONTENT_FIXABLE = new Set(['dead-button', 'garbage-button', 'broken-link', 'empty-collection', 'collection-not-rendering', 'form-not-persisted', 'form-schema-mismatch', 'no-product-detail']);
export function repairPlan(issues: Issue[], pageSlugs: string[]): { slug: string; notes: string[] }[] {
  const byPage = new Map<string, string[]>();
  for (const i of issues) {
    if (i.severity !== 'high' || !CONTENT_FIXABLE.has(i.kind)) continue;
    const slug = String(i.page || '').replace(/\.html$/, '');
    if (!pageSlugs.includes(slug)) continue;
    if (!byPage.has(slug)) byPage.set(slug, []);
    byPage.get(slug)!.push(`${i.kind}: ${i.detail}`);
  }
  return [...byPage].map(([slug, notes]) => ({ slug, notes }));
}

// ---- in-page probes (run inside the real browser via page.evaluate) ----
const LAYOUT = `(()=>{var n=document.querySelector('.nav-inner'),c=document.querySelector('main .container')||document.querySelector('.container');var nl=n?n.getBoundingClientRect().left:null,cl=c?c.getBoundingClientRect().left:null;return{overflow:document.documentElement.scrollWidth>window.innerWidth+2,navLeft:nl,contLeft:cl,misaligned:(nl!=null&&cl!=null)?Math.abs(nl-cl)>2:false}})()`;
// "one website = one navigation = one logo" — read it from the LIVE DOM the visitor actually sees.
const STRUCT = `(function(){var b=document.querySelector('.nav-brand');return{navs:document.querySelectorAll('nav').length,logos:document.querySelectorAll('.nav-brand').length,logo:b?(b.textContent||'').trim():''}})()`;
const LINKS = `Array.from(document.querySelectorAll('a')).map(function(a){return{text:(a.textContent||'').trim().slice(0,60),href:a.getAttribute('href')||'',btn:a.classList.contains('btn')}})`;
const COLLS = `Array.from(document.querySelectorAll('.collection[data-table]')).map(el=>({table:el.getAttribute('data-table'),cards:el.querySelectorAll('.card').length}))`;
// card body copy that is machine residue, not prose: a kebab/snake slug or a bare (possibly #-prefixed) number
const CARD_NOISE = `(function(){var out=[];Array.prototype.forEach.call(document.querySelectorAll('.card p'),function(p){var t=(p.textContent||'').trim();if(!t)return;if(/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(t))out.push({kind:'slug',text:t.slice(0,60)});else if(/^#?\\d+(\\.\\d+)?$/.test(t))out.push({kind:'number',text:t.slice(0,20)})});return out.slice(0,6)})()`;
const FORMINFO = `(function(){var f=document.querySelector('form.rform[data-table]')||document.querySelector('form.rform');if(!f)return null;var fields=[];f.querySelectorAll('input,textarea,select').forEach(function(el){if(!el.name)return;fields.push({name:el.name,tag:el.tagName.toLowerCase(),required:!!el.required,ref:el.getAttribute('data-ref')||null,options:el.tagName==='SELECT'?el.options.length:0})});return{table:f.getAttribute('data-table')||'',fields:fields}})()`;
const SUBMIT = `new Promise(res=>{var f=document.querySelector('form.rform[data-table]')||document.querySelector('form.rform');if(!f)return res({form:false});var tbl=f.getAttribute('data-table')||'';f.querySelectorAll('input,textarea,select').forEach(function(el,i){if(el.tagName==='SELECT'){if(el.options.length>1)el.selectedIndex=1;el.dispatchEvent(new Event('change',{bubbles:true}));return;}var t=(el.type||'').toLowerCase();if(t==='hidden'){if(el.getAttribute('data-slot'))el.value=new Date(Date.now()+7*86400000).toISOString().slice(0,10)+'T10:00:00';return;}if(t==='checkbox'){el.checked=true;}else if(t==='number'){el.value=String(10+i);}else if(t==='email'){el.value='qa@example.com';}else if(t==='date'){el.value=new Date(Date.now()+7*86400000).toISOString().slice(0,10);}else if(el.tagName==='TEXTAREA'){el.value='Automated QA check — please ignore.';}else{el.value='QA Test '+i;}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});try{f.requestSubmit?f.requestSubmit():f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))}catch(e){}setTimeout(function(){var m=f.querySelector('.rform-msg');var t=m?(m.textContent||''):'';res({form:true,table:tbl,msg:t.trim(),ok:/thank|got your|received|success|added/i.test(t)})},3500)})`;

export async function dogfood(pool: pg.Pool, projectId: string, baseUrl = 'http://localhost:8787'): Promise<{ issues: Issue[]; checked: { pages: number; buttons: number; links: number; linkTargets: number; forms: number; collections: number } }> {
  const proj = await pool.query('select params from projects where id=$1', [projectId]);
  const pages = (proj.rows[0]?.params?.pages) || [{ slug: 'index', title: 'Home' }];
  // pages that carry the site's ACTION (form/products/checkout/offer) — a page every button drives to
  // is legitimate store/app design when it's one of these, even when that page is home.
  const actionSlugs = new Set<string>((((proj.rows[0]?.params?.site || {}).pages) || [])
    .filter((p: any) => (p.sections || []).some((s: any) => s && ['form', 'products', 'checkout', 'offer'].includes(String(s.type))))
    .map((p: any) => String(p.slug)));
  const issues: Issue[] = []; let nButtons = 0, nForms = 0, nColls = 0, nLinks = 0;
  const targets = new Set<string>();
  const siteLogos = new Set<string>();   // every page's logo text — a coherent site shows exactly ONE
  const url = (slug: string) => `${baseUrl}/sites/${projectId}/${slug}.html`;
  const goto = async (page: any, u: string) => { try { await page.goto(u, { waitUntil: 'networkidle', timeout: 30000 }); } catch { try { await page.goto(u, { waitUntil: 'load', timeout: 15000 }); } catch {} } };

  await withPage({ width: 1280, height: 900 }, async (page) => {
    for (const vp of [{ name: 'desktop', w: 1280, h: 900 }, { name: 'mobile', w: 390, h: 844 }]) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      for (const pg of pages) {
        await goto(page, url(pg.slug));
        const lay: any = await page.evaluate(LAYOUT).catch(() => null);
        if (lay?.overflow) issues.push({ page: pg.slug, viewport: vp.name, kind: 'overflow', detail: 'page scrolls horizontally (layout overflow)', severity: 'high' });
        if (lay?.misaligned) issues.push({ page: pg.slug, viewport: vp.name, kind: 'header', detail: `header misaligned: nav left ${Math.round(lay.navLeft)} vs content ${Math.round(lay.contLeft)}`, severity: 'medium' });
        // structural: exactly one navigation + one logo on the live page (catches duplicate nav/logo)
        const st: any = await page.evaluate(STRUCT).catch(() => null);
        if (st) {
          if (st.navs !== 1) issues.push({ page: pg.slug, viewport: vp.name, kind: 'duplicate-nav', detail: `page renders ${st.navs} navigations — a website must have exactly ONE`, severity: 'high' });
          if (st.logos !== 1) issues.push({ page: pg.slug, viewport: vp.name, kind: 'duplicate-logo', detail: `page renders ${st.logos} logos — a website must have exactly ONE`, severity: 'high' });
          if (vp.name === 'desktop' && st.logo) siteLogos.add(st.logo);
        }
        const links: any[] = ((await page.evaluate(LINKS).catch(() => [])) as any[]) || [];
        const btnTargets: string[] = [];   // this page's button destinations, for the circular/all-same checks
        const self = pg.slug + '.html';
        for (const a of links) {
          const lt = String(a.text || '').toLowerCase().trim();
          if (a.btn) {
            nButtons++;
            const href = String(a.href || '');
            if (!a.text || lt === '[object object]' || lt === 'undefined' || lt === 'null') issues.push({ page: pg.slug, viewport: vp.name, kind: 'garbage-button', detail: `button has no real label (text="${a.text}", href="${href}")`, severity: 'high' });
            if (!href || href === '#' || href === '') issues.push({ page: pg.slug, viewport: vp.name, kind: 'dead-button', detail: `CTA "${a.text}" goes nowhere (href="${href}")`, severity: 'high' });
            // CIRCULAR: a CTA that links to the very page it sits on just reloads — the "every button
            // goes home" bug. (An in-page #anchor is fine; a bare self .html reload is not.)
            else if (vp.name === 'desktop' && (href === self || href.split('#')[0] === self) && !href.startsWith('#')) {
              issues.push({ page: pg.slug, viewport: vp.name, kind: 'dead-button', detail: `CTA "${a.text}" links to its own page (${href}) — it just reloads`, severity: 'high' });
            }
            if (vp.name === 'desktop' && href && !href.startsWith('#')) btnTargets.push(href.split('#')[0]);
          }
          nLinks++;
          if (vp.name === 'desktop' && /^[^#?:/][^#?:]*\.html(#.*)?$/.test(a.href)) targets.add(a.href.split('#')[0]);
        }
        // ALL-SAME calibration: the BROKEN-resolver signature is 3+ CTAs all collapsing to HOME
        // (index.html) — that stays a high finding. 3+ CTAs sharing a legitimate ACTION page
        // (shop/checkout/contact/book) is normal store design (everything drives to the shop) —
        // surfaced as a medium style note, never a blocker, never a wasted recompose.
        if (vp.name === 'desktop' && btnTargets.length >= 3 && new Set(btnTargets).size === 1) {
          const target = btnTargets[0];
          // FS0 calibration: when home genuinely HOSTS the core action (the booking form on index),
          // "everything drives to home" is the ordinary shared-action-page pattern, not the broken
          // resolver. Home-collapse stays a blocker only when home has no action to offer.
          if (target === 'index.html' && !actionSlugs.has('index')) issues.push({ page: pg.slug, viewport: vp.name, kind: 'dead-button', detail: `all ${btnTargets.length} buttons on this page collapse to home (${target}) — CTAs aren't routing`, severity: 'high' });
          else issues.push({ page: pg.slug, viewport: vp.name, kind: 'cta-monotone', detail: `all ${btnTargets.length} buttons on this page share one destination (${target}) — consider varying secondary CTAs`, severity: 'medium' });
        }
        if (vp.name === 'desktop') {
          await page.waitForFunction('(function(){var e=document.querySelector(".collection[data-table]");return !e||e.querySelector(".card")})()', { timeout: 5000 }).catch(() => {});
          for (const c of (((await page.evaluate(COLLS).catch(() => [])) as any[]) || [])) {
            nColls++;
            let apiRows = -1;
            if (c.table && /^[a-z_][a-z0-9_]*$/.test(c.table)) { try { const d: any = await (await fetch(`${baseUrl}/api/site/${projectId}/data/${c.table}`)).json(); apiRows = (d.rows || []).length; } catch {} }
            if (!c.cards && apiRows > 0) issues.push({ page: pg.slug, viewport: vp.name, kind: 'collection-not-rendering', detail: `collection "${c.table}" has ${apiRows} rows in the DB but rendered 0 — the page isn't loading its data`, severity: 'high' });
          }
          // CARD NOISE: a raw database slug ('elder-law-guardianship') or a bare unlabeled number ('60')
          // shipped as card body copy is pipeline residue a client would spot instantly (agency-panel #1).
          for (const n of (((await page.evaluate(CARD_NOISE).catch(() => [])) as any[]) || [])) {
            if (n.kind === 'slug') issues.push({ page: pg.slug, viewport: vp.name, kind: 'card-noise', detail: `card body copy shows a raw database slug ("${n.text}")`, severity: 'high' });
            else issues.push({ page: pg.slug, viewport: vp.name, kind: 'card-noise', detail: `card body copy shows a bare unlabeled number ("${n.text}")`, severity: 'medium' });
          }
        }
      }
    }
    // FS0 · HONEST SURFACE: a facade page (dashboard/portal/track…) on a data archetype is fiction —
    // the planner+site_model now prevent them; the reviewer still flags any legacy site serving one.
    const paramsF = (await pool.query('select params from projects where id=$1', [projectId])).rows[0]?.params || {};
    if (['app', 'store'].includes(String(paramsF.archetype)))
      for (const pg2 of pages)
        if (FACADE_PAGE.test(String(pg2.slug)))
          issues.push({ page: pg2.slug, viewport: 'all', kind: 'facade-page', detail: `page "${pg2.slug}" promises an app surface (dashboard/portal/tracking) the system does not power — it can only render fiction`, severity: 'high' });
    // one site = one logo: flag any per-page logo drift (the deterministic site_consistent gate also
    // enforces this, but the reviewer must SEE and report it — the verdict is what's shown on the board)
    if (siteLogos.size > 1) issues.push({ page: '(site)', viewport: 'all', kind: 'logo-drift', detail: `the logo differs across pages: ${[...siteLogos].map(l => JSON.stringify(l)).join(' · ')} — one website must show one logo`, severity: 'high' });
    // load-test every internal link target across the whole site (broken nav / wrong links anywhere)
    for (const t of targets) {
      try { const r = await fetch(`${baseUrl}/sites/${projectId}/${t}`); const body = await r.text(); if (!r.ok || body.length < 400) issues.push({ page: t, viewport: 'all', kind: 'broken-link', detail: `link target "${t}" does not load (status ${r.status}, ${body.length}b)`, severity: 'high' }); }
      catch { issues.push({ page: t, viewport: 'all', kind: 'broken-link', detail: `link target "${t}" failed to load`, severity: 'high' }); }
    }
    // PWA PROBE (owner-directed): the site must be INSTALLABLE — manifest + brand icons + offline
    // shell all served live. A missing piece is a broken "Add to Home Screen" on the client's phone.
    try {
      const mf = await fetch(`${baseUrl}/sites/${projectId}/manifest.webmanifest`);
      const mj: any = mf.ok ? await mf.json().catch(() => null) : null;
      if (!mj || mj.display !== 'standalone' || !Array.isArray(mj.icons) || !mj.icons.length) {
        issues.push({ page: '(site)', viewport: 'all', kind: 'pwa-broken', detail: mf.ok ? 'manifest.webmanifest is incomplete — the site cannot install as an app' : `manifest.webmanifest does not load (${mf.status}) — the site cannot install as an app`, severity: 'high' });
      } else {
        for (const src of new Set(mj.icons.map((i: any) => String(i.src || '')).filter(Boolean))) {
          const ir = await fetch(`${baseUrl}/sites/${projectId}/${src}`).catch(() => null);
          if (!ir || !ir.ok) issues.push({ page: '(site)', viewport: 'all', kind: 'pwa-broken', detail: `app icon "${src}" does not load — install would ship a broken icon`, severity: 'high' });
        }
        const swr = await fetch(`${baseUrl}/sites/${projectId}/sw.js`).catch(() => null);
        if (!swr || !swr.ok) issues.push({ page: '(site)', viewport: 'all', kind: 'pwa-broken', detail: 'sw.js does not load — no offline shell', severity: 'high' });
      }
    } catch { issues.push({ page: '(site)', viewport: 'all', kind: 'pwa-broken', detail: 'manifest fetch failed — the site cannot install as an app', severity: 'high' }); }
    // STORE PROBE (PQ2): a real browser BUYS — add 2 products to the cart, check out, and prove the
    // order + line items landed in the database. Runs only on store builds (checkout page present).
    const params2 = (await pool.query('select params from projects where id=$1', [projectId])).rows[0]?.params || {};
    const coPage = pages.find((p: any) => String(p.slug) === 'checkout') || pages.find((p: any) => /checkout/.test(String(p.slug)));
    // a store WITHOUT a checkout page cannot sell — that is a loud verdict, never a silently skipped
    // probe (a checkout-less store once shipped "clean" because this probe just didn't run)
    if (params2.archetype === 'store' && params2.shape !== 'landing' && !coPage)
      issues.push({ page: '(site)', viewport: 'desktop', kind: 'store-broken', detail: "this store has NO checkout page — the cart's Proceed button has nowhere to go and the store cannot sell", severity: 'high' });
    if (params2.archetype === 'store' && coPage) {
      // Find the shop page by WHERE THE PRODUCTS GRID ACTUALLY IS (the composed model), not by guessing
      // the slug — the LLM may name it menu/lineup/collection. This keeps the probe consistent with the
      // products-grid injection (which also accepts those names). Slug regex + pages[0] are fallbacks.
      const modelPages: any[] = (params2.site && Array.isArray(params2.site.pages)) ? params2.site.pages : [];
      const withProducts = modelPages.find((p: any) => (p.sections || []).some((s: any) => s.type === 'products'));
      const shopPage = (withProducts && pages.find((p: any) => p.slug === withProducts.slug))
        || pages.find((p: any) => /shop|store|product|catalog|menu|lineup|collection/.test(String(p.slug)))
        || pages[0];
      const sch2 = appdb.schemaName(projectId);
      const oCount = async () => { try { return Number((await pool.query(`select count(*)::int n from "${sch2}"."orders"`)).rows[0].n); } catch { return -1; } };
      try {
        await goto(page, url(shopPage.slug));
        await page.waitForFunction(`document.querySelectorAll('.p-add').length > 0`, { timeout: 8000 }).catch(() => {});
        const addBtns = await page.evaluate(`document.querySelectorAll('.p-add').length`).catch(() => 0);
        if (!addBtns) {
          issues.push({ page: shopPage.slug, viewport: 'desktop', kind: 'store-broken', detail: 'the shop grid shows no purchasable products (no Add-to-cart buttons rendered)', severity: 'high' });
        } else {
          // agency-grade imagery is a SYSTEM responsibility: product cards without photos are the
          // unanimous agency-panel blocker — the reviewer flags it so no build can ship it silently.
          const imgCards = await page.evaluate(`(function(){var c=document.querySelectorAll('.products .card');var n=0;c.forEach(function(x){if(x.querySelector('img'))n++});return {cards:c.length,withImg:n}})()`).catch(() => null) as any;
          if (imgCards && imgCards.cards > 0 && imgCards.withImg === 0)
            issues.push({ page: shopPage.slug, viewport: 'desktop', kind: 'no-product-imagery', detail: `all ${imgCards.cards} product cards rendered without a photo — the image enrichment did not run or failed`, severity: 'high' });
          // PDP (agency-panel pick): every product card must link to its own detail page, and the
          // reviewer OPENS one and buys FROM it — the detail page is part of the purchase path, not
          // decoration. A store whose grid is on the real products table without PDP links, or whose
          // detail page lacks the product name / Add-to-cart, cannot pass.
          const pdpHref = String(await page.evaluate(`(function(){var a=document.querySelector('.products .card a[href^="product-"]');return a?a.getAttribute('href'):''})()`).catch(() => '') || '');
          const gridTable = String(await page.evaluate(`(function(){var g=document.querySelector('.products[data-products]');return g?g.getAttribute('data-products'):''})()`).catch(() => '') || '');
          if (!/^product-\d+\.html$/.test(pdpHref)) {
            if (gridTable === 'products') issues.push({ page: shopPage.slug, viewport: 'desktop', kind: 'no-product-detail', detail: 'product cards do not link to product detail pages — a shopper cannot view a product before buying', severity: 'high' });
          } else {
            // EVERY product's detail page must load (the generic link audit snapshots before the grid
            // populates, so PDP links are load-tested here, where the grid is proven rendered).
            const allPdp = ((await page.evaluate(`Array.from(document.querySelectorAll('.products .card a[href^="product-"]')).map(function(a){return a.getAttribute('href')})`).catch(() => [])) as any[]) || [];
            for (const t of [...new Set(allPdp.filter((h) => /^product-\d+\.html$/.test(String(h))))].slice(0, 24)) {
              try { const r = await fetch(`${baseUrl}/sites/${projectId}/${t}`); const body = await r.text(); if (!r.ok || body.length < 400) issues.push({ page: String(t), viewport: 'all', kind: 'broken-link', detail: `product detail page "${t}" does not load (status ${r.status}, ${body.length}b)`, severity: 'high' }); }
              catch { issues.push({ page: String(t), viewport: 'all', kind: 'broken-link', detail: `product detail page "${t}" failed to load`, severity: 'high' }); }
            }
            await goto(page, `${baseUrl}/sites/${projectId}/${pdpHref}`);
            const pd: any = await page.evaluate(`(function(){var t=document.querySelector('.pdp h1'),b=document.querySelector('.pdp .p-add');return{title:t?(t.textContent||'').trim():'',add:!!b}})()`).catch(() => null);
            if (!pd || !pd.title || !pd.add)
              issues.push({ page: pdpHref.replace(/\.html$/, ''), viewport: 'desktop', kind: 'store-broken', detail: `the product detail page (${pdpHref}) is missing its ${!pd || !pd.title ? 'product name' : 'Add-to-cart button'}`, severity: 'high' });
            else await page.evaluate(`document.querySelector('.pdp .p-add').click()`).catch(() => {});   // buy FROM the detail page
            await page.waitForTimeout(300);
            await goto(page, url(shopPage.slug));
            await page.waitForFunction(`document.querySelectorAll('.p-add').length > 0`, { timeout: 8000 }).catch(() => {});
          }
          // defensive: never throw on an empty grid (a repopulation timeout must degrade to an honest
          // finding via the no-order path, not crash the probe into a false 'buy-flow probe failed')
          await page.evaluate(`(function(){var b=document.querySelectorAll('.p-add');if(!b.length)return;b[0].click();if(b.length>1)b[1].click();else b[0].click()})()`).catch(() => {});
          await page.waitForTimeout(400);
          const before2 = await oCount();
          await goto(page, url(coPage.slug));
          const done2: any = await page.evaluate(`new Promise(function(res){var f=document.querySelector('form.rcheckout');if(!f)return res({no_form:true});f.querySelector('[name=customer_name]').value='QA Buyer';f.querySelector('[name=email]').value='qa-buyer@relay.test';var ph=f.querySelector('[name=phone]');if(ph)ph.value='000';f.requestSubmit?f.requestSubmit():f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));setTimeout(function(){var m=f.querySelector('.rform-msg');res({msg:m?String(m.textContent):''})},4000)})`).catch(() => null);
          let after2 = await oCount();
          for (let k = 0; k < 6 && after2 <= before2; k++) { await page.waitForTimeout(500); after2 = await oCount(); }
          if (done2?.no_form) issues.push({ page: coPage.slug, viewport: 'desktop', kind: 'store-broken', detail: 'the checkout page has no checkout form', severity: 'high' });
          else if (before2 < 0 || after2 <= before2) issues.push({ page: coPage.slug, viewport: 'desktop', kind: 'store-broken', detail: 'checkout submitted but NO order row landed in the database — the store cannot sell', severity: 'high' });
          else {
            const li = Number((await pool.query(`select count(*)::int n from "${sch2}"."order_items" oi join "${sch2}"."orders" o on o.id=oi.order_id where o.email='qa-buyer@relay.test'`)).rows[0].n);
            if (li < 1) issues.push({ page: coPage.slug, viewport: 'desktop', kind: 'store-broken', detail: 'an order row landed but with no line items', severity: 'high' });
            // clean up the probe purchase
            await pool.query(`delete from "${sch2}"."order_items" where order_id in (select id from "${sch2}"."orders" where email='qa-buyer@relay.test')`).catch(() => {});
            await pool.query(`delete from "${sch2}"."orders" where email='qa-buyer@relay.test'`).catch(() => {});
          }
        }
      } catch (e: any) {
        issues.push({ page: coPage.slug, viewport: 'desktop', kind: 'store-broken', detail: 'buy-flow probe failed: ' + String(e?.message ?? e).slice(0, 120), severity: 'high' });
      }
    }

    // forms: scan every page, PREFER the typed form (data-table), submit it, prove it landed
    // (real table or submissions bucket), then clean up.
    await page.setViewportSize({ width: 1280, height: 900 });
    const formPages: { slug: string; typed: boolean }[] = [];
    for (const pg of pages) {
      await goto(page, url(pg.slug));
      const fi: any = await page.evaluate(FORMINFO).catch(() => null);
      if (fi) formPages.push({ slug: pg.slug, typed: !!(typeof fi.table === 'string' && /^[a-z_][a-z0-9_]*$/.test(fi.table)) });
    }
    // M2 GATE (site-level): an app with a real database must have its core action as a TYPED form —
    // a contact-bucket form on a booking/ordering app is decoration, not the product.
    if (!formPages.some((f) => f.typed)) {
      try {
        const desc = await appdb.describeSchema(pool, projectId);
        if ((desc.tables || []).length) issues.push({ page: '(site)', viewport: 'desktop', kind: 'form-schema-mismatch', detail: `this app has a real database (${desc.tables.map((t: any) => t.table).join(', ')}) but no form writes to it${formPages.length ? ' (only a generic contact form shipped)' : ' (no form shipped at all)'} — the core action must be a typed form on a real table`, severity: 'high' });
      } catch {}
    }
    for (const pg of (formPages.filter((f) => f.typed)[0] ? pages.filter((p) => p.slug === formPages.filter((f) => f.typed)[0].slug) : pages)) {
      await goto(page, url(pg.slug));
      let info: any = await page.evaluate(FORMINFO).catch(() => null);
      if (!info) continue;
      nForms++;
      const table = (typeof info.table === 'string' && /^[a-z_][a-z0-9_]*$/.test(info.table)) ? info.table : '';
      const sch = table ? appdb.schemaName(projectId) : '';
      // M2 GATE: the rendered form must MATCH the schema — every required column present, every
      // relation dropdown filled with real records. Compiled-from-schema is VERIFIED, never assumed.
      if (table) {
        await page.waitForFunction(`(function(){var ok=true;document.querySelectorAll('form.rform select[data-ref]').forEach(function(s){if(s.options.length<2)ok=false});return ok})()`, { timeout: 6000 }).catch(() => {});
        info = (await page.evaluate(FORMINFO).catch(() => null)) || info;
        try {
          const expected = await appdb.formColumns(pool, projectId, table);
          const domNames = new Set(((info.fields || []) as any[]).map((f: any) => String(f.name)));
          const missing = expected.filter((c: any) => !c.nullable && !domNames.has(c.name)).map((c: any) => c.name);
          if (missing.length) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'form-schema-mismatch', detail: `form on "${table}" is missing required schema field(s): ${missing.join(', ')} — form fields must be generated from the data model`, severity: 'high' });
          for (const f of ((info.fields || []) as any[]).filter((x: any) => x.ref && /^[a-z_][a-z0-9_]*$/.test(x.ref))) {
            let refRows = 0;
            try { refRows = Number((await pool.query(`select count(*)::int n from "${sch}"."${f.ref}"`)).rows[0].n); } catch {}
            if (refRows > 0 && f.options <= 1) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'empty-ref-dropdown', detail: `the "${f.name}" dropdown should list ${refRows} real record(s) from "${f.ref}" but shows none — relation options aren't loading`, severity: 'high' });
            // a REQUIRED relation with an empty referenced table = an unsubmittable form (no option to pick)
            else if (refRows === 0 && f.required) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'empty-ref-dropdown', detail: `the required "${f.name}" dropdown has nothing to offer — referenced table "${f.ref}" is EMPTY. The data model must seed tables referenced by required relations.`, severity: 'high' });
          }
        } catch {}
      }
      const count = async () => table
        ? Number((await pool.query(`select coalesce(max(id),0)::int n from "${sch}"."${table}"`)).rows[0].n)
        : Number((await pool.query('select count(*)::int n from site_submissions where project_id=$1', [projectId])).rows[0].n);
      const before = await count();
      const r = await page.evaluate(SUBMIT).catch(() => null);
      let after = await count();
      for (let k = 0; k < 8 && after <= before; k++) { await page.waitForTimeout(500); after = await count(); }
      if (after <= before) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'form-not-persisted', detail: table ? `"add" form did not create a row in "${table}"` : 'form submission did not reach the database', severity: 'high' });
      else if (!(r as any)?.ok && !String(page.url()).includes('receipt-')) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'form-no-confirmation', detail: 'row saved, but the visitor saw no confirmation message', severity: 'low' });
      // FS1 · THE RECEIPT (act-probe): a visitor's action must answer back. The probe reads the new
      // row's token straight from the DB (never from mail), proves the receipt page renders, a wrong
      // token 404s, and the token never leaks through the public read API.
      if (table && after > before && PRIVATE_READ.test(table)) {
        try {
          const tok = (await pool.query(`select ref_token from "${sch}"."${table}" where id=(select max(id) from "${sch}"."${table}")`)).rows[0]?.ref_token;
          if (!tok) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'no-receipt', detail: `the new "${table}" row has no receipt token — the visitor gets no way back to their record`, severity: 'high' });
          else {
            const rp = await fetch(`${baseUrl}/sites/${projectId}/receipt-${table}-${tok}.html`);
            const rbody = await rp.text();
            if (!rp.ok || rbody.length < 400) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'no-receipt', detail: `the receipt page for "${table}" does not load (status ${rp.status})`, severity: 'high' });
            const bad = await fetch(`${baseUrl}/sites/${projectId}/receipt-${table}-${'0'.repeat(32)}.html`);
            if (bad.ok) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'receipt-not-private', detail: 'a WRONG receipt token still renders a page — receipts are not actually secret', severity: 'high' });
            const pub = await (await fetch(`${baseUrl}/api/site/${projectId}/data/${table}`)).text();
            if (pub.includes(tok)) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'receipt-not-private', detail: 'the receipt token leaks through the public read API', severity: 'high' });
          }
        } catch (e: any) { issues.push({ page: pg.slug, viewport: 'desktop', kind: 'no-receipt', detail: 'receipt probe failed: ' + String(e?.message ?? e).slice(0, 100), severity: 'high' }); }
        // FS2 · THE ACCOUNT DOOR: account.html serves the sign-in form; a magic link (minted directly
        // — probes never send real mail) signs the BROWSER in; My bookings lists the probe's own row.
        try {
          const acct = await fetch(`${baseUrl}/sites/${projectId}/account.html`);
          const acctBody = await acct.text();
          if (!acct.ok || !acctBody.includes('relayVisitorRequest'))
            issues.push({ page: 'account', viewport: 'desktop', kind: 'no-account', detail: 'account.html does not serve the sign-in form — the app has no visitor accounts', severity: 'high' });
          else {
            const V = await import('./visitors.ts');
            const rq = await V.requestVisitorMagic(pool, projectId, 'qa@example.com');   // the form probe books with this email
            if (rq.token) {
              await goto(page, `${baseUrl}/api/site/${projectId}/visitor/verify?token=${rq.token}`);
              const my: any = await page.evaluate(`(function(){var r=document.querySelector('#records');return{records:!!r,rows:r?r.querySelectorAll('.card').length:0,me:(document.body.textContent||'').indexOf('qa@example.com')>=0}})()`).catch(() => null);
              if (!my || !my.records || !my.me) issues.push({ page: 'account', viewport: 'desktop', kind: 'no-account', detail: 'the magic link did not sign the browser in to My bookings', severity: 'high' });
              else if (my.rows < 1) issues.push({ page: 'account', viewport: 'desktop', kind: 'no-account', detail: 'My bookings is empty although this visitor just booked with this email', severity: 'high' });
              const schV = appdb.schemaName(projectId);
              await pool.query(`delete from "${schV}"."_relay_visitor_tokens" where visitor_id in (select id from "${schV}"."_relay_visitors" where email='qa@example.com')`).catch(() => {});
              await pool.query(`delete from "${schV}"."_relay_visitors" where email='qa@example.com'`).catch(() => {});
            }
          }
        } catch (e: any) { issues.push({ page: 'account', viewport: 'desktop', kind: 'no-account', detail: 'account probe failed: ' + String(e?.message ?? e).slice(0, 100), severity: 'high' }); }
      }
      // FS0 · PRIVACY: what a visitor just submitted about themselves must NOT be publicly listable.
      // The reviewer checks the LIVE public API right after its own submission landed.
      if (table && after > before && PRIVATE_READ.test(table)) {
        try {
          const pub: any = await (await fetch(`${baseUrl}/api/site/${projectId}/data/${table}`)).json();
          if (((pub && pub.rows) || []).length > 0)
            issues.push({ page: pg.slug, viewport: 'desktop', kind: 'private-data-public', detail: `table "${table}" is publicly listable through the read API — a visitor's ${table} are on display to anyone`, severity: 'high' });
        } catch {}
      }
      if (table) await pool.query(`delete from "${sch}"."${table}" where id > $1`, [before]).catch(() => {});
      else await pool.query("delete from site_submissions where project_id=$1 and (data->>'message'='Automated QA check — please ignore.' or data->>'name' like 'QA Test%')", [projectId]).catch(() => {});
      break;
    }
  });
  return { issues, checked: { pages: pages.length, buttons: nButtons, links: nLinks, linkTargets: targets.size, forms: nForms, collections: nColls } };
}

// Auto-run on completion. The browser module already limits concurrency, so no separate launch-storm
// queue is needed. The verdict is LOAD-BEARING (self-correcting loop) and recorded for the board.
export async function dogfoodSite(pool: pg.Pool, projectId: string, baseUrl?: string): Promise<void> {
  try { const h = await fetch((baseUrl || 'http://localhost:' + (process.env.PORT || 8787)) + '/healthz'); if (!h.ok) return; } catch { return; }
  const base = baseUrl || 'http://localhost:' + (process.env.PORT || 8787);
  try {
    const { issues, checked } = await dogfood(pool, projectId, base);
    const high = issues.filter(i => i.severity === 'high').length;
    const summary = issues.length
      ? `${issues.length} issue(s), ${high} high — ` + issues.slice(0, 8).map(i => `${i.page}/${i.viewport}:${i.kind}`).join('; ')
      : `clean — one nav + one logo per page (no duplicates, no drift), ${checked.buttons} buttons across ${checked.pages} pages all labelled + every link target loads (${checked.linkTargets} checked), ${checked.forms} form(s) submit+persist, ${checked.collections} collection(s) live, headers aligned`;
    await pool.query(`create table if not exists dogfood_reviews (id bigserial primary key, project_id uuid, passed boolean not null default false, summary text, issues jsonb not null default '[]'::jsonb, checked jsonb not null default '{}'::jsonb, at timestamptz not null default now())`).catch(() => {});
    await pool.query('insert into dogfood_reviews(project_id, passed, summary, issues, checked) values ($1,$2,$3,$4,$5)', [projectId, high === 0, summary, JSON.stringify(issues), JSON.stringify(checked)]);
    // Persist every HIGH-severity finding to spec_findings (board visibility + future analysis).
    // Non-blocking via .catch so a logging insert never breaks the dogfood verdict.
    for (const issue of (issues ?? [])) {
      if (issue && issue.severity === 'high') {
        await pool.query(
          "insert into spec_findings(project_id, finding, selector, screenshot_path) values ($1, $2, $3, $4)",
          [projectId, `[${issue.page}/${issue.viewport}] ${issue.kind}: ${issue.detail}`, null, null]
        ).catch((e: any) => console.error('spec_findings insert', e?.message ?? e));
      }
    }
    await ev(pool, projectId, null, 'dogfood', summary);

    // SELF-CORRECTING LOOP (one round). Content findings live in the composed SITE MODEL — page renders
    // are deterministic projections of it, so re-rendering alone can never fix them (and the old query
    // targeted department='build', which the CMS-first planner no longer creates: the loop was dead).
    // Repair = re-block every render + QA, then re-open COMPOSE with the findings as feedback (the
    // runner feeds the latest verify_failed on a task back into its prompt); the fn_unblock trigger
    // cascades render → qa as the new model lands. Legacy per-page 'build' projects (eval harness)
    // keep the direct per-page re-open.
    if (high) {
      const repairs = Number((await pool.query("select count(*)::int n from run_events where project_id=$1 and type='dogfood_repair'", [projectId])).rows[0].n);
      const pageSlugs = ((await pool.query('select params from projects where id=$1', [projectId])).rows[0]?.params?.pages || []).map((p: any) => p.slug);
      const plan = repairPlan(issues, pageSlugs);
      // site-level content findings (page '(site)') can't map to a slug but a recompose CAN fix them
      const siteWide = issues.filter(i => i.severity === 'high' && CONTENT_FIXABLE.has(i.kind) && String(i.page || '') === '(site)').map(i => `${i.kind}: ${i.detail}`);
      if ((plan.length || siteWide.length) && repairs < 1) {
        const compose = (await pool.query("select id from tasks where project_id=$1 and department='compose'", [projectId])).rows[0];
        let reopened = 0;
        if (compose) {
          const notes = [...siteWide, ...plan.map(({ slug, notes }) => `${slug}: ${notes.slice(0, 4).join(' · ')}`)].join(' — ');
          await pool.query("update tasks set status='blocked', claimed_by=null, lease_expires_at=null, updated_at=now() where project_id=$1 and department in ('render','qa')", [projectId]);
          await ev(pool, projectId, compose.id, 'verify_failed', `interaction review found problems the site model must FIX: ${notes}`.slice(0, 1800));
          await pool.query("update tasks set status='ready', claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1", [compose.id]);
          reopened = plan.length + siteWide.length;
        } else {
          for (const { slug, notes } of plan) {
            const t = (await pool.query("select id from tasks where project_id=$1 and department='build' and artifact=$2", [projectId, slug + '.html'])).rows[0];
            if (!t) continue;
            await ev(pool, projectId, t.id, 'verify_failed', `interaction review found problems on this page — FIX them: ${notes.slice(0, 4).join(' · ')}`);
            await pool.query("update tasks set status='ready', claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1", [t.id]);
            reopened++;
          }
        }
        if (reopened) {
          await ev(pool, projectId, null, 'dogfood_repair', `${compose ? 're-composing the site model + re-rendering every page' : `re-building ${reopened} page(s)`} from the interaction review (round ${repairs + 1})`);
          await pool.query("update projects set status='running' where id=$1", [projectId]);
          const { runLoop } = await import('./runner.ts');
          runLoop(pool, projectId, { cap: 4, review: true }).catch(() => {});   // rebuild, then re-review
        }
      }
    }
  } catch (e: any) { await ev(pool, projectId, null, 'dogfood', 'reviewer error: ' + (e?.message ?? e)).catch(() => {}); }
}

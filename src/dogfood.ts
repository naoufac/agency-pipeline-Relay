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
import { withPage } from './browser.ts';

export type Issue = { page: string; viewport: string; kind: string; detail: string; severity: 'high' | 'medium' | 'low' };

// Self-correction: which findings a REBUILD-with-feedback can plausibly fix (content the LLM controls)
// vs. system/CSS issues a rebuild can't (header/overflow → surfaced to a developer instead).
const CONTENT_FIXABLE = new Set(['dead-button', 'garbage-button', 'broken-link', 'empty-collection', 'collection-not-rendering', 'form-not-persisted', 'form-schema-mismatch']);
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
const FORMINFO = `(function(){var f=document.querySelector('form.rform');if(!f)return null;var fields=[];f.querySelectorAll('input,textarea,select').forEach(function(el){if(!el.name)return;fields.push({name:el.name,tag:el.tagName.toLowerCase(),required:!!el.required,ref:el.getAttribute('data-ref')||null,options:el.tagName==='SELECT'?el.options.length:0})});return{table:f.getAttribute('data-table')||'',fields:fields}})()`;
const SUBMIT = `new Promise(res=>{var f=document.querySelector('form.rform');if(!f)return res({form:false});var tbl=f.getAttribute('data-table')||'';f.querySelectorAll('input,textarea,select').forEach(function(el,i){if(el.tagName==='SELECT'){if(el.options.length>1)el.selectedIndex=1;el.dispatchEvent(new Event('change',{bubbles:true}));return;}var t=(el.type||'').toLowerCase();if(t==='checkbox'){el.checked=true;}else if(t==='number'){el.value=String(10+i);}else if(t==='email'){el.value='qa@example.com';}else if(t==='date'){el.value='2026-01-01';}else if(el.tagName==='TEXTAREA'){el.value='Automated QA check — please ignore.';}else{el.value='QA Test '+i;}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});try{f.requestSubmit?f.requestSubmit():f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))}catch(e){}setTimeout(function(){var m=f.querySelector('.rform-msg');var t=m?(m.textContent||''):'';res({form:true,table:tbl,msg:t.trim(),ok:/thank|got your|received|success|added/i.test(t)})},3500)})`;

export async function dogfood(pool: pg.Pool, projectId: string, baseUrl = 'http://localhost:8787'): Promise<{ issues: Issue[]; checked: { pages: number; buttons: number; links: number; linkTargets: number; forms: number; collections: number } }> {
  const proj = await pool.query('select params from projects where id=$1', [projectId]);
  const pages = (proj.rows[0]?.params?.pages) || [{ slug: 'index', title: 'Home' }];
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
        for (const a of links) {
          const lt = String(a.text || '').toLowerCase().trim();
          if (a.btn) {
            nButtons++;
            if (!a.text || lt === '[object object]' || lt === 'undefined' || lt === 'null') issues.push({ page: pg.slug, viewport: vp.name, kind: 'garbage-button', detail: `button has no real label (text="${a.text}", href="${a.href}")`, severity: 'high' });
            if (!a.href || a.href === '#' || a.href === '') issues.push({ page: pg.slug, viewport: vp.name, kind: 'dead-button', detail: `CTA "${a.text}" goes nowhere (href="${a.href}")`, severity: 'high' });
          }
          nLinks++;
          if (vp.name === 'desktop' && /^[^#?:/][^#?:]*\.html(#.*)?$/.test(a.href)) targets.add(a.href.split('#')[0]);
        }
        if (vp.name === 'desktop') {
          await page.waitForFunction('(function(){var e=document.querySelector(".collection[data-table]");return !e||e.querySelector(".card")})()', { timeout: 5000 }).catch(() => {});
          for (const c of (((await page.evaluate(COLLS).catch(() => [])) as any[]) || [])) {
            nColls++;
            let apiRows = -1;
            if (c.table && /^[a-z_][a-z0-9_]*$/.test(c.table)) { try { const d: any = await (await fetch(`${baseUrl}/api/site/${projectId}/data/${c.table}`)).json(); apiRows = (d.rows || []).length; } catch {} }
            if (!c.cards && apiRows > 0) issues.push({ page: pg.slug, viewport: vp.name, kind: 'collection-not-rendering', detail: `collection "${c.table}" has ${apiRows} rows in the DB but rendered 0 — the page isn't loading its data`, severity: 'high' });
          }
        }
      }
    }
    // one site = one logo: flag any per-page logo drift (the deterministic site_consistent gate also
    // enforces this, but the reviewer must SEE and report it — the verdict is what's shown on the board)
    if (siteLogos.size > 1) issues.push({ page: '(site)', viewport: 'all', kind: 'logo-drift', detail: `the logo differs across pages: ${[...siteLogos].map(l => JSON.stringify(l)).join(' · ')} — one website must show one logo`, severity: 'high' });
    // load-test every internal link target across the whole site (broken nav / wrong links anywhere)
    for (const t of targets) {
      try { const r = await fetch(`${baseUrl}/sites/${projectId}/${t}`); const body = await r.text(); if (!r.ok || body.length < 400) issues.push({ page: t, viewport: 'all', kind: 'broken-link', detail: `link target "${t}" does not load (status ${r.status}, ${body.length}b)`, severity: 'high' }); }
      catch { issues.push({ page: t, viewport: 'all', kind: 'broken-link', detail: `link target "${t}" failed to load`, severity: 'high' }); }
    }
    // forms: type + submit the first form, prove it landed (real table or submissions bucket), then clean up
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const pg of pages) {
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
      else if (!(r as any)?.ok) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'form-no-confirmation', detail: 'row saved, but the visitor saw no confirmation message', severity: 'low' });
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
      if (plan.length && repairs < 1) {
        const compose = (await pool.query("select id from tasks where project_id=$1 and department='compose'", [projectId])).rows[0];
        let reopened = 0;
        if (compose) {
          const notes = plan.map(({ slug, notes }) => `${slug}: ${notes.slice(0, 4).join(' · ')}`).join(' — ');
          await pool.query("update tasks set status='blocked', claimed_by=null, lease_expires_at=null, updated_at=now() where project_id=$1 and department in ('render','qa')", [projectId]);
          await ev(pool, projectId, compose.id, 'verify_failed', `interaction review found problems the site model must FIX: ${notes}`.slice(0, 1800));
          await pool.query("update tasks set status='ready', claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1", [compose.id]);
          reopened = plan.length;
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

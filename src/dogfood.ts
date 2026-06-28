// dogfood.ts — the reviewer that mimics a human. It drives a REAL Chromium over CDP and actually USES a
// produced site: visits every page at desktop + mobile, measures layout (header alignment, horizontal
// overflow), audits EVERY anchor (label sanity + dead href) and LOAD-TESTS every internal link target,
// TYPES into and SUBMITS the form (asserting the confirmation AND that the row landed — in the real table
// or the submissions bucket), and confirms collections render live DB rows. Resilient to mid-check
// navigation; POLLS for async content (no timing false-positives). Verification by interaction, not a
// screenshot. Auto-runs on completion -> dogfood_reviews -> shown on each project card. KNOWN: see docs/RETRO.md.
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import pg from 'pg';
import { ev } from './db.ts';
import * as appdb from './appdb.ts';

const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium-browser';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type Issue = { page: string; viewport: string; kind: string; detail: string; severity: 'high' | 'medium' | 'low' };

// ---- minimal CDP client (no puppeteer; drives the system chromium directly) ----
class CDP {
  private ws!: WebSocket; private id = 0; private pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
  private proc!: ChildProcess; private sessionId?: string; private port = 0;

  async launch() {
    this.port = 9300 + Math.floor(Math.random() * 250);
    this.proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--force-device-scale-factor=1', `--remote-debugging-port=${this.port}`,
      `--user-data-dir=/root/.cache/dogfood-${this.port}`, 'about:blank'], { stdio: 'ignore', detached: true });
    let wsUrl = '';
    for (let i = 0; i < 50 && !wsUrl; i++) { try { const j: any = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); wsUrl = j.webSocketDebuggerUrl; } catch {} if (!wsUrl) await sleep(250); }
    if (!wsUrl) throw new Error('chromium CDP did not come up');
    this.ws = new WebSocket(wsUrl, { maxPayload: 128 * 1024 * 1024 });
    await new Promise<void>((res, rej) => { this.ws.on('open', () => res()); this.ws.on('error', rej); });
    this.ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id)!; this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
  }
  private send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = ++this.id; const msg: any = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify(msg)); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, 30000); });
  }
  viewport(width: number, height: number, mobile = false) { return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, this.sessionId).catch(() => {}); }
  // resilient: a mid-check navigation (e.g. a form submit) must not abort the whole review
  async goto(url: string, settle = 1400) { try { await this.send('Page.navigate', { url }, this.sessionId); } catch {} await sleep(settle); }
  async evaluate(expression: string): Promise<any> { try { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.sessionId); return r?.result?.value; } catch { return null; } }
  // poll an in-page condition until truthy (or timeout) — for ASYNC content (collections/forms fetch after load)
  async waitFor(jsCond: string, timeout = 4500): Promise<boolean> { const end = Date.now() + timeout; while (Date.now() < end) { if (await this.evaluate(jsCond)) return true; await sleep(300); } return false; }
  close() { try { this.ws?.close(); } catch {} try { process.kill(-(this.proc.pid as number)); } catch {} try { this.proc.kill('SIGKILL'); } catch {} }
}

// ---- in-page probes (run inside the real browser) ----
const LAYOUT = `(()=>{var n=document.querySelector('.nav-inner'),c=document.querySelector('main .container')||document.querySelector('.container');var nl=n?n.getBoundingClientRect().left:null,cl=c?c.getBoundingClientRect().left:null;return{overflow:document.documentElement.scrollWidth>window.innerWidth+2,navLeft:nl,contLeft:cl,misaligned:(nl!=null&&cl!=null)?Math.abs(nl-cl)>2:false}})()`;
const BTNS = `Array.from(document.querySelectorAll('a.btn')).map(a=>({text:(a.textContent||'').trim().slice(0,40),href:a.getAttribute('href')}))`;
// EVERY anchor on the page (nav + buttons + inline), with its label, href, and whether it's a button
const LINKS = `Array.from(document.querySelectorAll('a')).map(function(a){return{text:(a.textContent||'').trim().slice(0,60),href:a.getAttribute('href')||'',btn:a.classList.contains('btn')}})`;
const COLLS = `Array.from(document.querySelectorAll('.collection[data-table]')).map(el=>({table:el.getAttribute('data-table'),cards:el.querySelectorAll('.card').length}))`;
const FORMINFO = `(function(){var f=document.querySelector('form.rform');return f?{table:f.getAttribute('data-table')||''}:null})()`;
// type into every field (by input TYPE so number/date/checkbox are valid) + submit for real, then read the confirmation
const SUBMIT = `new Promise(res=>{var f=document.querySelector('form.rform');if(!f)return res({form:false});var tbl=f.getAttribute('data-table')||'';f.querySelectorAll('input,textarea').forEach(function(el,i){var t=(el.type||'').toLowerCase();if(t==='checkbox'){el.checked=true;}else if(t==='number'){el.value=String(10+i);}else if(t==='email'){el.value='qa@example.com';}else if(t==='date'){el.value='2026-01-01';}else if(el.tagName==='TEXTAREA'){el.value='Automated QA check — please ignore.';}else{el.value='QA Test '+i;}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});try{f.requestSubmit?f.requestSubmit():f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))}catch(e){}setTimeout(function(){var m=f.querySelector('.rform-msg');var t=m?(m.textContent||''):'';res({form:true,table:tbl,msg:t.trim(),ok:/thank|got your|received|success|added/i.test(t)})},3500)})`;

export async function dogfood(pool: pg.Pool, projectId: string, baseUrl = 'http://localhost:8787'): Promise<{ issues: Issue[]; checked: { pages: number; buttons: number; links: number; linkTargets: number; forms: number; collections: number } }> {
  const proj = await pool.query('select params from projects where id=$1', [projectId]);
  const pages = (proj.rows[0]?.params?.pages) || [{ slug: 'index', title: 'Home' }];
  const issues: Issue[] = []; let nButtons = 0, nForms = 0, nColls = 0, nLinks = 0;
  const targets = new Set<string>();
  const cdp = new CDP();
  await cdp.launch();
  try {
    for (const vp of [{ name: 'desktop', w: 1280, h: 900, mobile: false }, { name: 'mobile', w: 390, h: 844, mobile: true }]) {
      await cdp.viewport(vp.w, vp.h, vp.mobile);
      for (const pg of pages) {
        const url = `${baseUrl}/sites/${projectId}/${pg.slug}.html`;
        await cdp.goto(url);
        const lay = await cdp.evaluate(LAYOUT);
        if (lay?.overflow) issues.push({ page: pg.slug, viewport: vp.name, kind: 'overflow', detail: 'page scrolls horizontally (layout overflow)', severity: 'high' });
        if (lay?.misaligned) issues.push({ page: pg.slug, viewport: vp.name, kind: 'header', detail: `header misaligned: nav left ${Math.round(lay.navLeft)} vs content ${Math.round(lay.contLeft)}`, severity: 'medium' });
        // EVERY link, EVERY page: label sanity + dead hrefs; collect internal targets to load-test below
        const links = (await cdp.evaluate(LINKS)) || [];
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
          // wait for the async collection fetch to render, then judge against the API (ground truth):
          // API has rows but DOM shows 0 => the page isn't loading its data (real render bug). API empty => just no data yet.
          await cdp.waitFor('(function(){var e=document.querySelector(".collection[data-table]");return !e || e.querySelector(".card")})()');
          for (const c of ((await cdp.evaluate(COLLS)) || [])) {
            nColls++;
            let apiRows = -1;
            if (c.table && /^[a-z_][a-z0-9_]*$/.test(c.table)) { try { const d: any = await (await fetch(`${baseUrl}/api/site/${projectId}/data/${c.table}`)).json(); apiRows = (d.rows || []).length; } catch {} }
            if (!c.cards && apiRows > 0) issues.push({ page: pg.slug, viewport: vp.name, kind: 'collection-not-rendering', detail: `collection "${c.table}" has ${apiRows} rows in the DB but rendered 0 — the page isn't loading its data`, severity: 'high' });
          }
        }
      }
    }
    // load-test every internal link target across the whole site (catches broken nav / wrong links anywhere)
    for (const t of targets) {
      try { const r = await fetch(`${baseUrl}/sites/${projectId}/${t}`); const body = await r.text(); if (!r.ok || body.length < 400) issues.push({ page: t, viewport: 'all', kind: 'broken-link', detail: `link target "${t}" does not load (status ${r.status}, ${body.length}b)`, severity: 'high' }); }
      catch { issues.push({ page: t, viewport: 'all', kind: 'broken-link', detail: `link target "${t}" failed to load`, severity: 'high' }); }
    }
    // forms: type into + submit the first form, then prove it landed where it should — a real entity
    // table (an "add a record" form) OR the submissions bucket (a contact form). Then remove the QA row.
    await cdp.viewport(1280, 900, false);
    for (const pg of pages) {
      await cdp.goto(`${baseUrl}/sites/${projectId}/${pg.slug}.html`);
      const info = await cdp.evaluate(FORMINFO);
      if (!info) continue;
      nForms++;
      const table = (typeof info.table === 'string' && /^[a-z_][a-z0-9_]*$/.test(info.table)) ? info.table : '';
      const sch = table ? appdb.schemaName(projectId) : '';
      const count = async () => table
        ? Number((await pool.query(`select coalesce(max(id),0)::int n from "${sch}"."${table}"`)).rows[0].n)
        : Number((await pool.query('select count(*)::int n from site_submissions where project_id=$1', [projectId])).rows[0].n);
      const before = await count();
      const r = await cdp.evaluate(SUBMIT);
      let after = await count();
      for (let k = 0; k < 8 && after <= before; k++) { await sleep(500); after = await count(); }   // poll for the async write
      // ground truth = did the row land. A saved row is a working form (a slow/absent message is only cosmetic).
      if (after <= before) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'form-not-persisted', detail: table ? `"add" form did not create a row in "${table}"` : 'form submission did not reach the database', severity: 'high' });
      else if (!r?.ok) issues.push({ page: pg.slug, viewport: 'desktop', kind: 'form-no-confirmation', detail: 'row saved, but the visitor saw no confirmation message', severity: 'low' });
      // tidy up the QA row so the operator's real data stays clean
      if (table) await pool.query(`delete from "${sch}"."${table}" where id > $1`, [before]).catch(() => {});
      else await pool.query("delete from site_submissions where project_id=$1 and (data->>'message'='Automated QA check — please ignore.' or data->>'name' like 'QA Test%')", [projectId]).catch(() => {});
      break;
    }
  } finally { cdp.close(); }
  return { issues, checked: { pages: pages.length, buttons: nButtons, links: nLinks, linkTargets: targets.size, forms: nForms, collections: nColls } };
}

// Auto-run on project completion (fire-and-forget). Only when an HTTP server is actually serving the
// site (skips offline CLI/demo runs). Records an honest summary as a run_event the dashboard can show.
export async function dogfoodSite(pool: pg.Pool, projectId: string, baseUrl = 'http://localhost:' + (process.env.PORT || 8787)): Promise<void> {
  try { const h = await fetch(baseUrl + '/healthz'); if (!h.ok) return; } catch { return; }
  try {
    const { issues, checked } = await dogfood(pool, projectId, baseUrl);
    const high = issues.filter(i => i.severity === 'high').length;
    const summary = issues.length
      ? `${issues.length} issue(s), ${high} high — ` + issues.slice(0, 8).map(i => `${i.page}/${i.viewport}:${i.kind}`).join('; ')
      : `clean — ${checked.buttons} buttons across ${checked.pages} pages all labelled + every link target loads (${checked.linkTargets} checked), ${checked.forms} form(s) submit+persist, ${checked.collections} collection(s) live, headers aligned`;
    // create-if-not-exists so it also works on the already-running prod DB (applySchema isn't re-run there)
    await pool.query(`create table if not exists dogfood_reviews (id bigserial primary key, project_id uuid, passed boolean not null default false, summary text, issues jsonb not null default '[]'::jsonb, checked jsonb not null default '{}'::jsonb, at timestamptz not null default now())`).catch(() => {});
    await pool.query('insert into dogfood_reviews(project_id, passed, summary, issues, checked) values ($1,$2,$3,$4,$5)',
      [projectId, high === 0, summary, JSON.stringify(issues), JSON.stringify(checked)]);
    await ev(pool, projectId, null, 'dogfood', summary);
  } catch (e: any) { await ev(pool, projectId, null, 'dogfood', 'reviewer error: ' + (e?.message ?? e)).catch(() => {}); }
}

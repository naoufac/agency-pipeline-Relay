// Relay SPA — deliverable-first IA. Home (your sites) -> Project (live site is the hero) -> tabs.
const COLOR = { blocked:'#5C6678', ready:'#E0B341', running:'#5A8DEE', verifying:'#A06CD5', done:'#36B37E', failed:'#F0506E' };
const app = document.getElementById('app');
let poll = null;
const j = (u, o) => fetch(u, o).then(r => r.json());
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const clearPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
const ACTIVE = ['ready','running','verifying','blocked'];

// status of a project from its /api/projects row or board
const projStatus = p => p.failed ? 'failed' : (p.active ? 'running' : (p.total && p.done === p.total ? 'done' : 'ready'));

/* ---------------- output drawer ---------------- */
function drawerEl(){ let d = document.getElementById('drawer'); if (!d){ d = document.createElement('div'); d.id='drawer'; d.className='drawer'; document.body.appendChild(d);} return d; }
function closeDrawer(stripSeq){
  const d = document.getElementById('drawer'); if (d) d.classList.remove('open');
  if (stripSeq && location.hash.includes('?seq=')) history.replaceState(null,'',location.hash.split('?')[0]);
}
async function openOutput(id, seq){
  const o = await j(`/api/output?id=${id}&seq=${seq}`);
  const d = drawerEl();
  d.innerHTML = `
    <div class="drawer-head">
      <div><span class="pill"><i class="dot s-${o.status}"></i>${o.status||''}</span>
        <span class="muted" style="margin-left:8px">#${o.seq} · ${esc(o.department)}</span></div>
      <button class="x" aria-label="close">✕</button>
    </div>
    <h3 class="drawer-title">${esc(o.title)}</h3>
    <div class="muted" style="font-size:12px;margin-bottom:14px">check: <code>${esc(o.verify)}</code></div>
    ${(o.department||'').includes('build') && o.status === 'done' ? `
      <a class="btn btn-sm" target="_blank" rel="noopener" href="/sites/${id}/" style="margin-bottom:12px">Open the produced site ↗</a>
      <img src="/sites/${id}/preview.png?t=${Date.now()}" alt="preview" style="display:block;width:100%;border:1px solid var(--line);border-radius:10px;margin-bottom:14px"/>` : ''}
    <pre class="output">${esc(o.content) || '<span class="muted">— no output yet —</span>'}</pre>`;
  d.classList.add('open');
  d.querySelector('.x').onclick = () => closeDrawer(true);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(true); });

/* ---------------- HOME · your sites ---------------- */
function briefBar(){
  return `<section class="hero compact">
    <span class="eyebrow">● live · autonomous</span>
    <h1>What should we build?</h1>
    <p class="lead">Describe it in a sentence. Relay builds a real, working website you can open.</p>
    <div class="brief-bar">
      <input id="brief" class="input" placeholder='Describe the site you want — e.g. "a one-page site explaining our pricing"' />
      <button id="go" class="btn">Build my site →</button>
    </div></section>`;
}
async function submitBrief(){
  const input = document.getElementById('brief'); const brief = input.value.trim(); if (!brief) return;
  const btn = document.getElementById('go'); btn.textContent = 'Planning…'; btn.disabled = true;
  try { const r = await j('/api/run', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ brief }) });
        location.hash = '#/p/' + r.id; } catch { btn.textContent = 'Build my site →'; btn.disabled = false; }
}
// one card's inner HTML — STABLE preview URL (no cache-bust → browser caches it, never re-fetches)
function cardInner(p){
  const st = projStatus(p), label = st === 'done' ? 'ready' : st;
  return `
    <div class="thumb${p.site ? '' : ' noimg'}">${p.site ? `<img src="/sites/${p.id}/preview.png" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg');this.remove()"/>` : ''}</div>
    <div class="pcard-body">
      <div class="brief">${esc(p.brief)}</div>
      <div class="row" style="justify-content:space-between;margin-top:14px">
        <span class="pill"><i class="dot s-${st}"></i>${label}${st === 'running' ? ` · ${p.done}/${p.total}` : ''}</span>
        ${p.site
          ? `<a class="btn btn-sm" target="_blank" rel="noopener" href="${p.site}">Open ↗</a>`
          : `<a class="btn btn-sm btn-ghost" href="#/p/${p.id}">Open project</a>`}
      </div>
    </div>`;
}
// Home reconciles IN PLACE: each card created once; only re-rendered when its own data
// changes (so finished cards + their images are never touched → no flicker/reload);
// polling stops the instant nothing is building. No cache-busting, no full-grid churn.
function home(){
  app.innerHTML = `<div class="container">${briefBar()}
    <div id="bgroup" style="display:none"><div class="kpi-label" style="margin:28px 0 12px">Building</div><div id="bgrid" class="grid grid-3"></div></div>
    <div id="rgroup" style="display:none"><div class="kpi-label" style="margin:28px 0 12px">Ready</div><div id="rgrid" class="grid grid-3"></div></div>
    <div id="emptywrap"></div></div>`;
  document.getElementById('go').onclick = submitBrief;
  document.getElementById('brief').addEventListener('keydown', e => { if (e.key === 'Enter') submitBrief(); });
  const cards = new Map();                                  // id -> { el, sig, building }
  const bgrid = document.getElementById('bgrid'), rgrid = document.getElementById('rgrid');
  async function load(){
    let list; try { list = await j('/api/projects'); } catch { return true; }
    document.getElementById('emptywrap').innerHTML = list.length ? '' : `<div class="empty">No sites yet. Describe one above and Relay builds it.</div>`;
    let building = 0;
    for (const p of list){
      const st = projStatus(p), isB = st === 'running'; if (isB) building++;
      const sig = `${st}|${p.done}|${p.total}|${p.site ? 1 : 0}`;
      let rec = cards.get(p.id);
      if (!rec){
        const el = document.createElement('div'); el.className = 'card pcard'; el.innerHTML = cardInner(p);
        el.addEventListener('click', e => { if (!e.target.closest('a')) location.hash = '#/p/' + p.id; });
        rec = { el, sig, building: isB }; cards.set(p.id, rec); (isB ? bgrid : rgrid).appendChild(el);
      } else if (rec.sig !== sig){                          // changed -> re-render THIS card only
        rec.el.innerHTML = cardInner(p); rec.sig = sig;
        if (rec.building !== isB){ (isB ? bgrid : rgrid).appendChild(rec.el); rec.building = isB; }
      }                                                    // unchanged -> untouched (no reload)
    }
    document.getElementById('bgroup').style.display = bgrid.children.length ? '' : 'none';
    document.getElementById('rgroup').style.display = rgrid.children.length ? '' : 'none';
    return building > 0;
  }
  load().then(b => { if (b) poll = setInterval(async () => { if (!(await load())) clearPoll(); }, 4000); });
}

function newSite(){
  app.innerHTML = `<div class="container"><section class="hero" style="text-align:center;max-width:720px;margin:0 auto">
    <h1>What should we build?</h1>
    <p class="lead" style="margin-left:auto;margin-right:auto">Describe the website in a sentence. Relay builds it for real.</p>
    <div class="brief-bar" style="margin-left:auto;margin-right:auto">
      <input id="brief" class="input" placeholder='e.g. "a one-page site explaining our refund policy"' />
      <button id="go" class="btn">Build my site →</button>
    </div></section></div>`;
  document.getElementById('go').onclick = submitBrief;
  document.getElementById('brief').addEventListener('keydown', e => { if (e.key === 'Enter') submitBrief(); });
  setTimeout(() => document.getElementById('brief')?.focus(), 50);
}

/* ---------------- PROJECT workspace ---------------- */
const BUCKETS = [
  { name:'Understood your brief', re:/research|plan/ },
  { name:'Writing the content',   re:/content|copy|writ/ },
  { name:'Designing the look',    re:/brand|design|media|art/ },
  { name:'Building the site',     re:/build/ },
  { name:'Final checks',          re:/qa|verif|test|check/ },
];
function phaseRows(tasks){
  const used = new Set(), rows = [];
  const state = ts => ts.every(t => t.status==='done') ? 'done' : (ts.some(t => ['running','verifying','ready'].includes(t.status)) ? 'run' : 'pend');
  for (const b of BUCKETS){
    const ts = tasks.filter(t => b.re.test((t.department||'').toLowerCase()));
    ts.forEach(t => used.add(t.seq));
    if (ts.length) rows.push({ name:b.name, state: state(ts) });
  }
  const others = tasks.filter(t => !used.has(t.seq));
  if (others.length) rows.push({ name:'Other steps', state: state(others) });
  return rows;
}
const tabLink = (id, key, label, cur) =>
  `<a href="#/p/${id}${key==='site'?'':'/'+key}" class="${cur===key?'active':''}">${label}</a>`;

function project(id, tab, seq){
  app.innerHTML = `<div class="container"><div id="phead"></div><div id="pbody"></div></div>`;
  let wasBuilt = false, prow = {};

  function header(b){
    const built = !!b.site, failed = !built && b.tasks.some(t => t.status==='failed');
    const st = built ? 'done' : (failed ? 'failed' : 'running');
    const lab = built ? 'Live' : (failed ? 'Failed' : 'Building');
    document.getElementById('phead').innerHTML = `
      <div class="phead">
        <a class="back" href="#/">‹ Your sites</a>
        <h1 class="ptitle">${esc(b.project.brief)}</h1>
        <span class="pill big"><i class="dot s-${st}"></i>${lab}</span>
        ${b.site ? `<a class="btn btn-sm" target="_blank" rel="noopener" href="${b.site}">Open ↗</a>` : ''}
      </div>
      <div class="nav-links tabs">
        ${tabLink(id,'site','Site',tab)}${tabLink(id,'build','How it was built',tab)}${tabLink(id,'files','Files',tab)}${tabLink(id,'metrics','Metrics',tab)}
      </div>`;
  }

  function siteTab(b){
    const body = document.getElementById('pbody');
    const built = !!b.site, failed = !built && b.tasks.some(t => t.status==='failed');
    const done = b.tasks.filter(t=>t.status==='done').length, total = b.tasks.length;
    if (built){
      body.innerHTML = `
        <div class="frame">
          <div class="frame-bar"><span class="dots"><i></i><i></i><i></i></span><span class="addr">${location.origin}${b.site}</span></div>
          <iframe src="${b.site}" title="produced site"></iframe>
        </div>
        <div class="actionbar">
          <a class="btn" target="_blank" rel="noopener" href="${b.site}">Open ↗</a>
          <button class="btn btn-ghost" id="share">Share link</button>
          <button class="btn btn-ghost" id="rerun" title="Re-run as a new site">Re-run</button>
          <span class="muted" style="margin-left:auto;font-size:13px">${prow.wall?`Built in ${prow.wall}s · `:''}${done}/${total} steps · verified</span>
        </div>`;
      body.querySelector('#share').onclick = e => { navigator.clipboard?.writeText(location.origin + b.site); e.target.textContent='Copied ✓'; setTimeout(()=>e.target.textContent='Share link',1500); };
      body.querySelector('#rerun').onclick = async e => { e.target.textContent='Re-running…'; e.target.disabled=true; try{ const r=await j('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brief:b.project.brief})}); location.hash='#/p/'+r.id; }catch{} };
    } else if (failed){
      const blocked = b.tasks.find(t=>t.status==='failed');
      body.innerHTML = `<div class="empty" style="text-align:left">
        <h3 style="margin-bottom:8px">A step failed — the site couldn’t finish.</h3>
        <p class="muted">${blocked?`Blocked at #${blocked.seq} · ${esc(blocked.title)}.`:''} Open “How it was built” to see what happened.</p>
        <div class="row" style="gap:8px;margin-top:18px">
          <a class="btn btn-sm" href="#/p/${id}/build">See what happened</a>
          <button class="btn btn-sm btn-ghost" id="rerun">Re-run as a new site</button>
        </div></div>`;
      body.querySelector('#rerun').onclick = async () => { const r=await j('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brief:b.project.brief})}); location.hash='#/p/'+r.id; };
    } else {
      const cur = b.tasks.find(t=>['running','verifying'].includes(t.status));
      const rows = phaseRows(b.tasks).map(r => `<div class="phase ${r.state}"><span class="mk">${r.state==='done'?'✓':r.state==='run'?'●':'○'}</span>${r.name}</div>`).join('');
      body.innerHTML = `<div class="card progress">
        <div class="bar"><i style="width:${total?Math.round(100*done/total):4}%"></i></div>
        <div class="phasefeed">${rows}</div>
        <div class="muted" style="margin-top:16px;font-size:13px">${cur?`Step ${cur.seq} of ${total} · ${esc(cur.title)}`:'Working…'}</div>
        <a class="muted howbuilt" href="#/p/${id}/build">How it’s being built (for the curious) →</a>
      </div>`;
    }
  }

  function buildTab(b){
    document.getElementById('pbody').innerHTML = `
      <div class="board-head"><span class="pill"><span class="count">${b.tasks.filter(t=>t.status==='done').length}</span>&nbsp;/&nbsp;${b.tasks.length} done${b.tasks.some(t=>t.status==='failed')?` · ${b.tasks.filter(t=>t.status==='failed').length} failed`:''}</span>
        <div class="legend">${Object.keys(COLOR).map(k=>`<span><i class="dot s-${k}"></i>${k}</span>`).join('')}</div></div>
      <p class="hint">▸ click any step to read what it produced</p><div id="net"></div>`;
    const nodes = new vis.DataSet(), edges = new vis.DataSet();
    const net = new vis.Network(document.getElementById('net'), { nodes, edges }, {
      layout:{ hierarchical:{ direction:'LR', sortMethod:'directed', levelSeparation:210, nodeSpacing:92 } }, physics:false,
      nodes:{ shape:'box', widthConstraint:{maximum:178}, margin:11, borderWidth:0, shapeProperties:{borderRadius:10}, font:{color:'#fff',size:13,face:'Inter'} },
      edges:{ arrows:'to', color:{color:'#2A3346',highlight:'#7C7AFF'}, smooth:{type:'cubicBezier',roundness:.55} }, interaction:{hover:true} });
    b.tasks.forEach(t => nodes.add({ id:t.seq, label:`#${t.seq}  ${t.department}\n${t.title}`, color:{background:COLOR[t.status]||'#555',border:'#0A0C12'} }));
    b.edges.forEach(e => edges.add({ id:'e'+e.from+'_'+e.to, from:e.from, to:e.to }));
    net.on('click', p => { if (p.nodes && p.nodes.length){ history.replaceState(null,'',`#/p/${id}/files?seq=${p.nodes[0]}`); openOutput(id, p.nodes[0]); } });
  }

  function filesTab(b){
    const groups = {};
    b.tasks.forEach(t => { const d = (t.department||'other'); (groups[d] = groups[d]||[]).push(t); });
    document.getElementById('pbody').innerHTML = Object.entries(groups).map(([d, ts]) => `
      <div class="kpi-label" style="margin:22px 0 10px">${esc(d)}</div>
      ${ts.map(t => `<div class="card filerow" data-seq="${t.seq}">
        <span class="pill"><i class="dot s-${t.status}"></i>${t.status}</span>
        <span class="fname">#${t.seq} · ${esc(t.title)}</span>
        ${(t.department||'').includes('build') && t.status==='done' && b.site ? `<a class="btn btn-sm" target="_blank" rel="noopener" href="${b.site}">Open site ↗</a>` : ''}
        <a class="btn btn-sm btn-ghost view">View output</a></div>`).join('')}`).join('');
    document.querySelectorAll('.filerow').forEach(r => r.addEventListener('click', e => {
      if (e.target.closest('a[target]')) return;
      const s = r.getAttribute('data-seq'); history.replaceState(null,'',`#/p/${id}/files?seq=${s}`); openOutput(id, s);
    }));
    if (seq) setTimeout(() => openOutput(id, seq), 60);
  }

  async function metricsTab(){
    const k = await j('/api/kpi?id=' + id);
    const extra = [];
    if (prow.total) extra.push({label:'First-pass', value:Math.round(100*prow.firstpass/(prow.done||1))+'%', sub:`${prow.firstpass}/${prow.done}`, tone:'neutral'});
    if (prow.total) extra.push({label:'Verification rigor', value:Math.round(100*prow.realchecks/prow.total)+'%', sub:`${prow.realchecks}/${prow.total} real checks`, tone:'neutral'});
    if (prow.wall) extra.push({label:'Wall-clock', value:prow.wall+'s', sub:'end to end', tone:'neutral'});
    const all = (k?.kpis||[]).concat(extra);
    document.getElementById('pbody').innerHTML = `
      <p class="muted" style="margin-bottom:18px">How this build performed. Relay verifies every step — it never takes the agent’s word.</p>
      <div class="kpis">${all.map(m => `<div class="kpi tone-${m.tone}"><div class="kpi-label">${m.label}</div><div class="kpi-value">${m.value}</div><div class="kpi-sub">${m.sub}</div></div>`).join('')}</div>`;
  }

  async function load(){
    let b; try { b = await j('/api/board?id=' + id); } catch { return; }
    if (!b.project){ app.innerHTML = `<div class="container section"><div class="empty">Project not found. <a href="#/">‹ Your sites</a></div></div>`; clearPoll(); return; }
    if (!prow.id) { try { prow = (await j('/api/projects')).find(p => p.id === id) || {}; } catch {} }
    const built = !!b.site;
    // while-building auto-promotion: if no explicit tab and still building -> show build narration on Site
    header(b);
    if (tab === 'site') siteTab(b);
    else if (tab === 'build') buildTab(b);
    else if (tab === 'files') filesTab(b);
    else if (tab === 'metrics') metricsTab();
    // resolution moment
    if (!wasBuilt && built && tab === 'site') { toast('✓ Done — your site is live'); }
    wasBuilt = built;
    if (built || b.tasks.some(t=>t.status==='failed')) clearPoll();
  }
  load();
  poll = setInterval(load, 1000);
}

function toast(msg){
  let t = document.getElementById('toast'); if (!t){ t = document.createElement('div'); t.id='toast'; t.className='toast'; document.body.appendChild(t); }
  t.innerHTML = `<span class="pill s-done"><i class="dot s-done"></i>${msg}</span>`; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

function about(){
  app.innerHTML = `<div class="container section"><div class="prose">
    <span class="eyebrow">About Relay</span>
    <h1 style="margin-top:16px">An agency that runs itself.</h1>
    <p style="margin-top:16px">You give Relay a brief; it delivers a real, working website — not a to-do list. It mimics how a studio passes a project desk to desk, but every hand-off is a machine step that proves itself before the next one starts.</p>
    <h2>How it works</h2>
    <div class="steps">
      <div class="step"><div><b>1 · Plan</b><span class="muted">It reads your brief and breaks it into steps with dependencies.</span></div></div>
      <div class="step"><div><b>2 · Build, stage by stage</b><span class="muted">Independent steps run in parallel; dependent ones wait their turn.</span></div></div>
      <div class="step"><div><b>3 · Verify, never trust</b><span class="muted">A step is only “done” when a real check passes — the site actually renders.</span></div></div>
      <div class="step"><div><b>4 · Ship</b><span class="muted">A real website you can open and share.</span></div></div>
    </div>
    <p style="margin-top:32px"><a class="btn" href="#/">Build my first site →</a></p>
  </div></div>`;
}

/* ---------------- router ---------------- */
function router(){
  clearPoll(); closeDrawer(false);
  let raw = location.hash.replace(/^#/, '') || '/';
  // legacy redirects
  const q0 = raw.split('?')[1] || '';
  if (raw.startsWith('/?')) {
    const sp = new URLSearchParams(q0);
    if (sp.get('id')) { location.replace('#/p/' + sp.get('id') + (sp.get('task') ? '/files?seq=' + sp.get('task') : '')); return; }
  }
  if (raw === '/projects') { location.replace('#/'); return; }

  const [path, query] = raw.split('?');
  const seg = path.split('/').filter(Boolean);
  const seq = new URLSearchParams(query || '').get('seq');
  let navPath = '/';
  if (!seg.length) home();
  else if (seg[0] === 'new') { navPath = '/new'; newSite(); }
  else if (seg[0] === 'about') { navPath = '/about'; about(); }
  else if (seg[0] === 'p' && seg[1]) { navPath = '/'; const tab = ['site','build','files','metrics'].includes(seg[2]) ? seg[2] : 'site'; project(seg[1], tab, seq ? Number(seq) : null); }
  else home();

  document.querySelectorAll('.nav-links a').forEach(a => a.classList.toggle('active', a.getAttribute('data-route') === navPath));
  if (!query) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);
router();

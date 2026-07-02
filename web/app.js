// Relay SPA — deliverable-first IA. Home (your sites) -> Project (live site is the hero) -> tabs.
const COLOR = { blocked:'#5C6678', ready:'#E0B341', running:'#5A8DEE', verifying:'#A06CD5', done:'#36B37E', failed:'#F0506E' };
const app = document.getElementById('app');
// mobile nav (hamburger -> dropdown)
const navToggle = document.getElementById('navtoggle'), navLinks = document.getElementById('navlinks');
navToggle?.addEventListener('click', () => { const o = navLinks.classList.toggle('open'); navToggle.setAttribute('aria-expanded', String(o)); });
navLinks?.addEventListener('click', e => { if (e.target.closest('a')) navLinks.classList.remove('open'); });
let poll = null;
const j = (u, o) => fetch(u, o).then(r => r.json());
/* ---- M4 · auth: magic-link sign-in; the nav shows who you are ---- */
let me = null;
async function loadMe(){ try { me = (await j('/api/me')).email; } catch { me = null; } renderAuthNav(); }
function renderAuthNav(){
  let a = document.getElementById('authlink');
  if (!a && navLinks){ a = document.createElement('a'); a.id = 'authlink'; a.href = '#/signin'; navLinks.insertBefore(a, navLinks.querySelector('.btn')); }
  if (!a) return;
  if (me){ a.textContent = 'Sign out (' + me.split('@')[0] + ')'; a.onclick = async e => { e.preventDefault(); await fetch('/api/auth/logout', { method:'POST' }); me = null; renderAuthNav(); location.hash = '#/'; location.reload(); }; }
  else { a.textContent = 'Sign in'; a.onclick = null; }
}
function signin(){
  app.innerHTML = `<div class="container"><section class="hero" style="text-align:center;max-width:560px;margin:0 auto">
    <h1>Sign in</h1>
    <p class="lead" style="margin:14px auto">Enter your email — we send a one-tap sign-in link. Your projects become yours alone.</p>
    <div class="brief-bar" style="margin:0 auto">
      <input id="email" class="input" type="email" placeholder="you@example.com" autocomplete="email" />
      <button id="golink" class="btn">Email me a link →</button>
    </div>
    <p id="authmsg" class="muted" style="margin-top:16px"></p></section></div>`;
  const go = async () => {
    const email = document.getElementById('email').value.trim(); if (!email) return;
    const btn = document.getElementById('golink'); btn.disabled = true; btn.textContent = 'Sending…';
    const m = document.getElementById('authmsg');
    try { const r = await j('/api/auth/request', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email }) });
          m.textContent = r.ok ? '✓ Check your inbox — the link signs you in with one tap (expires in 15 minutes).' : (r.error || 'Something went wrong.');
    } catch { m.textContent = 'Something went wrong — try again.'; }
    btn.disabled = false; btn.textContent = 'Email me a link →';
  };
  document.getElementById('golink').onclick = go;
  document.getElementById('email').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  setTimeout(() => document.getElementById('email')?.focus(), 50);
}
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
    <p class="lead">Describe it in a sentence. Relay builds a real, branded website — served live from its CMS, verified by a real browser.</p>
    <div class="brief-bar">
      <input id="brief" class="input" placeholder='Describe the site you want — e.g. "a one-page site explaining our pricing"' />
      <button id="go" class="btn">Build my site →</button>
    </div></section>`;
}
async function submitBrief(){
  const input = document.getElementById('brief'); const brief = input.value.trim(); if (!brief) return;
  const btn = document.getElementById('go'); btn.textContent = 'Building your site…'; btn.disabled = true;
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
      ${p.review_passed === false ? `<div class="pill" style="background:rgba(240,80,110,.14);color:#F0506E;margin-top:10px"><i class="dot s-failed"></i>review found ${p.review_issues || ''} issue${p.review_issues === 1 ? '' : 's'}</div>` : (p.review_passed === true ? `<div class="muted" style="font-size:12px;margin-top:10px">✓ reviewed — buttons, links &amp; forms work</div>` : '')}
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
    document.getElementById('emptywrap').innerHTML = list.length ? '' : `<div class="empty">${me ? 'No sites in your account yet — describe one above and it\'s yours.' : 'No sites yet. Describe one above and Relay builds it.'}</div>`;
    let building = 0;
    for (const p of list){
      const st = projStatus(p), isB = st === 'running'; if (isB) building++;
      const sig = `${st}|${p.done}|${p.total}|${p.site ? 1 : 0}|${p.review_passed}|${p.review_issues}`;
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
  let wasBuilt = false, prow = {}, editInit = false, qaInit = false, dataInit = false;

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
        ${tabLink(id,'site','Site',tab)}${tabLink(id,'build','How it was built',tab)}${tabLink(id,'files','Files',tab)}${tabLink(id,'metrics','Metrics',tab)}${b.site ? tabLink(id,'qa','QA',tab) : ''}${b.site ? tabLink(id,'data','Data',tab) : ''}
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
          <button class="btn btn-ghost" id="rebuild" title="Update the brief — rebuilds this site in place; its database and identity survive">Rebuild</button>
          <button class="btn btn-ghost" id="rerun" title="Re-run as a new site">Re-run</button>
          <span class="muted" style="margin-left:auto;font-size:13px">${prow.wall?`Built in ${prow.wall}s · `:''}${done}/${total} steps · verified</span>
        </div>`;
      body.querySelector('#share').onclick = e => { navigator.clipboard?.writeText(location.origin + b.site); e.target.textContent='Copied ✓'; setTimeout(()=>e.target.textContent='Share link',1500); };
      body.querySelector('#rerun').onclick = async e => { e.target.textContent='Re-running…'; e.target.disabled=true; try{ const r=await j('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brief:b.project.brief})}); location.hash='#/p/'+r.id; }catch{} };
      body.querySelector('#rebuild').onclick = async e => {
        const nb = prompt('Update the brief — the site rebuilds in place. Your data and branding survive.', b.project.brief);
        if (!nb || !nb.trim()) return;
        e.target.textContent='Rebuilding…'; e.target.disabled=true;
        try { await j('/api/rebuild',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id, brief:nb.trim()})}); location.reload(); } catch { e.target.textContent='Rebuild'; e.target.disabled=false; }
      };
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
    document.getElementById('pbody').innerHTML = `
      <p class="muted" style="margin-bottom:18px">What actually matters about this build — every number checked against the database, never the AI’s word.</p>
      <div class="kpis">${(k?.kpis||[]).map(m => `<div class="kpi tone-${m.tone}"><div class="kpi-label">${m.label}</div><div class="kpi-value">${m.value}</div><div class="kpi-sub">${m.sub}</div></div>`).join('')}</div>`;
  }


  // ---- QA tab: Relay screenshots each page (phone + desktop) and a vision model reviews them ----
  async function qaTab(){
    const tone = s => s >= 8 ? 'good' : s >= 5 ? 'warn' : 'bad';
    const body = document.getElementById('pbody');
    body.innerHTML = `
      <h2 class="rv-h" style="margin-top:0">Interaction review <span class="muted" style="font-size:13px;font-weight:400">— a real browser clicked every button, typed into &amp; submitted the form, and checked the data came through</span></h2>
      <div id="dogfood"><div class="muted" style="padding:12px 2px">Loading…</div></div>
      <h2 class="rv-h">Visual review <span class="muted" style="font-size:13px;font-weight:400">— a vision model read every page on phone + desktop</span></h2>
      <div class="qa-head"><p class="muted" style="margin:4px 0 0;flex:1;min-width:200px">Lower score = more issues.</p><button class="btn btn-sm" id="qarun">Re-run visual review</button></div>
      <div id="qabody"><div class="muted" style="padding:18px 2px">Loading…</div></div>`;
    async function renderDog(){
      let d; try { d = await j('/api/dogfood?id=' + id); } catch { return; }
      const el = document.getElementById('dogfood'); if (!el) return;
      if (!d || d.summary == null) { el.innerHTML = `<div class="empty">No interaction review yet — it runs automatically when the build finishes.</div>`; return; }
      const issues = d.issues || [], highs = issues.filter(i => i.severity === 'high').length;
      el.innerHTML = `<div class="qa-overall tone-${d.passed ? 'good' : 'bad'}"><b>${d.passed ? '✓ Passed' : '✗ ' + highs + ' blocking'}</b><span class="muted" style="margin-left:10px">${esc(d.summary)}</span></div>`
        + (issues.length ? `<div class="rv-list" style="margin-top:12px">${issues.map(i => `<div class="card rv-card"><div class="row" style="justify-content:space-between;gap:10px"><span class="pill">${esc(i.page)} · ${esc(i.viewport)}</span><span class="sev sev-${i.severity === 'high' ? 'high' : 'medium'}">${esc(i.kind)}</span></div><p class="muted" style="margin-top:8px">${esc(i.detail)}</p></div>`).join('')}</div>` : '');
    }
    renderDog();
    async function render(){
      let d; try { d = await j('/api/qa?id=' + id); } catch { return 0; }
      const el = document.getElementById('qabody'); if (!el) return 0;
      if (!d.reviews || !d.reviews.length) { el.innerHTML = `<div class="empty">No review yet — tap “Re-run review”.</div>`; return 0; }
      el.innerHTML = `<div class="qa-overall tone-${tone(d.overall || 0)}">Overall score <b>${d.overall ?? '—'}/10</b><span class="muted"> · worst page</span></div>
        <div class="qa-grid">${d.reviews.map(r => `
          <div class="qa-card">
            <a class="qa-shotwrap" href="/sites/${id}/${r.shot}" target="_blank" rel="noopener"><img src="/sites/${id}/${r.shot}?t=${prow.id ? '' : ''}${Date.now()}" loading="lazy" alt=""></a>
            <div class="qa-meta"><span class="pill">${esc(r.slug)} · ${r.viewport}</span><span class="qa-score tone-${tone(r.score)}">${r.score}/10</span></div>
            ${(r.issues && r.issues.length) ? `<ul class="qa-issues">${r.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p class="muted" style="font-size:13px;margin-top:8px">No issues flagged ✓</p>`}
          </div>`).join('')}</div>`;
      return d.reviews.length;
    }
    document.getElementById('qarun').onclick = async () => {
      const btn = document.getElementById('qarun'); btn.textContent = 'Reviewing…'; btn.disabled = true;
      try { await fetch('/api/qa/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }); } catch {}
      let tries = 0;
      const iv = setInterval(async () => { tries++; await render(); if (tries > 36) { clearInterval(iv); btn.textContent = 'Re-run review'; btn.disabled = false; } }, 5000);
    };
    await render();
  }

  // ---- Data tab: form submissions stored in Postgres (the full-stack layer) ----
  async function dataTab(){
    const body = document.getElementById('pbody');
    body.innerHTML = `
      <h2 class="rv-h" style="margin-top:0">Data model <span class="muted" style="font-size:13px;font-weight:400">— the database the agency designed &amp; provisioned for this app</span></h2>
      <div id="schemabody"><div class="muted" style="padding:12px 2px">Loading…</div></div>
      <h2 class="rv-h">Submissions <span class="muted" style="font-size:13px;font-weight:400">— captured live by this site’s forms, stored in Postgres</span></h2>
      <div id="databody"><div class="muted" style="padding:18px 2px">Loading…</div></div>`;
    // the live data model (introspected from the project's own isolated schema)
    let s; try { s = await j('/api/schema?id=' + id); } catch {}
    const sb = document.getElementById('schemabody');
    if (sb) sb.innerHTML = (!s || !s.tables || !s.tables.length)
      ? `<div class="empty">No database — this is a presentation site (no app data model).</div>`
      : `<div class="rv-list">${s.tables.map(t => `<div class="card rv-card">
          <div class="row" style="justify-content:space-between"><code>${esc(t.table)}</code><span class="pill">${t.rows} row${t.rows === 1 ? '' : 's'}</span></div>
          <div style="margin-top:10px;display:grid;gap:4px;font-size:13px">${(t.columns || []).map(c => `<div><b style="color:var(--text);font-weight:600">${esc(c.name)}</b> <span class="muted">${esc(c.type)}${c.nullable ? '' : ' · required'}</span></div>`).join('')}</div>
          ${(t.relations && t.relations.length) ? `<p class="muted" style="margin-top:8px;font-size:12px">→ ${t.relations.map(r => esc(r.column) + ' → ' + esc(r.references)).join(', ')}</p>` : ''}
        </div>`).join('')}</div>`;
    let d; try { d = await j('/api/submissions?id=' + id); } catch { document.getElementById('databody').innerHTML = '<div class="empty">Couldn’t load submissions.</div>'; return; }
    const el = document.getElementById('databody');
    if (!d.submissions || !d.submissions.length) { el.innerHTML = `<div class="empty">No submissions yet. When someone fills in a form on this site, it lands here.</div>`; return; }
    el.innerHTML = `<div class="kpi-label" style="margin-bottom:12px">${d.submissions.length} submission${d.submissions.length > 1 ? 's' : ''}</div>` + d.submissions.map(s => `
      <div class="card" style="margin-bottom:12px">
        <div class="row" style="justify-content:space-between"><span class="pill">${esc(s.form)}</span><span class="muted" style="font-size:12px">${new Date(s.created_at).toLocaleString()}</span></div>
        <div style="margin-top:10px;display:grid;gap:6px">${Object.entries(s.data || {}).map(([k, v]) => `<div style="font-size:14px"><b style="color:var(--muted);font-weight:600">${esc(k)}</b> · ${esc(v)}</div>`).join('')}</div>
      </div>`).join('');
  }

  // CMS-native (WordPress) project — its own self-contained view (branded site + admin).
  function wpView(b){
    const pm = b.project.params || {};
    const st = pm.cms_status || 'building';
    const live = st === 'done' && pm.wp_url;
    document.getElementById('phead').innerHTML = `
      <div class="phead">
        <a class="back" href="#/">‹ Your sites</a>
        <h1 class="ptitle">${esc(b.project.brief)}</h1>
        <span class="pill big"><i class="dot s-${live?'done':st==='failed'?'failed':'running'}"></i>${live?'Live':st==='failed'?'Failed':'Building'}</span>
        ${live?`<a class="btn btn-sm" target="_blank" rel="noopener" href="${pm.wp_url}">Open ↗</a>`:''}
      </div>`;
    const body = document.getElementById('pbody');
    if (live){
      body.innerHTML = `
        <div class="frame"><div class="frame-bar"><span class="dots"><i></i><i></i><i></i></span><span class="addr">${pm.wp_url}</span></div><iframe src="${pm.wp_url}" title="site"></iframe></div>
        <div class="actionbar">
          <a class="btn" target="_blank" rel="noopener" href="${pm.wp_url}">Open site ↗</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${pm.wp_admin}">Edit in CMS admin ↗</a>
          <span class="muted" style="margin-left:auto;font-size:13px">${esc(pm.site_name||'')} — a real CMS · edit content in the admin; branding &amp; navigation stay intact</span>
        </div>`;
      if (!wasBuilt) toast('✓ Done — your CMS site is live');
      wasBuilt = true; clearPoll();
    } else if (st === 'failed'){
      body.innerHTML = `<div class="empty" style="text-align:left"><h3 style="margin-bottom:8px">Couldn’t build this one.</h3><p class="muted">${esc(pm.error||'')}</p><a class="btn btn-sm" href="#/" style="margin-top:14px">‹ Back to your sites</a></div>`;
      clearPoll();
    } else {
      body.innerHTML = `<div class="card progress"><div class="bar"><i style="width:45%"></i></div>
        <div class="phasefeed"><div class="phase done"><span class="mk">✓</span>Brief understood</div><div class="phase run"><span class="mk">●</span>Branding · pages · navigation</div><div class="phase"><span class="mk">○</span>Publishing your CMS site</div></div>
        <div class="muted" style="margin-top:16px;font-size:13px">Building a real, branded CMS site you can log into and edit — about a minute…</div></div>`;
    }
  }

  async function load(){
    let b; try { b = await j('/api/board?id=' + id); } catch { return; }
    if (!b.project){ app.innerHTML = `<div class="container section"><div class="empty">Project not found. <a href="#/">‹ Your sites</a></div></div>`; clearPoll(); return; }
    if (b.project.params && b.project.params.engine === 'wordpress') { wpView(b); return; }
    if (!prow.id) { try { prow = (await j('/api/projects')).find(p => p.id === id) || {}; } catch {} }
    const built = !!b.site;
    // while-building auto-promotion: if no explicit tab and still building -> show build narration on Site
    header(b);
    if (tab === 'site') siteTab(b);
    else if (tab === 'build') buildTab(b);
    else if (tab === 'files') filesTab(b);
    else if (tab === 'metrics') metricsTab();
    else if (tab === 'qa') { if (!qaInit) { qaInit = true; qaTab(); } }
    else if (tab === 'data') { if (!dataInit) { dataInit = true; dataTab(); } }
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

function roadmap(){
  const P = [
    { n:'00', t:'Engine', s:'done', d:'A dependency-graph board in Postgres, a stateless restart-safe runner, an unblock trigger, and zero-trust verification — the foundation everything stands on.' },
    { n:'01', t:'Live product surface', s:'done', d:'A working web app: type a brief → a project workspace (Site · Build · Files · Metrics), site served at /sites/:id, board live at board.naples.agency. Real and running — not the finished vision.' },
    { n:'02', t:'Honest quality gate', s:'done', d:'A verifier that refuses broken/external assets and dead links; KPIs that read “blocked” when a run is stuck instead of green; retry-with-feedback. The gate is real — not a guarantee of taste.' },
    { n:'03', t:'Generic + multi-page', s:'done', d:'An LLM planner that writes a bespoke task graph per brief, producing real multi-page sites with a shared navigation.' },
    { n:'04', t:'Real media', s:'done', d:'The build names the photos each section needs; Relay pulls real licensed Pexels images, downloads them into the site and serves them locally — gate-safe, never a broken link.' },
    { n:'05', t:'Production email (infra)', s:'done', d:'noreply@naples.agency — authenticated SMTP, SPF/DKIM/DMARC aligned (inbox-grade), verified by live delivery to a real inbox. The unused in-app mailer module was removed in the 2026-07-02 cleanup; the DNS/SMTP config remains and email returns with user accounts.' },
    { n:'06', t:'Built to last', s:'done', d:'Relay and its own dedicated Cloudflare tunnel run under systemd (Restart=always, enabled); Postgres runs in Docker (restart=unless-stopped). DB backups every 6h (pg_dump, 14 kept) + an uptime check every 5 min with Telegram alerts — all real cron jobs. Survives crash/reboot.' },
    { n:'07', t:'Visual self-QA', s:'done', d:'Relay screenshots every page (phone + desktop) and a vision model reads them for real problems, scoring each and surfacing it in a QA tab. Runs automatically on every build.' },
    { n:'08', t:'Deterministic engine', s:'done', d:'The build no longer guesses HTML — vetted components + a renderer compose every page from a structured spec, so navigation, CSS, fonts, spacing and contrast cannot be wrong. Replaces the old LLM-Tailwind “excellence” approach.' },
    { n:'09', t:'Rooted identity', s:'done', d:'The brief is classified into one of five design languages (editorial, modern, warm, bold, minimal); the renderer expands it into typography, rhythm and shape. The chosen language is applied consistently to every page of a site — verified identical across pages on the live build, not re-rolled per page.' },
    { n:'10', t:'Full-stack + database', s:'done', d:'An app/store brief gets an isolated Postgres schema compiled from a typed data model (keys, relations, indexes), seeded and read back on the page. Injected automatically whenever the brief needs data — exercised on every applicable project, each with a live provisioned schema.' },
    { n:'11', t:'Interaction QA', s:'done', d:'A real browser then uses every finished site — clicks every button, types into and submits the form, checks the data came through, measures the layout on phone + desktop. Verification by interaction, not just a screenshot. The verdict shows on each project.' },
    { n:'12', t:'CMS-native generation (the core)', s:'done', d:'Every generated site is built on ONE real headless CMS — Directus — with content living in and served live from the CMS, proven by a zero-trust gate (a sentinel written through the CMS must surface in the re-served HTML). The earlier 5-CMS ambition and the parallel WordPress generator are retired: one pipeline, one CMS, every brief. See GOAL.md.' },
    { n:'13', t:'Robust browser layer', s:'done', d:'Killed spawn-per-call chromium + hand-rolled CDP-over-ws (the source of recurring "chromium didn\'t come up" breakage) → ONE persistent Playwright browser (src/browser.ts, Playwright\'s own Chromium, context-per-call, concurrency-gated) behind every browser path. Removed the redundant screenshot from the verify hot path (site_renders is now static; pages are correct by construction) — bigger throughput/cost/fragility win. Runner split into an opt-in worker process (src/worker.ts, RELAY_BUILD=0 flag) for horizontal build scale.' },
    { n:'14', t:'Web-grounded intelligence', s:'done', d:'Research and strategy departments call the model via OpenRouter with the server-side web-search plugin — grounding briefs in live facts within the same call. Proven: dozens of successful web-grounded runs persisted in the event log (llm_call · web:true · ok:true).' },
    { n:'15', t:'M1 · Landing pages that sell', s:'done', d:'A landing brief produces ONE focused sales page — pain → promise → proof → offer → CTA. Landing intent is detected in code (never LLM whim); new logos + offer components; the model gate rejects any landing that lacks ≥2 conversion sections or doesn\'t end in a CTA. Proven live: a real brief shipped hero → logos → stats → features → split → testimonials → offer → faq → cta, one page, one repeated CTA, interaction review passed, served from the CMS.' },
    { n:'16', t:'M2 · Forms that match the database', s:'done', d:'App forms are compiled from the real schema — right fields, typed validation (required from NOT NULL, decimal steps for money), and relation dropdowns listing real records (a booking form offers real sessions, an order form real pickup slots). The interaction reviewer verifies field-for-field against the schema and submits a real row — it must land in the typed table AND render in the live list. Proven live end-to-end on a bakery pre-order app.' },
    { n:'17', t:'M3 · Rebuild without losing data', s:'done', d:'A Rebuild button updates the brief and rebuilds the SAME site in place: branding and theme survive, and the app\'s database is MIGRATED, never dropped — new tables created and seeded, new columns added with safe defaults, type changes refused, and a row-count guard rolls the whole migration back if any table would lose data. Proven live: a bakery app rebuilt twice with a changed brief — every order survived, and the new required phone field appeared on the form. Gated by npm run migrate:check (17 scratch-schema assertions).' },
    { n:'18', t:'M4 · Sign in and own your sites', s:'done', d:'Passwordless sign-in: enter your email, tap the link (single-use, 15-minute expiry) and the board becomes YOURS — every brief you submit is owned by your account, with ownership enforced in the database on every query, never just hidden in the interface. An automated two-user gate (18 checks against the live server) proves one account can never list, open or rebuild another\'s project; anonymous visitors see only the public demo board. Produced sites stay public — they\'re websites.' },
    { n:'19', t:'M5 · The agency talks back', s:'done', d:'Every form submission on a produced site is emailed to its owner within seconds (QA test-probes are filtered out — only real leads reach the inbox). A build that exhausts its self-repair budget interrupts the operator on Telegram with a direct link — once per project, never spam, never silently waiting on a dashboard. Gated by alert:check: real delivery through the live bot, dedupe and lead-vs-probe proofs.' },
    { n:'20', t:'M6 · The agency sells itself', s:'next', d:'Pricing + Stripe checkout: a stranger pays, gets an account, submits a brief, watches it build. Money in, product out, zero humans. See PLAN.md — the plan of record.' },
    { n:'21', t:'Mission-rooted differentiation', s:'next', d:'The agency way: everything follows the client’s mission — like a Shopify build where theme, apps and categories all serve the store’s purpose. Today five design languages + per-brief branding/structure exist; next: deeper visual variety (nav styles, layout rhythms, section variants), mission-driven capability choices, and richer brand systems — so two cafés never feel like the same site.' },
  ];
  const tag = s => s==='done' ? '<span class="rm-tag done">✓ Shipped</span>' : s==='progress' ? '<span class="rm-tag prog">● In progress</span>' : '<span class="rm-tag next">○ Planned</span>';
  const done = P.filter(p=>p.s==='done').length;
  app.innerHTML = `<div class="container section">
    <span class="eyebrow">● the plan</span>
    <h1 style="margin-top:14px">Roadmap</h1>
    <p class="lead" style="margin-top:14px">Where Relay has been and where it's going. Status is marked honestly against real evidence — a prior version over-marked items as shipped; that's corrected here. <b style="color:var(--text)">${done} shipped · ${P.filter(p=>p.s==='progress').length} in progress · ${P.filter(p=>p.s==='next').length} planned.</b></p>
    <div class="rm-legend"><span><i class="rm-dot done"></i>Shipped</span><span><i class="rm-dot prog"></i>In progress</span><span><i class="rm-dot next"></i>Planned</span></div>
    <ol class="timeline">
      ${P.map(p=>`<li class="tl-item ${p.s}"><div class="tl-node">${p.n}</div>
        <div class="card tl-card">
          <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap"><h3 class="tl-title">${p.t}</h3>${tag(p.s)}</div>
          <p class="muted" style="margin-top:8px">${esc(p.d)}</p>
        </div></li>`).join('')}
    </ol>
    <p style="margin-top:36px"><a class="btn" href="#/">Build a site →</a></p>
  </div>`;
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
      <div class="step"><div><b>3 · Verify, never trust</b><span class="muted">A step is only “done” when a deterministic check passes — structural HTML, real assets, and working links.</span></div></div>
      <div class="step"><div><b>4 · Ship — and keep working</b><span class="muted">A real website or full-stack app, served live from its CMS, verified by a real browser clicking every link and submitting every form. After launch: every lead is emailed to the owner, and a Rebuild evolves the site without losing a row of data.</span></div></div>
    </div>
    <p style="margin-top:32px"><a class="btn" href="#/">Build my first site →</a></p>
  </div></div>`;
}

/* ---------------- system review & verdicts ---------------- */
function review(){
  const SEV = { critical:'Critical', high:'High', medium:'Medium', low:'Low', cross:'Cross-tenant' };
  const F = [
    { g:'done', sev:'critical', t:'Unsupervised processes', v:'cloudflared and the Relay server ran as hand-started processes — a crash or reboot took every naples.agency hostname offline until someone restarted them by hand.', fix:'Both now run under systemd with Restart=always (enabled). Crash-tested: SIGKILL → respawn in 2–3s → board back to 200.' },
    { g:'done', sev:'high', t:'Secret lived only in memory', v:'MINIMAX_API_KEY and DATABASE_URL existed only inside the running process — there was no .env on disk, so any restart would boot Relay with no key.', fix:'Captured to a gitignored .env (mode 600) and loaded via the systemd EnvironmentFile.' },
    { g:'done', sev:'high', t:'Build quality left to the model', v:'The original build asked the LLM to write raw HTML/CSS and a nav per page — so structure, spacing and the mobile menu varied site to site, and a clean deploy leaned on a gitignored 120 MB Tailwind binary that could silently no-op.', fix:'Replaced by a deterministic render engine: the model emits a JSON spec, vetted components build the page. Nav, fonts, spacing and WCAG contrast are correct by construction. The Tailwind binary and the entire excellence step were removed.' },
    { g:'done', sev:'high', t:'Silent failures (shipping a lie)', v:'The build could silently return un-styled HTML on an error, and an unset API key silently switched to stub sites — both invisible, the opposite of “never lie”.', fix:'The deterministic renderer removed the silent-styling failure mode entirely (pages are complete by construction); server.ts prints a loud boot banner when the key is unset (stub mode).' },
    { g:'done', sev:'medium', t:'Postgres didn’t survive reboot', v:'The ap-pg container had restart policy “no”, so a host reboot would lose the database.', fix:'Set to unless-stopped (verified).' },
    { g:'done', sev:'medium', t:'Nothing was documented', v:'No runbook, no architecture doc, no agent guide — the whole system lived only in chat history.', fix:'Shipped README, ARCHITECTURE, an OPERATIONS runbook, an AGENTS guide, a HARDENING backlog and deploy/ unit files — plus this page.' },
    { g:'done', sev:'critical', t:'No database backups', v:'21 projects / 190 tasks / 203 outputs lived in one Postgres volume with no dump — if that disk died, every user’s work was gone. The box’s “crown-jewels” backup did not cover this DB.', fix:'Daily restorable pg_dump (every 6h, 14 kept). Verified: a 280 KB dump with real rows, gzip-integrity checked. First dump done.' },
    { g:'done', sev:'high', t:'No monitoring / alerting', v:'If Relay or the tunnel went down and systemd somehow couldn’t recover it, nobody would know.', fix:'Uptime check every 5 min pings board.naples.agency and Telegram-alerts on any up→down transition. Armed + confirmed.' },
    { g:'done', sev:'high', t:'Unbounded spend on /api/run', v:'The build endpoint was wide open — every brief spends real MiniMax tokens, with no auth and no rate-limit; trivially abusable.', fix:'Per-IP rate-limit (5 briefs / 15 min) + a global cap of 6 concurrent projects (which also shields the pg pool). Tested: 6th call → 429.' },

    { g:'done', sev:'high', t:'Single ingress for all hostnames', v:'Every naples.agency hostname rode one shared cloudflared tunnel — a single failure domain for Relay and the other tenants. (Your point — correct.)', fix:'Relay now has its OWN dedicated, supervised tunnel (Restart=always, crash-tested: respawn in 2s). board/api/email re-pointed onto it; the shared tunnel no longer routes them. Fully decoupled.' },
    { g:'defer', sev:'high', t:'Destructive schema bootstrap', v:'db/schema.sql opens with unconditional DROP TABLE … CASCADE and the server never applies it on boot — a fresh DB 500s, and run.ts/demo.ts drop already-shipped work.', fix:'Move to CREATE … IF NOT EXISTS, apply at boot before listen(), gate the reset behind RESET=1, add a numbered migrations/ dir.' },
    { g:'defer', sev:'high', t:'Stub mode still serves', v:'The new boot banner warns, but with no key Relay still serves stub sites that pass every gate.', fix:'Hard-exit in production, or badge the project as “stub” in the UI + KPI so it can never be mistaken for real work.' },
    { g:'defer', sev:'medium', t:'Scheduler pool exhaustion', v:'A global claim() + runLoop per project; runner split enables unique runnerId per worker (code-ready, opt-in, not yet flipped on prod); three concurrent projects can exhaust the Postgres pool (max 8).', fix:'Partly mitigated now — /api/run caps concurrent projects at 6. Still to do: scope claim/reconcile by project, unique runnerId per loop, size the pool to the loop count.' },
    { g:'defer', sev:'medium', t:'Lease / reclaim race', v:'The 240 s task lease can be shorter than a slow render + media download + LLM call, so a live task gets re-claimed → two writers hit the same artifact.', fix:'Make terminal writes conditional on claimed_by, heartbeat-extend the lease, only resurrect provably-dead owners.' },
    { g:'defer', sev:'medium', t:'No retry backoff', v:'Each task burns three full attempts with no backoff — a MiniMax 429 or outage gets hammered instead of paused.', fix:'Exponential backoff, fail-fast on identical repeated failures, a per-project circuit breaker.' },
    { g:'defer', sev:'low', t:'Shipped sites are ephemeral', v:'sites/ is gitignored (output lost on host migration). Board thumbnail now written off the hot path (non-gating); final HTML still ephemeral.', fix:'Persist final verified HTML in Postgres / object storage; write QA’s screenshot to a distinct path.' },
    { g:'defer', sev:'low', t:'Frontend polish', v:'Polling cadence, vis-network loaded from a CDN without SRI, missing API-down states, a few accessibility gaps.', fix:'UX hardening — real but not stack-survival; scheduled separately.' },
    { g:'defer', sev:'cross', t:'Dormant neighbour upstreams', v:'dash / gab44 / fleet* ride the same tunnel but their apps are down (502) and unsupervised — they belong to other projects on this box.', fix:'Each needs its own unit; coordinate with the owners before enabling.' },
  ];
  const cardOf = f => `<div class="card rv-card ${f.g}">
      <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
        <h3 class="rv-title">${esc(f.t)}</h3><span class="sev sev-${f.sev}">${SEV[f.sev]}</span></div>
      <p class="muted" style="margin-top:8px">${esc(f.v)}</p>
      <p class="rv-fix ${f.g}"><span>${f.g==='done'?'✓ Fixed':'→ Plan'}</span>${esc(f.fix)}</p>
    </div>`;
  const doneF = F.filter(f=>f.g==='done'), deferF = F.filter(f=>f.g==='defer');
  app.innerHTML = `<div class="container section">
    <span class="eyebrow">● system review · 2026-06-27</span>
    <h1 style="margin-top:14px">Review &amp; verdicts</h1>
    <p class="lead" style="margin-top:14px">A full durability audit of Relay — infrastructure and code. The verdict lives here, in the product, not as a file rotting on the server. <b style="color:var(--text)">${doneF.length} applied &amp; verified · ${deferF.length} tracked.</b></p>

    <div class="rv-banner">
      <div class="rv-stat"><span class="rv-num">100%</span><span class="rv-cap">survives crash + reboot</span></div>
      <div class="rv-stat"><span class="rv-num">2–3s</span><span class="rv-cap">auto-respawn · kill-tested</span></div>
      <div class="rv-stat"><span class="rv-num">3</span><span class="rv-cap">services under systemd</span></div>
      <p class="muted" style="flex:1;min-width:220px;margin:0">Relay, the Cloudflare tunnel and Postgres are all supervised and were proven by SIGKILL → automatic recovery. No public hostname depends on a hand-started process anymore.</p>
    </div>

    <div class="rv-decision">
      <h3>Decision · supervise the tunnel, don’t rip out Cloudflare</h3>
      <p class="muted">The flakiness was never Cloudflare’s rules — it was cloudflared running unsupervised. Ripping it out is the riskier path here: both public 80/443 are owned by another tenant on this box, there’s no Cloudflare API token to change DNS, and grey-clouding would expose the origin IP. So we supervised the existing named tunnel (now Restart=always) and kept Tailscale Funnel as a redundant path. Full rationale in OPERATIONS.md §8.</p>
    </div>

    <h2 class="rv-h">Applied &amp; verified <span class="rv-count done">${doneF.length}</span></h2>
    <div class="rv-list">${doneF.map(cardOf).join('')}</div>

    <h2 class="rv-h" style="margin-top:40px">Tracked backlog <span class="rv-count defer">${deferF.length}</span></h2>
    <p class="muted" style="margin:6px 0 0">Real findings, ranked. Not yet applied — they need a schema change, load-testing, or another team’s sign-off. Recorded so none of it is lost.</p>
    <div class="rv-list">${deferF.map(cardOf).join('')}</div>

    <p style="margin-top:42px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="#/roadmap">See the roadmap →</a><a class="btn btn-ghost" href="#/">Build a site</a></p>
  </div>`;
}

/* ---------------- system · the production line, made visible ---------------- */
function docsPage(){
  // the production line: brief -> reliable product. The LLM DECIDES; the system BUILDS.
  const stages = [
    { n:'1', t:'Brief', d:'You describe the product in one sentence — a landing page, a bakery site, a booking app, anything. The shape (landing vs multi-page) and archetype (site / app / store) are detected in code, never guessed.' },
    { n:'2', t:'Plan', d:'An LLM writes a bespoke dependency graph for THIS brief — research, branding, content, a real database step for apps. The whole graph lives in Postgres; an SQL trigger unblocks each step the instant its dependencies pass, so a crash or restart never loses work.' },
    { n:'3', t:'Database', d:'An app or store brief gets its OWN isolated Postgres schema, compiled from a typed data model — real keys, relations, indexes, seed records. On a rebuild the schema is MIGRATED, never dropped: your data survives.' },
    { n:'4', t:'Compose', d:'ONE model for the whole site. The composer chooses every page’s sections and writes the real copy in a single pass — so brand, tone and navigation cannot drift between pages. The business name itself is system-owned and injected deterministically.' },
    { n:'5', t:'Render', d:'A deterministic renderer projects each page from that one model using hand-built, vetted components. Forms are compiled from the database schema — right fields, typed validation, dropdowns listing real records. Navigation, spacing, fonts and WCAG-safe colours are correct by construction.' },
    { n:'6', t:'Media', d:'Real photography is pulled from Pexels, downloaded and served locally — no hotlinks, no grey placeholders.' },
    { n:'7', t:'Verify', d:'Deterministic gates at every step — the model rejects into a retry with the reason, never ships broken. Then a REAL browser uses the finished site: clicks every button, submits the form, checks the data landed. High-severity findings trigger an automatic re-compose and re-review (bounded).' },
    { n:'8', t:'CMS', d:'The finished site is pushed into Directus and re-served THROUGH it, proven by a mutation test: a change written via the CMS must appear in the served page. From then on pages render fresh from the CMS on every request — edit content, see it live, no rebuild.' },
    { n:'9', t:'Ship', d:'A real, verified website at /sites/:id — and it keeps working for its owner: every form submission is emailed to them within seconds, and a Rebuild evolves the site without losing a single row of data.' },
  ];
  // the vetted pieces the renderer composes from — the puzzle, not the magic
  const blocks = [
    ['hero','A full-bleed opening: eyebrow, headline, subhead, call-to-action and a hero photo.'],
    ['features','A titled grid of 3–4 value points.'],
    ['split','Image beside text, reversible — story, product or proof.'],
    ['gallery','A 4–6 image grid for work, menu or product shots.'],
    ['cta','A focused band that asks for the one action.'],
    ['form','A real form whose submissions are stored in the database.'],
    ['feed','A live list of the site’s own public submissions — a directory, wall or reviews.'],
    ['collection','A live list rendered from the project’s real database table — products, menu, listings.'],
    ['pricing','Two-to-three plans, one featurable, with check-marked feature lists.'],
    ['testimonials','Quote cards — social proof in the brand’s voice.'],
    ['faq','A clean question/answer accordion (no JS).'],
    ['stats','A band of big-number proof points.'],
  ];
  // one engine, many layers — the brief decides which apply. No discrimination.
  const layers = [
    { t:'Website', b:'live', d:'A multi-page site with one consistent navigation and brand across every page.' },
    { t:'CMS-native', b:'live', d:'Every site is built on ONE real headless CMS — Directus. Content lives in the CMS and pages are served live from it; a zero-trust gate proves it on every build. Replaces the old inline text editor and the retired 5-CMS plan.' },
    { t:'Full-stack + database', b:'live', d:'An app/store brief gets its OWN isolated Postgres schema — a typed data model compiled into flawless DDL, seeded, read back on the page, and introspected in the Data tab.' },
    { t:'Rooted identity', b:'live', d:'Five design languages; the brief picks one and the renderer expands it into typography, rhythm and shape — never one template recoloured.' },
    { t:'Visual QA', b:'live', d:'Every finished site is screenshotted on mobile and desktop and scored by a vision model.' },
    { t:'Interaction QA', b:'live', d:'A real browser clicks every button, submits the form and checks the data — verdict shown on each project. High findings trigger automatic self-repair.' },
    { t:'Rebuild without data loss', b:'live', d:'Update the brief, rebuild in place: branding survives, the database is migrated (new fields appear, every row kept — guarded by an automatic rollback).' },
    { t:'Lead email alerts', b:'live', d:'Every form submission on a produced site is emailed to its owner within seconds, from the agency’s own authenticated address.' },
  ];
  const infra = [
    { t:'Relay server', d:'systemd · Restart=always', s:'ok' },
    { t:'Cloudflare tunnel', d:'systemd · own dedicated tunnel', s:'ok' },
    { t:'Postgres', d:'Docker · unless-stopped', s:'ok' },
    { t:'DB backups', d:'pg_dump every 6h · 14 kept', s:'ok' },
    { t:'Uptime monitor', d:'5 min · Telegram alerts', s:'ok' },
    { t:'Real photography', d:'Pexels · downloaded + served locally', s:'ok' },
    { t:'Visual QA', d:'vision model · mobile + desktop', s:'ok' },
    { t:'Lead email', d:'SMTP · SPF/DKIM/DMARC · status at mail.naples.agency', s:'ok' },
  ];
  const verify = [
    ['site_model','the composed site model: every page present, hero-first, real copy (no slop/placeholders); a landing page must be exactly 1 page with ≥2 proof/offer sections ending in a CTA; an app must carry its typed form'],
    ['site_renders','valid structural HTML, no external/placeholder assets, no dead CTA, wired forms'],
    ['site_consistent','one logo, one palette, one navigation — identical across every page of the site'],
    ['served_from_cms','a sentinel written through the CMS must surface in the re-served page — proof the site is genuinely CMS-served, not a static copy'],
    ['app_db','the app’s own isolated Postgres schema actually provisions and has its tables'],
    ['migration guard','a rebuild runs additive-only migrations in one transaction — if any table would lose rows, everything rolls back'],
    ['wcag','AA contrast on text vs background — derived by the renderer, so always binding'],
    ['json · sql_applies','output must parse / the SQL actually runs against Postgres'],
    ['interaction review','a real browser clicks every button, loads every link target, submits the form and checks the row persisted — verdict shown on every project'],
  ];
  const REPO='https://github.com/naoufac/agency-pipeline/blob/master';
  app.innerHTML = `<div class="container section">
    <span class="eyebrow">● the system</span>
    <h1 style="margin-top:14px">One prompt in, a reliable product out.</h1>
    <p class="lead" style="margin-top:14px">Relay is a production line, not a magic trick. A brief becomes a real, verified website — or a full-stack app with a database — through a graph of steps where each one proves itself before the next begins. Nothing magic: just very good logic and a lot of attention to detail.</p>

    <h2 class="rv-h">The production line</h2>
    <div class="pipe">${stages.map((s,i)=>`<div class="pipe-node"><div class="pipe-n">${s.n}</div><h3>${s.t}</h3><p class="muted">${esc(s.d)}</p></div>${i<stages.length-1?'<div class="pipe-arrow">↓</div>':''}`).join('')}</div>

    <div class="rv-decision" style="border-left-color:var(--st-done)"><h3>Why it can’t go wrong — decision vs construction</h3><p class="muted">The model only <b style="color:var(--text)">decides</b>: the words, the structure that fits the brief, and two brand colours. The system <b style="color:var(--text)">builds</b>: every page is composed from the same vetted parts, so navigation, spacing, fonts and colour contrast are correct by construction. We don’t ask the model to draw a button — we hand it a button that already works.</p></div>

    <h2 class="rv-h">The building blocks</h2>
    <p class="muted" style="margin:6px 0 14px;max-width:72ch">A world-class site is great branding, the right sections — well-spaced and repeated — and a navigation that answers the need. These are the vetted pieces the renderer composes from. The puzzle we gather, not the magic.</p>
    <div class="rv-list">${blocks.map(b=>`<div class="card rv-card"><code>${b[0]}</code><p class="muted" style="margin-top:8px">${esc(b[1])}</p></div>`).join('')}</div>

    <h2 class="rv-h">Layers, one engine <span class="rv-count done">no discrimination</span></h2>
    <p class="muted" style="margin:6px 0 14px;max-width:72ch">Website, CMS, database, QA — different use cases riding the same production line. The brief decides which apply. A bakery’s presentation and a delivery app come off the same line.</p>
    <div class="layer-grid">${layers.map(x=>`<div class="card layer ${x.s||'ok'}"><span class="lay-badge ${x.s||'ok'}">${x.b}</span><h3 style="font-size:15px;margin-top:8px">${x.t}</h3><p class="muted" style="margin-top:6px;font-size:13px">${esc(x.d)}</p></div>`).join('')}</div>

    <div class="rv-decision"><h3>Zero-trust, always</h3><p class="muted">A step is “done” only when a deterministic check passes — the site actually renders, the contrast actually meets AA, the JSON actually parses, the SQL actually runs. If a check can’t fail, it isn’t a check.</p></div>

    <h2 class="rv-h">Verify gate</h2>
    <div class="rv-list">${verify.map(v=>`<div class="card rv-card"><code>${v[0]}</code><p class="muted" style="margin-top:8px">${esc(v[1])}</p></div>`).join('')}</div>

    <h2 class="rv-h">Built to last <span class="rv-count done">live</span></h2>
    <div class="layer-grid">${infra.map(x=>`<div class="card layer ${x.s}"><span class="lay-badge ${x.s}">${x.s==='ok'?'✓ supervised':'● in progress'}</span><h3 style="font-size:15px;margin-top:8px">${x.t}</h3><p class="muted" style="margin-top:6px;font-size:13px">${esc(x.d)}</p></div>`).join('')}</div>

    <h2 class="rv-h">Data model</h2>
    <p class="muted" style="margin:6px 0 0;max-width:72ch">Postgres: <code>projects</code> → <code>tasks</code> → <code>task_dependencies</code> (the DAG) + <code>task_outputs</code> (versioned, one current) + <code>run_events</code>. the full-stack layer adds <code>site_submissions</code>; visual QA adds <code>qa_reviews</code> and interaction QA <code>dogfood_reviews</code>. Each app/store project also gets its OWN isolated schema <code>app_&lt;id&gt;</code> holding its real tables — never mixed with the engine’s. A trigger and the <code>v_ready_tasks</code> view define readiness in SQL, so the scheduler stays dumb and restart-safe.</p>

    <h2 class="rv-h">Full written docs</h2>
    <div class="rv-list">
      <a class="card rv-card" href="${REPO}/docs/ARCHITECTURE.md" target="_blank" rel="noopener"><h3 class="rv-title">Architecture ↗</h3><p class="muted" style="margin-top:8px">How it really works, table by table.</p></a>
      <a class="card rv-card" href="${REPO}/docs/OPERATIONS.md" target="_blank" rel="noopener"><h3 class="rv-title">Operations runbook ↗</h3><p class="muted" style="margin-top:8px">Deploy, restart, troubleshoot, survive reboot.</p></a>
      <a class="card rv-card" href="${REPO}/AGENTS.md" target="_blank" rel="noopener"><h3 class="rv-title">Agent guide ↗</h3><p class="muted" style="margin-top:8px">For the next AI or dev continuing this.</p></a>
      <a class="card rv-card" href="${REPO}/docs/HARDENING.md" target="_blank" rel="noopener"><h3 class="rv-title">Hardening backlog ↗</h3><p class="muted" style="margin-top:8px">What’s done vs tracked for scale.</p></a>
    </div>
    <p style="margin-top:40px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="#/review">See the review →</a><a class="btn btn-ghost" href="#/">Build a site</a></p>
  </div>`;
}

/* ---------------- router ---------------- */
function router(){
  clearPoll(); closeDrawer(false); navLinks?.classList.remove('open');
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
  else if (seg[0] === 'signin') { navPath = '/signin'; signin(); }
  else if (seg[0] === 'new') { navPath = '/new'; newSite(); }
  else if (seg[0] === 'roadmap') { navPath = '/roadmap'; roadmap(); }
  else if (seg[0] === 'review') { navPath = '/review'; review(); }
  else if (seg[0] === 'docs') { navPath = '/docs'; docsPage(); }
  else if (seg[0] === 'about') { navPath = '/about'; about(); }
  else if (seg[0] === 'p' && seg[1]) { navPath = '/'; const tab = ['site','build','files','metrics','qa','data'].includes(seg[2]) ? seg[2] : 'site'; project(seg[1], tab, seq ? Number(seq) : null); }
  else home();

  document.querySelectorAll('.nav-links a').forEach(a => a.classList.toggle('active', a.getAttribute('data-route') === navPath));
  if (!query) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);
router();
loadMe();

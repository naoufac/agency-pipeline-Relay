// Relay SPA — one app, shared shell, hash router. No scattered pages.
const COLOR = { blocked:'#5C6678', ready:'#E0B341', running:'#5A8DEE', verifying:'#A06CD5', done:'#36B37E', failed:'#F0506E' };
const app = document.getElementById('app');
let viewId = null;        // project shown on the dashboard (null = latest)
let net = null, nodes = null, edges = null, known = new Set(), pollTimer = null;

const j = (u, o) => fetch(u, o).then(r => r.json());
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function stopPoll(){ if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } net = null; nodes = null; edges = null; known = new Set(); }

/* ---------------- output drawer = the human bridge ---------------- */
function drawer(){
  let d = document.getElementById('drawer');
  if (!d){ d = document.createElement('div'); d.id = 'drawer'; d.className = 'drawer'; document.body.appendChild(d); }
  return d;
}
async function openOutput(seq){
  if (!viewId) { const b = await j('/api/board'); viewId = b.project && b.project.id; }
  const o = await j(`/api/output?id=${viewId}&seq=${seq}`);
  const d = drawer();
  d.innerHTML = `
    <div class="drawer-head">
      <div>
        <span class="pill"><i class="dot s-${o.status}"></i>${o.status||''}</span>
        <span class="muted" style="margin-left:8px">#${o.seq} · ${o.department}</span>
      </div>
      <button class="x" aria-label="close">✕</button>
    </div>
    <h3 class="drawer-title">${esc(o.title)}</h3>
    <div class="muted" style="font-size:12px;margin-bottom:14px">verify: <code>${esc(o.verify)}</code></div>
    ${o.department === 'build' && o.status === 'done' ? `
      <a class="btn btn-sm" target="_blank" rel="noopener" href="/sites/${viewId}/" style="margin-bottom:12px">Open the produced site ↗</a>
      <img src="/sites/${viewId}/preview.png?t=${Date.now()}" alt="site preview" style="display:block;width:100%;border:1px solid var(--line);border-radius:10px;margin-bottom:14px"/>` : ''}
    <pre class="output">${esc(o.content) || '<span class="muted">— no output yet —</span>'}</pre>`;
  d.classList.add('open');
  d.querySelector('.x').onclick = () => d.classList.remove('open');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { const d=document.getElementById('drawer'); if(d) d.classList.remove('open'); } });

/* ---------------- KPI strip ---------------- */
function renderKpis(k){
  const el = document.getElementById('kpis'); if (!el || !k) return;
  el.innerHTML = k.kpis.map(m => `
    <div class="kpi tone-${m.tone}">
      <div class="kpi-label">${m.label}</div>
      <div class="kpi-value">${m.value}</div>
      <div class="kpi-sub">${m.sub}</div>
    </div>`).join('');
}

/* ---------------- pages ---------------- */
function dashboard(){
  app.innerHTML = `
  <div class="container">
    <section class="hero">
      <span class="eyebrow">● live · autonomous</span>
      <h1>Briefs in.<br>Shipped work out.</h1>
      <p class="lead">Hand Relay a brief. A planner explodes it into a dependency graph of department-agents — research, branding, build, QA — that run stage by stage, each one verified before the next begins.</p>
      <div class="brief-bar">
        <input id="brief" class="input" placeholder="e.g. build a food delivery app for Lebanon" />
        <button id="go" class="btn">Run the agency →</button>
      </div>
    </section>

    <div class="board-head">
      <h3 id="blabel">Latest build</h3>
      <span id="counts" class="pill"></span>
      <a id="opensite" class="btn btn-sm" target="_blank" rel="noopener" style="display:none">Open the site ↗</a>
      <div class="legend">${Object.keys(COLOR).map(k=>`<span><i class="dot s-${k}"></i>${k}</span>`).join('')}</div>
    </div>
    <div id="kpis" class="kpis"></div>
    <p class="hint">▸ click any task to read what it produced</p>
    <div id="net"></div>
  </div>`;

  document.getElementById('go').onclick = submitBrief;
  document.getElementById('brief').addEventListener('keydown', e => { if (e.key === 'Enter') submitBrief(); });
  initBoard();
  tick();
  pollTimer = setInterval(tick, 1000);
  const tp = new URLSearchParams((location.hash.split('?')[1] || '')).get('task');
  if (tp) setTimeout(() => openOutput(Number(tp)), 1400);
}

async function submitBrief(){
  const input = document.getElementById('brief');
  const brief = input.value.trim(); if (!brief) return;
  const btn = document.getElementById('go'); btn.textContent = 'Planning…'; btn.disabled = true;
  try { const r = await j('/api/run', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ brief }) });
        viewId = r.id; known = new Set(); if (nodes) { nodes.clear(); edges.clear(); } input.value=''; }
  catch(e){}
  btn.textContent = 'Run the agency →'; btn.disabled = false;
}

function initBoard(){
  nodes = new vis.DataSet(); edges = new vis.DataSet();
  net = new vis.Network(document.getElementById('net'), { nodes, edges }, {
    layout:{ hierarchical:{ direction:'LR', sortMethod:'directed', levelSeparation:210, nodeSpacing:92 } },
    physics:false,
    nodes:{ shape:'box', widthConstraint:{ maximum:178 }, margin:11, borderWidth:0,
            shapeProperties:{ borderRadius:10 }, font:{ color:'#fff', size:13, face:'Inter' } },
    edges:{ arrows:'to', color:{ color:'#2A3346', highlight:'#7C7AFF' }, smooth:{ type:'cubicBezier', roundness:.55 } },
    interaction:{ hover:true }
  });
  net.on('click', p => { if (p.nodes && p.nodes.length) openOutput(p.nodes[0]); });
}

async function tick(){
  if (!nodes) return;
  let d; try { d = await j('/api/board' + (viewId ? '?id='+viewId : '')); } catch { return; }
  const lbl = document.getElementById('blabel'), cs = document.getElementById('counts');
  if (!d.project){ if (lbl) lbl.textContent = 'No builds yet — give Relay a brief above.'; return; }
  if (!viewId) viewId = d.project.id;
  if (lbl) lbl.textContent = d.project.brief;
  const c = {}; d.tasks.forEach(t => c[t.status]=(c[t.status]||0)+1);
  if (cs) cs.innerHTML = `<span class="count">${c.done||0}</span>&nbsp;/&nbsp;${d.tasks.length} done` + (c.failed?` · ${c.failed} failed`:'');
  d.tasks.forEach(t => {
    const n = { id:t.seq, label:`#${t.seq}  ${t.department}\n${t.title}`, color:{ background:COLOR[t.status]||'#555', border:'#0A0C12' } };
    if (known.has(t.seq)) nodes.update(n); else { nodes.add(n); known.add(t.seq); }
  });
  d.edges.forEach(e => { const id='e'+e.from+'_'+e.to; if (!edges.get(id)) edges.add({ id, from:e.from, to:e.to }); });
  const os = document.getElementById('opensite');
  if (os) { if (d.site) { os.href = d.site; os.style.display = 'inline-flex'; } else os.style.display = 'none'; }
  try { renderKpis(await j('/api/kpi?id='+viewId)); } catch {}
}

async function projects(){
  app.innerHTML = `<div class="container section"><h2>Projects</h2><p class="muted" style="margin-top:8px">Every brief Relay has run — with its KPIs.</p><div id="plist" class="grid grid-2" style="margin-top:32px"></div></div>`;
  const list = await j('/api/projects'); const wrap = document.getElementById('plist');
  if (!list.length){ wrap.innerHTML = `<div class="empty">No projects yet. Start one from the Dashboard.</div>`; return; }
  wrap.innerHTML = list.map(p => {
    const pct = p.total ? Math.round(100*p.done/p.total) : 0;
    const fp  = p.done ? Math.round(100*p.firstpass/p.done) : 0;
    const rig = p.total ? Math.round(100*p.realchecks/p.total) : 0;
    const st = p.failed ? 'failed' : (p.active ? 'running' : (p.done===p.total && p.total ? 'done' : 'ready'));
    return `<a class="card proj" href="#/" data-open="${p.id}">
      <div class="row" style="justify-content:space-between">
        <span class="pill"><i class="dot s-${st}"></i>${st}</span>
        <span class="muted" style="font-size:12px">${p.wall||0}s</span>
      </div>
      <div class="brief" style="margin-top:12px">${esc(p.brief)}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="kpi-mini">
        <span><b>${pct}%</b> done</span><span><b>${fp}%</b> first-pass</span><span class="${rig<40?'warn':''}"><b>${rig}%</b> rigor</span>
      </div>
    </a>`; }).join('');
  wrap.querySelectorAll('[data-open]').forEach(a => a.addEventListener('click', () => { viewId = a.getAttribute('data-open'); }));
}

function about(){
  app.innerHTML = `<div class="container section"><div class="prose">
    <span class="eyebrow">About Relay</span>
    <h1 style="margin-top:16px">An agency that runs itself.</h1>
    <p style="margin-top:16px">Relay is an autonomous creative + engineering agency. You give it a brief; it delivers shipped work — not a to-do list. Under the hood it mimics how a real studio passes a project desk to desk, but every hand-off is a machine step that proves itself before the next one starts.</p>
    <h2>How it works</h2>
    <div class="steps">
      <div class="step"><div><b>1 · Plan</b><span class="muted">A planner reads the brief and explodes it into a dependency graph of tasks — who depends on whom.</span></div></div>
      <div class="step"><div><b>2 · Run, stage by stage</b><span class="muted">Independent tasks run in parallel; dependent ones wait. Finishing a task unblocks the next.</span></div></div>
      <div class="step"><div><b>3 · Verify, never trust</b><span class="muted">A task is only “done” when a deterministic check passes. An agent’s word counts for nothing.</span></div></div>
      <div class="step"><div><b>4 · Ship</b><span class="muted">Real artifacts, assembled and accepted automatically. Brief in, shipped work out.</span></div></div>
    </div>
    <h2>Principles</h2>
    <p><b style="color:var(--text)">Autonomous.</b> No human in the loop.<br>
       <b style="color:var(--text)">Zero-trust.</b> Completion is proven by checks the model can’t fake.<br>
       <b style="color:var(--text)">Real output.</b> Code and artifacts, not descriptions.</p>
    <p style="margin-top:32px"><a class="btn" href="#/">Give Relay a brief →</a></p>
  </div></div>`;
}

/* ---------------- router ---------------- */
const routes = { '/':dashboard, '/projects':projects, '/about':about };
function router(){
  stopPoll();
  const d = document.getElementById('drawer'); if (d) d.classList.remove('open');
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.toggle('active', a.getAttribute('data-route') === path));
  (routes[path] || dashboard)();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);
router();

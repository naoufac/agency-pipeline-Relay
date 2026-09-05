import { buildMindmap } from './mindmap.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

{
  const view = buildMindmap({
    project: {
      id: '11111111-1111-1111-1111-111111111111',
      status: 'running',
      params: {
        deliverable: 'automation',
        builder: 'campaign',
        chainReason: 'CSV + no website → automation',
        capabilities: [],
        contract: { excludesWebsite: true, reasons: ['explicit: no website'] },
      },
    },
    tasks: [
      { seq: 1, title: 'Job contract', department: 'strategy', status: 'done', verify: 'min:280' },
      { seq: 2, title: 'Inspect existing systems', department: 'research', status: 'done', verify: 'min:280' },
      { seq: 3, title: 'Ops job', department: 'integration', status: 'ready', verify: 'ops_job', artifact: 'job.json' },
      { seq: 4, title: 'QA — automation contract', department: 'qa', status: 'blocked', verify: 'min:20' },
    ],
    events: [
      { type: 'orchestrated', detail: 'automation · campaign · CSV + no website' },
      { type: 'planned', detail: '4 tasks' },
    ],
  });
  ok('source is database', view.source === 'database');
  ok('automation deliverable', view.deliverable === 'automation');
  ok('next action is the ready ops job', view.nextAction?.department === 'integration' && view.nextAction?.seq === 3, JSON.stringify(view.nextAction));
  ok('remaining excludes done tasks', view.remaining.every((r) => r.status !== 'done') && view.remaining.length === 2);
  ok('no branding branch', !JSON.stringify(view.branches).includes('branding'));
  ok('no hero', !JSON.stringify(view).toLowerCase().includes('hero'));
  ok('contract exclusion visible', String(view.contract?.reasons || []).includes('no website'));
  ok('evidence includes orchestrated', view.evidence.some((e) => e.type === 'orchestrated'));
  ok('execute branch has the ops job', view.branches.some((b) => b.children?.some((c) => c.department === 'integration')));
}

{
  const view = buildMindmap({
    project: {
      id: '22222222-2222-2222-2222-222222222222',
      status: 'running',
      params: {
        deliverable: 'astro_site',
        builder: 'astro',
        chainReason: 'requested stack: astro',
        capabilities: ['content_copy'],
        contract: { requestedStack: 'astro', reasons: ['requested stack: astro'] },
      },
    },
    tasks: [
      { seq: 1, title: 'Audience', department: 'strategy', status: 'done' },
      { seq: 2, title: 'Research', department: 'research', status: 'done' },
      { seq: 3, title: 'Brand', department: 'branding', status: 'done' },
      { seq: 4, title: 'Design', department: 'design', status: 'failed', attempts: 3, verify: 'min:280' },
      { seq: 5, title: 'Compose Astro', department: 'compose', status: 'blocked' },
      { seq: 6, title: 'Render Home', department: 'render', status: 'blocked', artifact: 'index.html' },
    ],
    events: [
      { type: 'verify_failed', detail: '#4: slop copy' },
      { type: 'orchestrated', detail: 'astro_site · astro · requested stack: astro' },
    ],
  });
  ok('astro next action is the failed design (revise, do not regenerate data)', view.nextAction?.department === 'design' && view.nextAction?.status === 'failed', JSON.stringify(view.nextAction));
  ok('blocker listed', view.blockers.length === 1 && view.blockers[0].seq === 4);
  ok('why says revise not regenerate', /revise/.test(view.nextAction?.why || ''));
  ok('compose remains remaining', view.remaining.some((r) => r.department === 'compose'));
  ok('evidence has verify_failed', view.evidence.some((e) => e.type === 'verify_failed'));
}

{
  const view = buildMindmap({
    project: { id: '33333333-3333-3333-3333-333333333333', status: 'done', params: { deliverable: 'astro_site', builder: 'astro' } },
    tasks: [
      { seq: 1, title: 'Audience', department: 'strategy', status: 'done' },
      { seq: 2, title: 'Render Home', department: 'render', status: 'done' },
    ],
    events: [{ type: 'cms_built', detail: 'builder:astro · astro: 1 page(s)' }],
  });
  ok('completed project has no next action', view.nextAction === null);
  ok('completed remaining empty', view.remaining.length === 0);
  ok('astro evidence present', view.evidence.some((e) => e.type === 'cms_built' && /astro/.test(e.detail)));
}

{
  const srv = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');
  ok('server exposes GET /api/mindmap', srv.includes("path === '/api/mindmap'") && srv.includes('mindmapJSON'));
  ok('boardJSON attaches mindmap view', /return \{ project: projectOut, tasks, edges[\s\S]{0,200}mindmap/.test(srv));
  ok('mindmap is built from DB rows, not a static file', srv.includes('buildMindmap') && !srv.includes('render-mindmap.mjs'));
}

console.log(`\nmindmap:check — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

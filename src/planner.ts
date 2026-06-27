import pg from 'pg';
import { llm } from './agents.ts';

// A task in the normalized plan shape used for insertion.
type Task = { seq: number; title: string; department: string; verify: string; depends_on: number[]; artifact: string | null };

// Hardcoded FALLBACK graph — used only if the LLM planner is unavailable or returns garbage.
const FALLBACK: Task[] = [
  { seq:1, title:'Audience & positioning research', department:'research', verify:'nonempty',     depends_on:[],        artifact:null },
  { seq:2, title:'Brand system (tokens)',           department:'branding', verify:'contains:#',   depends_on:[1],       artifact:null },
  { seq:3, title:'Information architecture',         department:'content',  verify:'nonempty',     depends_on:[1],       artifact:null },
  { seq:4, title:'Copywriting',                      department:'content',  verify:'nonempty',     depends_on:[2,3],     artifact:null },
  { seq:5, title:'Imagery & art direction',         department:'media',    verify:'nonempty',     depends_on:[2],       artifact:null },
  { seq:6, title:'Build the website',               department:'build',    verify:'site_renders', depends_on:[2,3,4,5], artifact:'index.html' },
  { seq:7, title:'QA — acceptance (renders live)',  department:'qa',       verify:'site_renders', depends_on:[6],       artifact:null },
];

const PLANNER_SYS = `You are the Planner for an automated agency that ships a real, single-file website for ANY brief.
Given the brief, output the tasks an agency would run, in dependency order, ending in a build step that produces the actual website.

Output ONLY JSON (no prose, no markdown fences):
{"tasks":[{"seq":1,"title":"...","department":"research","verify":"nonempty","depends_on":[]}, ...]}

Rules:
- 5 to 9 tasks. seq is 1..N in dependency order; depends_on may reference ONLY earlier seq numbers.
- ADAPT the upstream tasks to THIS specific brief — a pricing page, a portfolio, a docs site, an event page, a restaurant menu each need different research, sections and copy. Make titles concrete to the brief.
- Allowed departments: research, strategy, branding, content, copywriting, media, design, seo, build, qa (or a short lowercase word).
- The plan MUST end with exactly one task {"department":"build","verify":"site_renders","artifact":"index.html"} that depends on the brand + content + structure tasks. You MAY add a final {"department":"qa","verify":"site_renders"} acceptance task after it.
- verify must be one of: "nonempty" (thinking/spec steps), "contains:<word>" (when a specific token must appear), "site_renders" (ONLY for build/qa).
- Keep it lean and real. JSON only.`;

function validate(plan: any): Task[] | null {
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) return null;
  const ok = (v: any) => typeof v === 'string' && (['nonempty','site_renders','sql_applies'].includes(v) || /^contains:.+/.test(v));
  let tasks: Task[] = plan.tasks.slice(0, 14).map((t: any, i: number) => ({
    seq: Number.isFinite(+t.seq) ? +t.seq : i + 1,
    title: String(t.title || `Step ${i + 1}`).slice(0, 90),
    department: (String(t.department || 'work').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'work').slice(0, 20),
    verify: ok(t.verify) ? t.verify : 'nonempty',
    depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(Number).filter(Number.isFinite) : [],
    artifact: t.artifact === 'index.html' ? 'index.html' : null,
  }));
  // renumber 1..N in given order, remap deps, keep only backward edges (guarantees acyclic)
  tasks.sort((a, b) => a.seq - b.seq);
  const remap: Record<number, number> = {}; tasks.forEach((t, i) => (remap[t.seq] = i + 1));
  tasks.forEach(t => { const ns = remap[t.seq]; t.depends_on = [...new Set(t.depends_on.map(d => remap[d]).filter(d => d && d < ns))]; t.seq = ns; });
  tasks.forEach(t => { if (t.verify === 'site_renders' && !['build','qa'].includes(t.department)) t.verify = 'nonempty'; });
  // collapse to ONE real deliverable build = the last build step; earlier 'build' steps become design specs
  const builds = tasks.filter(t => t.department === 'build');
  let build: Task;
  if (builds.length) {
    build = builds[builds.length - 1];
    builds.slice(0, -1).forEach(b => { b.department = 'design'; b.verify = 'nonempty'; b.artifact = null; });
  } else {
    build = { seq: tasks.length + 1, title: 'Build the website', department: 'build', verify: 'site_renders', artifact: 'index.html', depends_on: [] };
    tasks.push(build);
  }
  build.department = 'build'; build.verify = 'site_renders'; build.artifact = 'index.html';
  // the build fans in from EVERY prior non-QA step so it has full context (brand, copy, design)
  build.depends_on = tasks.filter(t => t.seq < build.seq && t.department !== 'qa').map(t => t.seq);
  // QA acceptance re-renders the finished site
  tasks.filter(t => t.department === 'qa').forEach(q => { q.verify = 'site_renders'; q.artifact = null; if (!q.depends_on.includes(build.seq)) q.depends_on = [build.seq]; });
  if (tasks.length < 2) return null;
  return tasks;
}

async function llmPlan(brief: string): Promise<Task[] | null> {
  let raw = '';
  try { raw = await llm(PLANNER_SYS, 'BRIEF: ' + brief, 2000); } catch { return null; }
  if (!raw.trim()) return null;
  const txt = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  let parsed: any; try { parsed = JSON.parse(txt.slice(s, e + 1)); } catch { return null; }
  try { return validate(parsed); } catch { return null; }
}

export async function plan(pool: pg.Pool, brief: string): Promise<string> {
  const tasks = (await llmPlan(brief)) || FALLBACK;
  const usedLLM = tasks !== FALLBACK;
  const params = { planner: usedLLM ? 'llm' : 'template', assumptions: ['format=single-page site'] };

  const p = await pool.query('insert into projects(brief, params) values ($1,$2) returning id', [brief, params]);
  const projectId: string = p.rows[0].id;

  const seqToId: Record<number, string> = {};
  for (const t of tasks) {
    const r = await pool.query(
      'insert into tasks(project_id, seq, title, department, verify, artifact) values ($1,$2,$3,$4,$5,$6) returning id',
      [projectId, t.seq, t.title, t.department, t.verify, t.artifact]);
    seqToId[t.seq] = r.rows[0].id;
  }
  for (const t of tasks) for (const d of t.depends_on)
    if (seqToId[d]) await pool.query('insert into task_dependencies(upstream_id, downstream_id) values ($1,$2) on conflict do nothing', [seqToId[d], seqToId[t.seq]]);

  await pool.query(
    `update tasks set status='ready' where project_id=$1 and status='blocked'
       and not exists (select 1 from task_dependencies d where d.downstream_id = tasks.id)`, [projectId]);
  await pool.query("insert into run_events(project_id, type, detail) values ($1,'planned',$2)", [projectId, `${tasks.length} tasks · ${usedLLM ? 'LLM planner' : 'template fallback'}`]);
  return projectId;
}

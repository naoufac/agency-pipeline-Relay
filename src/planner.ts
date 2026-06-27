import pg from 'pg';
import { llm } from './agents.ts';
import { themeFor, classifyTheme, type ThemeName } from './themes.ts';

type Task = { seq: number; title: string; department: string; verify: string; depends_on: number[]; artifact: string | null };
export type Page = { slug: string; title: string };
type Plan = { tasks: Task[]; pages: Page[]; theme: ThemeName };

// Fallback (LLM unavailable): a small multi-page site.
const FB_THINKING: Task[] = [
  { seq:1, title:'Audience & positioning research', department:'research', verify:'min:280',   depends_on:[],    artifact:null },
  { seq:2, title:'Brand system (tokens)',           department:'branding', verify:'wcag',       depends_on:[1],   artifact:null },
  { seq:3, title:'Information architecture',         department:'content',  verify:'json',       depends_on:[1],   artifact:null },
  { seq:4, title:'Copywriting',                      department:'content',  verify:'json',       depends_on:[2,3], artifact:null },
];
const FB_PAGES: Page[] = [{ slug:'index', title:'Home' }, { slug:'about', title:'About' }, { slug:'contact', title:'Contact' }];

const PLANNER_SYS = `You are the Planner for an automated agency that ships a real MULTI-PAGE website for ANY brief.
Output ONLY JSON (no prose, no fences):
{"theme":"editorial|modern|warm|bold|minimal",
 "pages":[{"slug":"index","title":"Home"},{"slug":"about","title":"About"}, ...],
 "tasks":[{"seq":1,"title":"...","department":"research","depends_on":[]}, ...]}

Rules:
- "theme": the design language that best fits the brief — editorial (law/finance/architecture/luxury — serif, refined), modern (saas/product/tech — geometric sans), warm (cafe/bakery/wellness/craft — soft, rounded), bold (agency/fitness/events/fashion — oversized, high-energy), minimal (portfolio/photography/studio — spare). Pick exactly one.
- "pages": 2 to 5 pages tailored to the brief. The FIRST page MUST be {"slug":"index","title":"Home"}. Slugs are lowercase, url-safe, no extension (e.g. "about","services","menu","contact","pricing").
- "tasks": 4 to 7 THINKING steps only (research, strategy, branding, content/IA, copywriting, media, design) in dependency order; depends_on references only earlier seq. Do NOT include build or QA tasks — those are added automatically, one build per page.
- Adapt pages + tasks to THIS brief (a restaurant: Home/Menu/About/Contact; a SaaS: Home/Features/Pricing/Docs; a portfolio: Home/Work/About/Contact).
- Keep titles concrete. JSON only.`;

const slugify = (s: string) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'page';

function normPages(arr: any): Page[] {
  let pages: Page[] = Array.isArray(arr) ? arr.slice(0, 5).map((p: any) => ({ slug: slugify(p.slug || p.title), title: String(p.title || p.slug || 'Page').slice(0, 40) })) : [];
  pages = pages.filter((p, i, a) => p.slug && a.findIndex(x => x.slug === p.slug) === i);
  if (!pages.length) pages = [{ slug: 'index', title: 'Home' }];
  if (pages[0].slug !== 'index') { pages = pages.filter(p => p.slug !== 'index'); pages.unshift({ slug: 'index', title: 'Home' }); }
  return pages.slice(0, 5);
}

function validate(plan: any, brief: string): Plan | null {
  const list = Array.isArray(plan?.tasks) ? plan.tasks : null;
  if (!list || !list.length) return null;
  const pages = normPages(plan.pages);
  const theme = themeFor(plan?.theme, brief);  // trust an LLM-named archetype only if it's in the closed set

  // thinking tasks only (drop any build/qa the LLM emitted)
  let tasks: Task[] = list.map((t: any, i: number) => ({
    seq: Number.isFinite(+t.seq) ? +t.seq : i + 1,
    title: String(t.title || `Step ${i + 1}`).slice(0, 90),
    department: (String(t.department || 'work').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'work').slice(0, 20),
    verify: 'nonempty', depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(Number).filter(Number.isFinite) : [], artifact: null,
  })).filter((t: Task) => !['build', 'qa'].includes(t.department));
  if (tasks.length < 2) return null;
  tasks.sort((a, b) => a.seq - b.seq);
  const rm: Record<number, number> = {}; tasks.forEach((t, i) => (rm[t.seq] = i + 1));
  tasks.forEach(t => { const ns = rm[t.seq]; t.depends_on = [...new Set(t.depends_on.map(d => rm[d]).filter(d => d && d < ns))]; t.seq = ns; });

  // one canonical brand task -> wcag; copy/content -> json; rest -> length floor
  let bi = tasks.findIndex(t => /brand/.test(t.department));
  if (bi < 0) bi = tasks.findIndex(t => /design|visual|look|style|art|theme|colou?r/.test(t.department));
  if (bi < 0) bi = tasks.findIndex(t => !['research', 'strategy'].includes(t.department));
  if (bi >= 0) tasks[bi].department = 'branding';
  for (const t of tasks) t.verify = t.department === 'branding' ? 'wcag' : (/copy|content|writ/.test(t.department) ? 'json' : 'min:280');

  // one render-verified BUILD task per page (fans in from every thinking step), then a QA pass on Home
  const thinkSeqs = tasks.map(t => t.seq);
  let seq = tasks.length;
  const pageBuilds: Task[] = pages.map(pg => ({ seq: ++seq, title: `Build the ${pg.title} page`, department: 'build', verify: 'site_renders', depends_on: thinkSeqs, artifact: `${pg.slug}.html` }));
  const indexBuild = pageBuilds[0];
  const qa: Task = { seq: ++seq, title: 'QA — acceptance (renders live)', department: 'qa', verify: 'site_renders', depends_on: [indexBuild.seq], artifact: null };
  return { tasks: [...tasks, ...pageBuilds, qa], pages, theme };
}

async function llmPlan(brief: string): Promise<Plan | null> {
  let raw = ''; try { raw = await llm(PLANNER_SYS, 'BRIEF: ' + brief, 2000); } catch { return null; }
  if (!raw.trim()) return null;
  const txt = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}'); if (s < 0 || e <= s) return null;
  let parsed: any; try { parsed = JSON.parse(txt.slice(s, e + 1)); } catch { return null; }
  try { return validate(parsed, brief); } catch { return null; }
}

export async function plan(pool: pg.Pool, brief: string): Promise<string> {
  const result = (await llmPlan(brief)) || { tasks: [...FB_THINKING, ...buildsFor(FB_PAGES, FB_THINKING.length)], pages: FB_PAGES, theme: classifyTheme(brief) };
  const usedLLM = result.pages !== FB_PAGES;
  const { tasks, pages, theme } = result;
  const params = { planner: usedLLM ? 'llm' : 'template', pages, theme };

  const p = await pool.query('insert into projects(brief, params) values ($1,$2) returning id', [brief, params]);
  const projectId: string = p.rows[0].id;
  const seqToId: Record<number, string> = {};
  for (const t of tasks) {
    const r = await pool.query('insert into tasks(project_id, seq, title, department, verify, artifact) values ($1,$2,$3,$4,$5,$6) returning id',
      [projectId, t.seq, t.title, t.department, t.verify, t.artifact]);
    seqToId[t.seq] = r.rows[0].id;
  }
  for (const t of tasks) for (const d of t.depends_on)
    if (seqToId[d]) await pool.query('insert into task_dependencies(upstream_id, downstream_id) values ($1,$2) on conflict do nothing', [seqToId[d], seqToId[t.seq]]);
  await pool.query(`update tasks set status='ready' where project_id=$1 and status='blocked' and not exists (select 1 from task_dependencies d where d.downstream_id = tasks.id)`, [projectId]);
  await pool.query("insert into run_events(project_id, type, detail) values ($1,'planned',$2)", [projectId, `${tasks.length} tasks · ${pages.length} pages · ${usedLLM ? 'LLM planner' : 'template'}`]);
  return projectId;
}

function buildsFor(pages: Page[], startSeq: number): Task[] {
  const think = Array.from({ length: startSeq }, (_, i) => i + 1);
  let seq = startSeq;
  const builds: Task[] = pages.map(pg => ({ seq: ++seq, title: `Build the ${pg.title} page`, department: 'build', verify: 'site_renders', depends_on: think, artifact: `${pg.slug}.html` }));
  builds.push({ seq: ++seq, title: 'QA — acceptance', department: 'qa', verify: 'site_renders', depends_on: [builds[0].seq], artifact: null });
  return builds;
}

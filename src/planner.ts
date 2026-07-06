import pg from 'pg';
import { detectLocale } from './i18n.ts';
import { isLocalBusiness } from './jsonld.ts';
import { llm } from './agents.ts';
import { themeFor, type ThemeName } from './themes.ts';
import { archetypeFor, needsData, FACADE_PAGE, type Archetype } from './archetype.ts';
import { shapeFor, type Shape } from './landing.ts';
import { chooseLayout } from './layout.ts';
import { evaluateScope } from './scope.ts';

type Task = { seq: number; title: string; department: string; verify: string; depends_on: number[]; artifact: string | null };
export type Page = { slug: string; title: string };
type Plan = { tasks: Task[]; pages: Page[]; theme: ThemeName; archetype: Archetype; shape: Shape; notes?: string[] };

// Bind a department to its REAL deterministic gate — no `min:280` theatre where a true check exists.
// (kpi.ts counts only sql_applies/site_renders/wcag/json* as rigor; min/nonempty are honest floors.)
const verifyFor = (d: string): string => {
  if (d === 'branding') return 'wcag';
  if (/databas|schema|backend|datamodel/.test(d) || d === 'data' || d === 'sql') return 'app_db';  // provision a real, isolated per-project schema
  if (d === 'policies') return 'policies_ok';        // closed-schema clamp → params.policies → guards enforce
  if (d === 'integrations') return 'calendar_feed';  // mints the key and BUILDS the real ICS feed
  if (/copy|content|writ/.test(d)) return 'json';
  return 'min:280';
};

// Fallback (LLM unavailable): a small multi-page site.
const FB_THINKING: Task[] = [
  { seq:1, title:'Audience & positioning research', department:'research', verify:'min:280',   depends_on:[],    artifact:null },
  { seq:2, title:'Brand system (tokens)',           department:'branding', verify:'wcag',       depends_on:[1],   artifact:null },
  { seq:3, title:'Information architecture',         department:'content',  verify:'json',       depends_on:[1],   artifact:null },
  { seq:4, title:'Copywriting',                      department:'content',  verify:'json',       depends_on:[2,3], artifact:null },
];
const FB_PAGES: Page[] = [{ slug:'index', title:'Home' }, { slug:'about', title:'About' }, { slug:'contact', title:'Contact' }];

const PLANNER_SYS = `You are the Planner for an automated agency that ships a real PRODUCTION for ANY brief — a multi-page website, and for an app or store a real data model too.
Output ONLY JSON (no prose, no fences):
{"theme":"editorial|modern|warm|bold|minimal",
 "archetype":"site|app|store",
 "shape":"landing|multi",
 "pages":[{"slug":"index","title":"Home"},{"slug":"about","title":"About"}, ...],
 "tasks":[{"seq":1,"title":"...","department":"research","depends_on":[]}, ...]}

Rules:
- "theme": the design language that best fits the brief — editorial (law/finance/architecture/luxury — serif, refined), modern (saas/product/tech — geometric sans), warm (cafe/bakery/wellness/craft — soft, rounded), bold (agency/fitness/events/fashion — oversized, high-energy), minimal (portfolio/photography/studio — spare). Pick exactly one.
- "archetype": "site" for a presentation/marketing site; "app" when the brief is software with data (delivery app, booking, marketplace, directory, SaaS, dashboard); "store" for shops/e-commerce/catalogs. If "app" or "store", INCLUDE a "database" task whose output is a runnable PostgreSQL schema for the brief's entities — it is verified by actually applying the SQL.
- "shape": "landing" when the brief asks for a landing/sales/squeeze/one-page conversion page — a landing project has EXACTLY ONE page: [{"slug":"index","title":"Home"}]. Otherwise "multi".
- "pages": 2 to 5 pages tailored to the brief. The FIRST page MUST be {"slug":"index","title":"Home"}. Slugs are lowercase, url-safe, no extension (e.g. "about","services","menu","contact","pricing").
- "tasks": 4 to 7 THINKING steps only (research, strategy, branding, content/IA, copywriting, media, design, and database for app/store) in dependency order; depends_on references only earlier seq. Do NOT include build or QA tasks — those are added automatically, one build per page.
- Adapt pages + tasks to THIS brief (a restaurant: Home/Menu/About/Contact; a SaaS: Home/Features/Pricing/Docs; a delivery app: Home/How-it-works/Restaurants/Sign-up + a database).
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
  let pages = normPages(plan.pages);
  const theme = themeFor(plan?.theme, brief);            // LLM value trusted only if in the closed set
  const archetype = archetypeFor(plan?.archetype, brief); // same: validated, else classified from the brief
  const shape = shapeFor(plan?.shape, brief);             // same: landing detected in CODE, never LLM whim
  // LANDING (PLAN.md M1): exactly ONE page — the conversion page. Forced here, gated in site_model.
  if (shape === 'landing') pages = [pages[0]];
  // FS0 · HONEST APP SURFACE: on a data archetype, a page role the system cannot power yet
  // (dashboard/portal/track/account…) is dropped LOUDLY before it can render as fiction — the
  // facade-dashboard class (invented stats, feature-copy for features that don't exist, dead
  // buttons). Owner views live in the board's Content tab; visitor receipts/sign-in arrive FS1/FS2.
  const notes: string[] = [];
  if (archetype !== 'site') {
    const facade = pages.filter(p => FACADE_PAGE.test(p.slug));
    if (facade.length) {
      pages = pages.filter(p => !FACADE_PAGE.test(p.slug));
      if (!pages.length) pages = [{ slug: 'index', title: 'Home' }];
      notes.push(`dropped unpowerable page(s): ${facade.map(p => p.slug).join(', ')} — no page may ship that the system cannot wire (owner views = Content tab)`);
    }
  }
  // STORE (PQ2): a store must be able to SELL — guarantee cart + checkout pages exist (shop lives on
  // index or a shop page; the products grid is guaranteed at compose time). The page cap must NEVER
  // evict the sell pages (it once cut checkout from a 5-page plan: the cart's Proceed button 404'd and
  // the store could not sell) — brochure pages are trimmed FIRST, then cart/checkout are injected.
  // checkout is matched by its EXACT slug: the cart runtime's Proceed button targets checkout.html
  // literally, so only a page slugged "checkout" satisfies the contract (site_model gates this too).
  if (archetype === 'store' && shape !== 'landing') {
    const hasCart = pages.some(p => /cart|basket|bag/.test(p.slug));
    const hasCo = pages.some(p => p.slug === 'checkout');
    const need = (hasCart ? 0 : 1) + (hasCo ? 0 : 1);
    if (need) pages = pages.slice(0, 6 - need);
    if (!hasCart) pages.push({ slug: 'cart', title: 'Cart' });
    if (!hasCo) pages.push({ slug: 'checkout', title: 'Checkout' });
    pages = pages.slice(0, 6);
  }

  // thinking tasks only (drop any build/qa the LLM emitted)
  let tasks: Task[] = list.map((t: any, i: number) => ({
    seq: Number.isFinite(+t.seq) ? +t.seq : i + 1,
    title: String(t.title || `Step ${i + 1}`).slice(0, 90),
    department: (String(t.department || 'work').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'work').slice(0, 20),
    verify: 'nonempty', depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(Number).filter(Number.isFinite) : [], artifact: null,
  })).filter((t: Task) => !['build', 'qa', 'compose', 'render'].includes(t.department));
  if (tasks.length < 2) return null;
  tasks.sort((a, b) => a.seq - b.seq);
  const rm: Record<number, number> = {}; tasks.forEach((t, i) => (rm[t.seq] = i + 1));
  tasks.forEach(t => { const ns = rm[t.seq]; t.depends_on = [...new Set(t.depends_on.map(d => rm[d]).filter(d => d && d < ns))]; t.seq = ns; });

  // one canonical brand task -> wcag
  let bi = tasks.findIndex(t => /brand/.test(t.department));
  if (bi < 0) bi = tasks.findIndex(t => /design|visual|look|style|art|theme|colou?r/.test(t.department));
  if (bi < 0) bi = tasks.findIndex(t => !['research', 'strategy'].includes(t.department));
  if (bi >= 0) tasks[bi].department = 'branding';

  // FULL AGENCY PRODUCTION: an app/store brief MUST ship a real data model. Guarantee a database
  // department (verified by sql_applies, which actually applies the DDL) — injected if the plan lacks one.
  if (needsData(archetype) && !tasks.some(t => verifyFor(t.department) === 'app_db')) {
    tasks.push({ seq: tasks.length + 1, title: 'Data model (database schema)', department: 'database',
      verify: 'sql_applies', depends_on: [1], artifact: null });
  }
  // DEEPER APP PRODUCTION (owner 2026-07-05: '14 steps are not enough'): every app/store also
  // gets BUSINESS RULES (LLM proposes, the verify clamps, the guards enforce) and OWNER
  // INTEGRATIONS (deterministic: calendar key + a real ICS feed built and proven).
  if (needsData(archetype)) {
    if (!tasks.some(t => t.department === 'policies'))
      tasks.push({ seq: tasks.length + 1, title: 'Business rules (notice, capacity, cancellation)', department: 'policies', verify: 'policies_ok', depends_on: [1], artifact: null });
    if (!tasks.some(t => t.department === 'integrations')) {
      const dbSeq = tasks.find(t => verifyFor(t.department) === 'app_db')?.seq || 1;
      tasks.push({ seq: tasks.length + 1, title: 'Owner integrations (live calendar feed)', department: 'integrations', verify: 'calendar_feed', depends_on: [dbSeq], artifact: null });
    }
  }

  // bind every department to its REAL gate (database -> sql_applies, branding -> wcag, copy/content -> json);
  // the data model also ships as a real schema.sql deliverable on disk (the runner writes it as-is).
  let dbArtifactDone = false;
  for (const t of tasks) {
    t.verify = verifyFor(t.department);
    if (t.verify === 'app_db' && !dbArtifactDone) { t.artifact = 'schema.sql'; dbArtifactDone = true; }
  }

  // CMS-FIRST: the site is ONE model. A single COMPOSE step (fanning in from every thinking step incl. the
  // schema) generates the whole site — brand-locked, every page's sections — once. Then each page is a
  // DETERMINISTIC RENDER projecting that one model (no per-page generation, no per-page LLM). QA last.
  const thinkSeqs = tasks.map(t => t.seq);
  let seq = tasks.length;
  const composeSeq = ++seq;
  const compose: Task = { seq: composeSeq, title: 'Compose the site (one CMS → all pages)', department: 'compose', verify: 'site_model', depends_on: thinkSeqs, artifact: null };
  const pageRenders: Task[] = pages.map(pg => ({ seq: ++seq, title: `Render the ${pg.title} page`, department: 'render', verify: 'site_renders', depends_on: [composeSeq], artifact: `${pg.slug}.html` }));
  // QA acceptance runs AFTER every page is on disk and asserts the whole site is one coherent identity
  // (each page exactly 1 nav + 1 logo; all pages share ONE logo + ONE palette + ONE nav) via site_consistent.
  const qa: Task = { seq: ++seq, title: 'QA — acceptance (1 nav · 1 logo · 1 palette, every page)', department: 'qa', verify: 'site_consistent', depends_on: pageRenders.map(b => b.seq), artifact: null };
  return { tasks: [...tasks, compose, ...pageRenders, qa], pages, theme, archetype, shape, notes };
}

// Hard wall-clock cap on the planner's LLM call. It flows through the shared llm()/callLLM, which already
// honors a 90s fetch-abort — but a stalled web-search completion (or an abort that fails to propagate) can
// still blow the planner step past that, which is what drove p95 to ~3.6h. This Promise.race guarantees the
// step can never exceed PLAN_TIMEOUT_MS, independent of the underlying fetch timeout.
const PLAN_TIMEOUT_MS = Number(process.env.PLAN_TIMEOUT_MS || 60000);

async function llmPlan(brief: string): Promise<Plan | null> {
  // web:false — planner emits a tasks DAG from the brief, doesn't need live web facts. The web plugin adds latency (was the 3.6h p95 root cause pre-R4) and the truncation risk (R2 fix capped reasoning, but web plugin still costs ~5-15s per call). research/strategy keep web:true (the WEB_DEPTS set in agents.ts controls the default; planner explicitly opts in/out here).
  let raw = '';
  try {
    raw = await Promise.race([
      llm(PLANNER_SYS, 'BRIEF: ' + brief, 4000, { web: false }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`planner timeout after ${PLAN_TIMEOUT_MS}ms`)), PLAN_TIMEOUT_MS)),
    ]);
  } catch { return null; }
  if (!raw.trim()) return null;
  const txt = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}'); if (s < 0 || e <= s) return null;
  let parsed: any; try { parsed = JSON.parse(txt.slice(s, e + 1)); } catch { return null; }
  try { return validate(parsed, brief); } catch { return null; }
}

// pure plan (NO database) — the LLM planner with the template fallback, both through validate(). Reused by
// plan() and by the eval harness (src/eval.ts) so the harness measures the REAL planning path DB-free.
export async function buildPlan(brief: string): Promise<{ plan: Plan; usedLLM: boolean }> {
  const llmResult = await llmPlan(brief);
  return { plan: llmResult || validate({ tasks: FB_THINKING, pages: FB_PAGES }, brief)!, usedLLM: !!llmResult };
}

// persistPlan: write a pre-built plan to the DB and return the new project ID.
// Separated from buildPlan so the server can: (1) build the plan, (2) quote the cost,
// (3) debit the user, and THEN (4) persist — without calling the LLM twice.
// Returns the project ID and the final task count (used to cross-check billing).
export async function persistPlan(
  pool: pg.Pool,
  brief: string,
  built: { plan: Plan; usedLLM: boolean },
): Promise<{ projectId: string; taskCount: number }> {
  const { plan: result, usedLLM } = built;
  const { tasks, pages, theme, archetype, shape } = result;
  // ONE CMS, forced in code — never selected, never rotated, never named by an LLM.
  const cms = 'directus';
  const layout = chooseLayout(theme, archetype, brief);
  const scope = evaluateScope(brief, archetype);
  const params = { planner: usedLLM ? 'llm' : 'template', pages, theme, archetype, shape, layout, cms, scope, locale: detectLocale(brief), localBusiness: isLocalBusiness(brief) };

  const p = await pool.query('insert into projects(brief, params) values ($1,$2) returning id', [brief, params]);
  const projectId: string = p.rows[0].id;
  await writeDag(pool, projectId, tasks);
  await pool.query("insert into run_events(project_id, type, detail) values ($1,'planned',$2)", [projectId, `${tasks.length} tasks · ${pages.length} pages · ${archetype}${shape === 'landing' ? ' · LANDING' : ''} · ${theme} · cms:${cms} · ${usedLLM ? 'LLM planner' : 'template'}`]);
  await pool.query("insert into run_events(project_id, type, detail) values ($1,'scoped',$2)", [projectId, `D${scope.difficulty} · includes: ${scope.includes.map(i => i.name).join(', ')} · not included: ${scope.excludes.map(e => e.ask).join(', ')}`.slice(0, 400)]);
  for (const n of (result.notes || [])) await pool.query("insert into run_events(project_id, type, detail) values ($1,'plan_repair',$2)", [projectId, n]).catch(() => {});
  return { projectId, taskCount: tasks.length };
}

export async function plan(pool: pg.Pool, brief: string): Promise<string> {
  // Thin wrapper kept for backwards compatibility (eval harness, tests that call plan() directly).
  const built = await buildPlan(brief);
  const { projectId } = await persistPlan(pool, brief, built);
  return projectId;
}

// M3 — REBUILD IN PLACE: replan the SAME project with an updated brief. The brand identity and the
// theme survive (same business, updated site); the app schema survives via appdb's migration
// (provision migrates instead of skipping). The old task DAG is replaced; params derived from the
// old build (site/schema_forms/cms_built) are dropped and recomputed by the new run.
export async function replan(pool: pg.Pool, projectId: string, brief: string): Promise<void> {
  const prev = (await pool.query('select params from projects where id=$1', [projectId])).rows[0]?.params || {};
  const { plan: result, usedLLM } = await buildPlan(brief);
  const { tasks, pages, theme, archetype, shape } = result;
  const scope = evaluateScope(brief, archetype);
  const params: any = {
    planner: usedLLM ? 'llm' : 'template', pages, archetype, shape, cms: 'directus',
    theme: prev.theme || theme, brand: prev.brand,           // identity continuity across rebuilds
    slug: prev.slug,                                         // the SUBDOMAIN is identity too — a rebuild may never move the site
    layout: prev.layout || chooseLayout(prev.theme || theme, archetype, brief),  // keep the site's structure across rebuilds
    rebuilds: Number(prev.rebuilds || 0) + 1, scope, locale: detectLocale(brief), localBusiness: isLocalBusiness(brief),
  };
  await pool.query('delete from tasks where project_id=$1', [projectId]);
  await pool.query("update projects set brief=$2, status='running', params=$3::jsonb where id=$1", [projectId, brief, JSON.stringify(params)]);
  await writeDag(pool, projectId, tasks);
  await pool.query("insert into run_events(project_id, type, detail) values ($1,'replanned',$2)", [projectId, `rebuild #${params.rebuilds} · ${tasks.length} tasks · ${pages.length} pages · ${archetype}${shape === 'landing' ? ' · LANDING' : ''} · data preserved via migration`]);
  await pool.query("insert into run_events(project_id, type, detail) values ($1,'scoped',$2)", [projectId, `D${scope.difficulty} · includes: ${scope.includes.map(i => i.name).join(', ')} · not included: ${scope.excludes.map(e => e.ask).join(', ')}`.slice(0, 400)]);
  for (const n of (result.notes || [])) await pool.query("insert into run_events(project_id, type, detail) values ($1,'plan_repair',$2)", [projectId, n]).catch(() => {});
}

async function writeDag(pool: pg.Pool, projectId: string, tasks: Task[]): Promise<void> {
  const seqToId: Record<number, string> = {};
  for (const t of tasks) {
    const r = await pool.query('insert into tasks(project_id, seq, title, department, verify, artifact) values ($1,$2,$3,$4,$5,$6) returning id',
      [projectId, t.seq, t.title, t.department, t.verify, t.artifact]);
    seqToId[t.seq] = r.rows[0].id;
  }
  for (const t of tasks) for (const d of t.depends_on)
    if (seqToId[d]) await pool.query('insert into task_dependencies(upstream_id, downstream_id) values ($1,$2) on conflict do nothing', [seqToId[d], seqToId[t.seq]]);
  await pool.query(`update tasks set status='ready' where project_id=$1 and status='blocked' and not exists (select 1 from task_dependencies d where d.downstream_id = tasks.id)`, [projectId]);
}

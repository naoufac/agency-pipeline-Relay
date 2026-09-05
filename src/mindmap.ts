// Project mind map — a VIEW of the project database, not a diagram that goes stale.
// Pure: no I/O. Callers pass rows from projects / tasks / run_events.
export type MindmapTask = {
  seq: number;
  title: string;
  department: string;
  status: string;
  verify?: string;
  artifact?: string | null;
  attempts?: number;
};

export type MindmapEvent = {
  type: string;
  detail?: string | null;
  at?: string | Date | null;
  task_id?: string | null;
};

export type MindmapInput = {
  project: {
    id: string;
    brief?: string;
    status: string;
    params?: any;
    created_at?: string | Date;
  };
  tasks: MindmapTask[];
  events?: MindmapEvent[];
};

export type MindmapNode = {
  id: string;
  label: string;
  department?: string;
  status: string;
  why?: string;
  evidence?: string;
  children?: MindmapNode[];
};

export type MindmapView = {
  source: 'database';
  projectId: string;
  status: string;
  deliverable: string | null;
  builder: string | null;
  contract: any;
  chainReason: string | null;
  capabilities: string[];
  nextAction: { seq: number; title: string; department: string; status: string; why: string } | null;
  remaining: { seq: number; title: string; department: string; status: string }[];
  blockers: { seq: number; title: string; detail: string }[];
  evidence: { type: string; detail: string }[];
  branches: MindmapNode[];
  revisions: any[];
};

const ACTIVE = new Set(['ready', 'running', 'verifying']);
const OPEN = new Set(['blocked', 'ready', 'running', 'verifying', 'failed']);

function whyNext(t: MindmapTask): string {
  if (t.status === 'running' || t.status === 'verifying') return 'in progress — bounded work already claimed';
  if (t.status === 'ready') return 'unblocked — next bounded work';
  if (t.status === 'failed') return `failed after ${t.attempts || 0} attempt(s) — revise this task, do not regenerate unrelated data`;
  return 'queued';
}

function taskEvidence(t: MindmapTask, events: MindmapEvent[]): string | undefined {
  const hit = events.find((e) =>
    /verify_failed|agent_error|cms_built|cms_build_failed|orchestrated|ops_job|astro/.test(String(e.type || '')) &&
    String(e.detail || '').includes(`#${t.seq}`));
  if (hit) return `${hit.type}: ${String(hit.detail || '').slice(0, 160)}`;
  if (t.status === 'done') return `verified (${t.verify || 'done'})`;
  return undefined;
}

export function buildMindmap(input: MindmapInput): MindmapView {
  const proj = input.project;
  const params = (proj.params && typeof proj.params === 'object') ? proj.params : {};
  const tasks = [...(input.tasks || [])].sort((a, b) => a.seq - b.seq);
  const events = input.events || [];

  const next = tasks.find((t) => ACTIVE.has(t.status)) || tasks.find((t) => t.status === 'failed') || null;
  const remaining = tasks.filter((t) => OPEN.has(t.status)).map((t) => ({
    seq: t.seq, title: t.title, department: t.department, status: t.status,
  }));
  const blockers = tasks.filter((t) => t.status === 'failed').map((t) => ({
    seq: t.seq,
    title: t.title,
    detail: whyNext(t),
  }));

  const evidence = events
    .filter((e) => /orchestrated|planned|verify_failed|cms_built|cms_build_failed|project_stuck|ops_job|astro_built|scoped|design_revision|replanned/.test(String(e.type || '')))
    .slice(0, 12)
    .map((e) => ({ type: String(e.type), detail: String(e.detail || '').slice(0, 240) }));

  const deliverable = params.deliverable ?? null;
  const byDept = new Map<string, MindmapTask[]>();
  for (const t of tasks) {
    const k = t.department || 'other';
    if (!byDept.has(k)) byDept.set(k, []);
    byDept.get(k)!.push(t);
  }

  const branches: MindmapNode[] = [];
  const understandKids = ['strategy', 'research'].flatMap((d) =>
    (byDept.get(d) || []).map((t) => ({
      id: `t-${t.seq}`,
      label: t.title,
      department: t.department,
      status: t.status,
      why: t.status === 'done' ? undefined : whyNext(t),
      evidence: taskEvidence(t, events),
    })));
  if (understandKids.length) {
    branches.push({
      id: 'understand',
      label: 'Project understanding',
      status: understandKids.every((c) => c.status === 'done') ? 'done' : 'open',
      children: understandKids,
    });
  }

  const decideKids: MindmapNode[] = [];
  if (deliverable) decideKids.push({ id: 'deliverable', label: `Deliverable: ${deliverable}`, status: 'done', evidence: params.chainReason });
  if (params.contract?.reasons?.length) {
    decideKids.push({
      id: 'contract',
      label: `Contract: ${params.contract.reasons.join('; ')}`,
      status: 'done',
    });
  }
  if (Array.isArray(params.capabilities) && params.capabilities.length) {
    decideKids.push({
      id: 'caps',
      label: `Capabilities: ${params.capabilities.join(', ')}`,
      status: 'done',
    });
  }
  if (decideKids.length) {
    branches.push({ id: 'decide', label: 'Decision engine', status: 'done', children: decideKids });
  }

  const execDepts = ['branding', 'design', 'content', 'compose', 'render', 'database', 'policies', 'integrations', 'integration', 'wp_provision', 'app_api', 'qa'];
  const execKids = execDepts.flatMap((d) =>
    (byDept.get(d) || []).map((t) => ({
      id: `t-${t.seq}`,
      label: t.title,
      department: t.department,
      status: t.status,
      why: t.status === 'done' ? undefined : whyNext(t),
      evidence: taskEvidence(t, events),
      children: undefined as MindmapNode[] | undefined,
    })));
  if (execKids.length) {
    branches.push({
      id: 'execute',
      label: 'Durable execution',
      status: execKids.every((c) => c.status === 'done') ? 'done' : 'open',
      children: execKids,
    });
  }

  return {
    source: 'database',
    projectId: proj.id,
    status: proj.status,
    deliverable,
    builder: params.builder ?? null,
    contract: params.contract ?? null,
    chainReason: params.chainReason ?? null,
    capabilities: Array.isArray(params.capabilities) ? params.capabilities : [],
    nextAction: next ? { seq: next.seq, title: next.title, department: next.department, status: next.status, why: whyNext(next) } : null,
    remaining,
    blockers,
    evidence,
    branches,
    revisions: Array.isArray(params.revisions) ? params.revisions : [],
  };
}

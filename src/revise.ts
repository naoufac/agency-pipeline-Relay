// Adaptive revision — rejected design gets a new revision.
// Customer data is never regenerated. Rejected layout is not blindly kept.
export const VISUAL_CHAIN = ['design', 'content', 'compose', 'render', 'qa'] as const;
export const DATA_DEPTS = ['database', 'policies', 'integrations', 'integration', 'wp_provision', 'app_api'] as const;

export type RevTask = { seq: number; title: string; department: string; status: string };

export type RevisionPlan = {
  kind: 'design' | 'data' | 'task';
  reopen: string[];
  preserve: string[];
  clearLayout: boolean;
  clearSite: boolean;
  reason: string;
};

function uniq(xs: string[]): string[] {
  const out: string[] = [];
  for (const x of xs) if (!out.includes(x)) out.push(x);
  return out;
}

export function revisionFor(failed: RevTask[], all: RevTask[] = failed): RevisionPlan {
  const failedDepts = uniq(failed.map((t) => t.department));
  const visualFailed = failedDepts.filter((d) => (VISUAL_CHAIN as readonly string[]).includes(d));
  const dataFailed = failedDepts.filter((d) => (DATA_DEPTS as readonly string[]).includes(d));
  const doneData = uniq(all.filter((t) => (DATA_DEPTS as readonly string[]).includes(t.department) && t.status === 'done').map((t) => t.department));

  if (visualFailed.length) {
    const start = (visualFailed.includes('qa') || visualFailed.includes('design'))
      ? 'design'
      : visualFailed.includes('content')
        ? 'content'
        : visualFailed.includes('compose')
          ? 'compose'
          : visualFailed.includes('render')
            ? 'render'
            : visualFailed[0];
    // Design/QA rejection reopens design + projections. Content copy stays unless it failed.
    const reopen = start === 'design'
      ? ['design', 'compose', 'render', 'qa']
      : (VISUAL_CHAIN as readonly string[]).slice((VISUAL_CHAIN as readonly string[]).indexOf(start));
    return {
      kind: 'design',
      reopen,
      preserve: uniq(['database', 'policies', 'integrations', 'integration', 'wp_provision', 'app_api', 'branding', 'strategy', 'research', 'content', ...doneData]),
      clearLayout: start === 'design',
      clearSite: start === 'design' || start === 'compose' || start === 'content',
      reason: `design revision from ${start} — customer data preserved, rejected layout not kept`,
    };
  }

  if (dataFailed.length) {
    return {
      kind: 'data',
      reopen: dataFailed,
      preserve: ['design', 'content', 'compose', 'render', 'qa', 'branding', 'strategy', 'research'],
      clearLayout: false,
      clearSite: false,
      reason: 'data revision — migrate/preserve rows, do not drop schema, do not touch design',
    };
  }

  return {
    kind: 'task',
    reopen: failedDepts,
    preserve: uniq(all.filter((t) => t.status === 'done').map((t) => t.department)),
    clearLayout: false,
    clearSite: false,
    reason: `retry failed task(s): ${failedDepts.join(', ')}`,
  };
}

export function shouldTouch(dept: string, plan: RevisionPlan): boolean {
  if (plan.preserve.includes(dept) && !plan.reopen.includes(dept)) return false;
  return plan.reopen.includes(dept);
}

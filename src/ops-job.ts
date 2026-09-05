// Pure ops-job contract. No website, no CMS, no hero.
// A job is trigger + transform + receipt. proveOpsJob dry-runs a sample and
// is idempotent on a key. verify.ts persists the proof; this file stays DB-free.

export type OpsJob = {
  trigger: { kind: 'cron' | 'webhook' | 'manual'; spec: string };
  transform: { kind: string; mapping?: Record<string, string> };
  receipt: { kind: 'email' | 'log' | 'file'; spec: string };
  source?: { kind: string; spec?: string };
  destination?: { kind: string; spec?: string };
  idempotency_key?: string;
  sample?: Record<string, unknown>[];
};

function firstJson(s: string): any {
  const t = String(s || '').replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  for (const open of ['{', '['] as const) {
    const start = t.indexOf(open); if (start < 0) continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === open) depth++;
      else if (t[i] === close) { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { break; } } }
    }
  }
  return undefined;
}

export function proveOpsJob(content: string): { ok: boolean; log: string; job?: OpsJob; preview?: Record<string, unknown>[] } {
  const obj = firstJson(content);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, log: 'ops_job: not a JSON object' };
  if (obj.pages || obj.sections || obj.hero || obj.brand || obj.cms || obj.palette) {
    return { ok: false, log: 'ops_job: website-shaped payload rejected (no hero, no CMS, no brand)' };
  }
  for (const k of ['trigger', 'transform', 'receipt'] as const) {
    if (!(k in obj)) return { ok: false, log: `ops_job: missing ${k}` };
  }
  const trigger = obj.trigger;
  if (!trigger || typeof trigger !== 'object' || !trigger.kind || !trigger.spec) {
    return { ok: false, log: 'ops_job: trigger needs kind+spec' };
  }
  if (!['cron', 'webhook', 'manual'].includes(String(trigger.kind))) {
    return { ok: false, log: `ops_job: unknown trigger kind ${trigger.kind}` };
  }
  const transform = obj.transform;
  if (!transform || typeof transform !== 'object' || !transform.kind) {
    return { ok: false, log: 'ops_job: transform needs kind' };
  }
  const receipt = obj.receipt;
  if (!receipt || typeof receipt !== 'object' || !receipt.kind || !receipt.spec) {
    return { ok: false, log: 'ops_job: receipt needs kind+spec' };
  }
  if (!['email', 'log', 'file'].includes(String(receipt.kind))) {
    return { ok: false, log: `ops_job: unknown receipt kind ${receipt.kind}` };
  }

  const sample: Record<string, unknown>[] = Array.isArray(obj.sample) && obj.sample.length
    ? obj.sample
    : [
        { sku: 'A1', qty: '2', name: 'Widget' },
        { sku: 'A1', qty: '3', name: 'Widget' },
        { sku: 'B2', qty: '1', name: 'Gadget' },
      ];
  const keyField = String(obj.idempotency_key || 'sku');
  const mapping = (transform.mapping && typeof transform.mapping === 'object') ? transform.mapping as Record<string, string> : {};
  const seen = new Set<string>();
  const preview: Record<string, unknown>[] = [];
  for (const row of sample) {
    if (!row || typeof row !== 'object') continue;
    const key = String((row as any)[keyField] ?? '');
    if (!key) return { ok: false, log: `ops_job: sample row missing idempotency key "${keyField}"` };
    if (seen.has(key)) continue;
    seen.add(key);
    const out: Record<string, unknown> = {};
    if (Object.keys(mapping).length) {
      for (const [from, to] of Object.entries(mapping)) out[String(to)] = (row as any)[from];
    } else {
      Object.assign(out, row);
    }
    preview.push(out);
  }
  if (preview.length < 1) return { ok: false, log: 'ops_job: transform produced 0 rows' };
  const skipped = sample.length - preview.length;
  return {
    ok: true,
    log: `ops_job: ${trigger.kind} → ${preview.length} row(s) dry-run, ${skipped} duplicate(s) skipped (key ${keyField})`,
    job: obj as OpsJob,
    preview,
  };
}

// alert.ts — M5: the agency talks back when it's STUCK. A build that spends its whole self-repair
// budget emits 'project_stuck'; today that waited silently on the dashboard. Now it pings the
// operator on Telegram (same bot the uptime monitor uses — TG_TOKEN/TG_CHAT_ID), exactly ONCE per
// project (deduped via an 'operator_alerted' run_event, so a recovery loop can't spam).
import pg from 'pg';

export function alertReady(): boolean { return !!(process.env.TG_TOKEN && process.env.TG_CHAT_ID); }

export async function telegramAlert(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!alertReady()) return { ok: false, error: 'TG_TOKEN/TG_CHAT_ID not configured' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TG_CHAT_ID, text: text.slice(0, 3800) }),
    });
    const j: any = await r.json().catch(() => null);
    return j?.ok ? { ok: true } : { ok: false, error: JSON.stringify(j).slice(0, 200) };
  } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
}

// Once per project: alert → record. Returns what happened so the gate can assert it.
export async function alertStuck(pool: pg.Pool, projectId: string, detail: string): Promise<'sent' | 'deduped' | 'failed' | 'unconfigured'> {
  if (!alertReady()) return 'unconfigured';
  const prior = (await pool.query("select 1 from run_events where project_id=$1 and type='operator_alerted' limit 1", [projectId])).rows[0];
  if (prior) return 'deduped';
  const brief = (await pool.query('select brief from projects where id=$1', [projectId])).rows[0]?.brief || '';
  const r = await telegramAlert(`🛑 Relay build STUCK — needs a look\n\n"${String(brief).slice(0, 120)}"\n${detail}\n\nhttps://board.naples.agency/#/p/${projectId}/build`);
  await pool.query("insert into run_events(project_id, type, detail) values ($1,'operator_alerted',$2)",
    [projectId, r.ok ? 'telegram alert sent' : `telegram alert FAILED: ${r.error}`]).catch(() => {});
  return r.ok ? 'sent' : 'failed';
}

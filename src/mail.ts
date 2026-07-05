// mail.ts — production email over the naples.agency SMTP (SPF + DKIM + DMARC aligned, MX on the
// same host). USED, not parked: the server fires a lead notification to the operator on every
// produced-site submission (M5 pulls transactional email for accounts on top of this).
// Every send is recorded as a run_event (type 'mail_sent' / 'mail_failed') — externally checkable.
import pg from 'pg';
import nodemailer from 'nodemailer';
import { ev } from './db.ts';

let tx: nodemailer.Transporter | null = null;

export function mailReady(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function transporter(): nodemailer.Transporter | null {
  if (!mailReady()) return null;
  if (!tx) tx = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return tx;
}

export async function sendMail(pool: pg.Pool | null, projectId: string | null, to: string, subject: string, text: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const t = transporter();
  if (!t) return { ok: false, error: 'SMTP not configured' };
  try {
    const info = await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    if (pool) await ev(pool, projectId, null, 'mail_sent', `${to} · ${subject} · ${info.messageId}`).catch(() => {});
    return { ok: true, id: info.messageId };
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 200);
    if (pool) await ev(pool, projectId, null, 'mail_failed', `${to} · ${subject} · ${error}`).catch(() => {});
    return { ok: false, error };
  }
}

// Lead notification — a produced site's form was submitted; the operator hears about it in minutes,
// not when they next open a dashboard. Fire-and-forget from the submission handlers.
// Returns whether a mail was queued (false for QA probes) so the gate can assert the guard.
// Both alternatives are START-ANCHORED: the interaction reviewer writes the marker as the ENTIRE
// field value (textarea → "Automated QA check — please ignore.", text → "QA Test 0"), so anchoring
// is exact for probes yet a REAL customer whose note merely CONTAINS the phrase keeps their mail.
const QA_MARKER = /^(Automated QA check — please ignore|QA Test \d)/;
// the interaction reviewer's test submissions must never generate REAL email — not leads,
// not visitor confirmations (they'd spam qa@example.com on every single build)
export const isQaProbe = (data: Record<string, any>): boolean =>
  Object.values(data || {}).some((v) => QA_MARKER.test(String(v)));
export function notifyLead(pool: pg.Pool, projectId: string, brief: string, form: string, data: Record<string, any>, actions?: { confirm: string; decline: string } | null): boolean {
  const to = process.env.OPERATOR_EMAIL;
  if (!to || !mailReady()) return false;
  // the interaction reviewer submits test rows on every build — those are probes, not leads
  if (isQaProbe(data)) return false;
  const lines = Object.entries(data || {}).slice(0, 12).map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`).join('\n');
  const site = String(brief || '').slice(0, 80);
  // lifecycle tables ride with ONE-TAP action links — confirm/decline without opening the dashboard
  const act = actions ? `\n\n✓ Confirm: ${actions.confirm}\n✗ Decline: ${actions.decline}` : '';
  sendMail(pool, projectId, to, `New lead — ${site}`,
    `A visitor just submitted the "${form}" form on your produced site:\n\n${lines}${act}\n\nProject: https://board.naples.agency/#/p/${projectId}/data\nSite: https://board.naples.agency/sites/${projectId}/`)
    .catch(() => {});
  return true;
}

// alert:check — THE M5 GATE (PLAN.md). Proves the agency talks back:
// (1) a REAL Telegram alert is delivered through the live bot (the operator sees it — the dead-
//     letter path is exercised end-to-end, not simulated),
// (2) the stuck-project alert dedupes (one project can never spam),
// (3) the QA-probe guard: the interaction reviewer's test submissions never send lead email.
// Exit 1 on any failure. Run: npm run alert:check.
import { makePool } from './db.ts';
import { telegramAlert, alertStuck, alertReady } from './alert.ts';
import { notifyLead } from './mail.ts';

const pool = makePool();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };
let projId = '';

try {
  ok('telegram configured (TG_TOKEN/TG_CHAT_ID)', alertReady());

  // (1) real delivery through the live bot
  const r = await telegramAlert('🧪 Relay alert:check — the stuck-build alert path is live. (Automated gate; nothing is stuck.)');
  ok('real telegram alert delivered', r.ok, r.error || '');

  // (2) stuck alert fires once, then dedupes
  projId = (await pool.query("insert into projects(brief, params, status) values('alert-check probe','{}','blocked') returning id")).rows[0].id;
  ok('stuck alert sends for a fresh project', (await alertStuck(pool, projId, '1 task(s) failed — gate probe')) === 'sent');
  ok('second stuck alert deduped', (await alertStuck(pool, projId, 'again')) === 'deduped');
  const recorded = (await pool.query("select count(*)::int n from run_events where project_id=$1 and type='operator_alerted'", [projId])).rows[0].n;
  ok('exactly one operator_alerted event recorded', recorded === 1, String(recorded));

  // (3) QA probes never email leads; real leads do queue
  ok('QA probe (message marker) suppressed', notifyLead(pool, projId, 'x', 'contact', { name: 'QA Test 0', message: 'Automated QA check — please ignore.' }) === false);
  ok('QA probe (name marker) suppressed', notifyLead(pool, projId, 'x', 'orders', { customer: 'QA Test 3' }) === false);
  ok('a real lead still queues mail', notifyLead(pool, projId, 'alert-check probe', 'contact', { name: 'Real Person', message: 'I want a quote' }) === true);
  await new Promise((r2) => setTimeout(r2, 3000));   // let the fire-and-forget send record its event
  const mailed = (await pool.query("select count(*)::int n from run_events where project_id=$1 and type='mail_sent'", [projId])).rows[0].n;
  ok('the real lead produced a mail_sent record', mailed === 1, String(mailed));
} catch (e: any) {
  fail++; console.error('  ✗ threw:', e?.message ?? e);
} finally {
  if (projId) await pool.query('delete from projects where id=$1', [projId]).catch(() => {});
}
console.log(`\nalert:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

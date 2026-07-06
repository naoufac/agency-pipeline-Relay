// Terminal KPI report (same numbers as /api/kpi). Usage: npm run kpi -- [projectId]
import { makePool } from './db.ts';
import { computeKpi } from './kpi.ts';

const pool = makePool();
const k = await computeKpi(pool, process.argv[2]);
if (!k) { console.log('no project'); process.exit(0); }
console.log(`\n══ RELAY · KPI ══  ${k.project.brief}`);
console.log(`status: ${k.status} — ${k.totals.done}/${k.totals.total} done, ${k.totals.active} active, ${k.totals.failed} failed\n`);
let g = '';
for (const m of k.kpis) { if (m.group !== g) { g = m.group; console.log(`── ${g} ──`); } console.log(`  ${m.label.padEnd(20)} ${String(m.value).padStart(7)}   ${m.sub}`); }

// ARC E Part 2: FUNNEL block — operator-level demand metrics, QA noise filtered out.
if (k.funnel) {
  const f = k.funnel;
  console.log('\n── FUNNEL (QA noise excluded) ──');
  console.log(`  ${'Users'.padEnd(20)} ${String(f.users_real).padStart(7)}   (${f.users_total} total, non-QA only)`);
  console.log(`  ${'Leads'.padEnd(20)} ${String(f.leads_real).padStart(7)}   (${f.leads_total} total submissions, non-QA only)`);
  console.log(`  ${'Projects'.padEnd(20)} ${String(f.projects_total).padStart(7)}   all builds ever started`);
  console.log(`  ${'Credits granted'.padEnd(20)} ${('$' + (f.credits_granted_cents / 100).toFixed(2)).padStart(7)}`);
  console.log(`  ${'Credits spent'.padEnd(20)} ${('$' + (f.credits_spent_cents / 100).toFixed(2)).padStart(7)}   ${f.active_paying_users} paying user(s)`);
}

console.log('');
await pool.end();

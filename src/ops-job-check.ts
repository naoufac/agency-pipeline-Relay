// ops:check — automation is a real job, not a website wearing JSON.
import { proveOpsJob } from './ops-job.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const good = JSON.stringify({
  trigger: { kind: 'cron', spec: '0 7 * * *' },
  source: { kind: 'csv', spec: 'supplier.csv' },
  transform: { kind: 'map_columns', mapping: { sku: 'sku', qty: 'quantity' } },
  destination: { kind: 'table', spec: 'inventory' },
  receipt: { kind: 'email', spec: 'ops@example.com' },
  idempotency_key: 'sku',
  sample: [
    { sku: 'A1', qty: '2' },
    { sku: 'A1', qty: '9' },
    { sku: 'B2', qty: '1' },
  ],
});
const r = proveOpsJob(good);
ok('valid CSV job dry-runs', r.ok === true, r.log);
ok('idempotent: duplicate sku skipped', (r.preview || []).length === 2, String((r.preview || []).length));
ok('mapping applied', r.preview?.[0]?.quantity === '2' && r.preview?.[0]?.sku === 'A1', JSON.stringify(r.preview?.[0]));

ok('website payload is rejected', proveOpsJob(JSON.stringify({
  trigger: { kind: 'cron', spec: '0 7 * * *' },
  transform: { kind: 'map_columns' },
  receipt: { kind: 'email', spec: 'x@y.z' },
  hero: 'Welcome',
  pages: [{ slug: 'index' }],
})).ok === false);

ok('missing trigger fails', proveOpsJob(JSON.stringify({
  transform: { kind: 'map_columns' },
  receipt: { kind: 'email', spec: 'x@y.z' },
})).ok === false);

ok('prose is not a job', proveOpsJob('Integration: payments + maps wired.').ok === false);

ok('unknown trigger kind fails', proveOpsJob(JSON.stringify({
  trigger: { kind: 'whenever', spec: 'soon' },
  transform: { kind: 'map_columns' },
  receipt: { kind: 'email', spec: 'x@y.z' },
})).ok === false);

console.log(`\nops:check — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

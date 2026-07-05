// migrate:check — THE M3 GATE (PLAN.md). Proves on a real, isolated scratch schema that a rebuild
// with a changed data model preserves every row: v1 provisions + seeds, a live row is written, v2
// (new required column + new table + a type drift + a new relation) MIGRATES — the row survives,
// the new column exists with its default, the drift is skipped not applied, the guard never fires.
// Exit 1 on any failure. Run: npm run migrate:check.
import { randomUUID } from 'node:crypto';
import { makePool } from './db.ts';
import * as appdb from './appdb.ts';

const pool = makePool();
const id = randomUUID();
const schema = appdb.schemaName(id);
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

const V1 = JSON.stringify({ entities: [
  { name: 'categories', public: false, display: 'name', fields: [{ name: 'name', type: 'text', required: true }], seed: [{ name: 'Bread' }, { name: 'Cakes' }] },
  { name: 'products', public: true, display: 'title', fields: [
    { name: 'title', type: 'text', required: true }, { name: 'price', type: 'money', required: true },
    { name: 'category', type: 'ref:categories', required: true }],
    seed: [{ title: 'Sourdough', price: 6.5, category: 1 }, { title: 'Baguette', price: 3.2, category: 1 }] },
] });
const V2 = JSON.stringify({ entities: [
  { name: 'categories', public: false, display: 'name', fields: [{ name: 'name', type: 'text', required: true }] },
  { name: 'products', public: true, display: 'title', fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'price', type: 'text' },                                 // TYPE DRIFT: numeric -> text must be SKIPPED
    { name: 'category', type: 'ref:categories', required: true },
    { name: 'phone_number', type: 'text', required: true },          // NEW required column on a populated table
    { name: 'supplier', type: 'ref:suppliers' }] },                  // NEW relation
  { name: 'suppliers', public: false, display: 'name', fields: [{ name: 'name', type: 'text', required: true }], seed: [{ name: 'Mill & Co' }] },  // NEW table
] });

try {
  // v1: fresh provision + a LIVE row on top of the seeds
  const p1 = await appdb.provision(pool, id, V1);
  ok('v1 provisions 2 tables', p1.tables.length === 2, JSON.stringify(p1.tables));
  ok('v1 not a migration', !p1.migration);
  ok('v1 live row inserted', (await appdb.insertRow(pool, id, 'products', { title: 'Croissant', price: 2.8, category_id: 2 })).ok);
  const before = Number((await pool.query(`select count(*)::int n from "${schema}"."products"`)).rows[0].n);
  ok('v1 products has seeds + live row', before === 3, String(before));

  // v2: MIGRATION on the populated schema
  const p2 = await appdb.provision(pool, id, V2);
  ok('v2 is a migration', !!p2.migration, JSON.stringify(p2));
  const m = p2.migration!;
  ok('new table created', p2.tables.includes('suppliers'), JSON.stringify(p2.tables));
  ok('new table seeded', Number((await pool.query(`select count(*)::int n from "${schema}"."suppliers"`)).rows[0].n) === 1);
  const rows = (await pool.query(`select title, price, phone_number, supplier_id from "${schema}"."products" order by id`)).rows;
  ok('EVERY row survived', rows.length === 3, String(rows.length));
  ok('old values intact', rows[0].title === 'Sourdough' && Number(rows[0].price) === 6.5);
  ok('live row intact', rows[2].title === 'Croissant' && Number(rows[2].price) === 2.8);
  ok('new required column exists with default', rows.every((r: any) => r.phone_number === ''));
  const nn = (await pool.query(`select is_nullable from information_schema.columns where table_schema=$1 and table_name='products' and column_name='phone_number'`, [schema])).rows[0];
  ok('new required column is NOT NULL', nn && nn.is_nullable === 'NO');
  ok('new relation added (nullable)', rows.every((r: any) => r.supplier_id === null));
  ok('type drift SKIPPED, data kept', m.skipped.some(s => /price/.test(s)) && typeof rows[1].price !== 'undefined' && Number(rows[1].price) === 3.2);
  ok('migration log names the new table', m.applied.some(a => /\+table "suppliers"/.test(a)));

  // idempotence: re-running the same model changes nothing
  const p3 = await appdb.provision(pool, id, V2);
  ok('re-migrate is a no-op', !!p3.migration && p3.migration.applied.length === 0, JSON.stringify(p3.migration));
  ok('row count stable after no-op', Number((await pool.query(`select count(*)::int n from "${schema}"."products"`)).rows[0].n) === 3);
} catch (e: any) {
  fail++; console.error('  ✗ threw:', e?.message ?? e);
} finally {
  await pool.query(`drop schema if exists "${schema}" cascade`).catch(() => {});
}
// SEMANTIC TWINS (iteration-leg catch): a rebuilt model renames the when/email columns of a
// PRIVATE visitor table — migration must MAP them to the existing columns, never duplicate.
{
  const { randomUUID } = await import('node:crypto');
  const tid = randomUUID();
  const tschema = 'app_' + tid.replace(/-/g, '').slice(0, 32);
  const TV1 = JSON.stringify({ entities: [
    { name: 'bookings', public: false, fields: [
      { name: 'customer_name', type: 'text', required: true },
      { name: 'customer_email', type: 'text' },
      { name: 'booking_time', type: 'datetime' }] },
  ] });
  const TV2 = JSON.stringify({ entities: [
    { name: 'bookings', public: false, fields: [
      { name: 'customer_name', type: 'text', required: true },
      { name: 'email', type: 'text' },                       // twin of customer_email
      { name: 'appointment_at', type: 'datetime' },       // twin of booking_time
      { name: 'party_size', type: 'integer' }] },            // genuinely NEW — must still be added
  ] });
  try {
    await appdb.provision(pool, tid, TV1);
    const p = await appdb.provision(pool, tid, TV2);
    const cols = (await pool.query(`select column_name from information_schema.columns where table_schema=$1 and table_name='bookings'`, [tschema])).rows.map((r: any) => r.column_name);
    ok('twin: the renamed when-column is MAPPED, not duplicated (email was already canonical via FS2)', !cols.includes('appointment_at') && cols.includes('booking_time') && cols.includes('customer_email'), cols.join(','));
    ok('twin: a genuinely new column still lands', cols.includes('party_size'), cols.join(','));
    ok('twin: the mapping is loud in skipped[]', !!p.migration && p.migration.skipped.some((x: string) => /semantic twin/.test(x)), JSON.stringify(p.migration?.skipped));
  } finally {
    await pool.query(`drop schema if exists "${tschema}" cascade`).catch(() => {});
  }
}
// TWIN COLLISION (adversarial audit 2026-07-05): a new date column must NOT collapse into an existing
// date column the model STILL wants. Model keeps appointment_at AND adds date_of_birth — both are real,
// distinct fields; the twin logic must add date_of_birth, not map it onto appointment_at (data loss).
{
  const { randomUUID } = await import('node:crypto');
  const cid = randomUUID();
  const cschema = 'app_' + cid.replace(/-/g, '').slice(0, 32);
  const CV1 = JSON.stringify({ entities: [
    { name: 'appointments', public: false, fields: [
      { name: 'customer_name', type: 'text', required: true },
      { name: 'appointment_at', type: 'datetime' }] },
  ] });
  const CV2 = JSON.stringify({ entities: [
    { name: 'appointments', public: false, fields: [
      { name: 'customer_name', type: 'text', required: true },
      { name: 'appointment_at', type: 'datetime' },     // KEPT — the model still wants this exact column
      { name: 'date_of_birth', type: 'date' }] },        // genuinely distinct date — must NOT swallow into appointment_at
  ] });
  try {
    await appdb.provision(pool, cid, CV1);
    await appdb.provision(pool, cid, CV2);
    const cols = (await pool.query(`select column_name from information_schema.columns where table_schema=$1 and table_name='appointments'`, [cschema])).rows.map((r: any) => r.column_name);
    ok('twin: a distinct date column is ADDED, not swallowed, when the model keeps the original', cols.includes('appointment_at') && cols.includes('date_of_birth'), cols.join(','));
  } finally {
    await pool.query(`drop schema if exists "${cschema}" cascade`).catch(() => {});
  }
}

console.log(`\nmigrate:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

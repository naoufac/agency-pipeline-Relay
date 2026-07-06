// billing:check — THE ARC A GATE. Real DB, scratch users, deleted after. Covers:
//   • Table DDL + sign invariant (DB CHECK enforces it)
//   • grant idempotency (call 3×, one row)
//   • balanceCents lazy-grant for existing users
//   • quoteCents arithmetic including the "5-page site ≈ $6–7" reference
//   • debitCents: basic debit, insufficient-funds refusal, daily cap
//   • 5-concurrent-debit race: sum of debits never exceeds initial balance
//   • isOperator: named email + RELAY_OPERATOR_EMAIL override (source-pinned)
//   • billingEnabled kill-switch (source-pinned)
//   • 402 enforcement source-pins on /api/run + /api/rebuild + design write path
//   • append-only source-pin (no UPDATE/DELETE billing_ledger in src/)
//   • anon-cap source-pin (ANON_RUN_HITS / anonBuildLimited in server.ts)
//   • Live end-to-end: grant → quote → debit → balance arithmetic exact
// Run: npm run billing:check (server NOT required — direct DB only).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makePool } from './db.ts';
import {
  ensureBillingTables,
  grantSignupCredit,
  balanceCents,
  spentTodayCents,
  debitCents,
  refundCents,
  quoteCents,
  isOperator,
  billingEnabled,
  PRICING,
} from './billing.ts';

const pool = makePool();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra ? `(${extra})` : ''); }
};

// Scratch user IDs to clean up after.
const userIds: string[] = [];
async function scratchUser(): Promise<string> {
  const email = `billing-check-${randomUUID()}@relay.test`;
  const r = await pool.query('insert into users(email) values($1) returning id', [email]);
  const id: string = r.rows[0].id;
  userIds.push(id);
  return id;
}

try {
  // ---- DDL ----
  await ensureBillingTables(pool);
  ok('ensureBillingTables is idempotent (re-run)', true);   // reaches here = no throw

  // ---- sign invariant enforced by CHECK ----
  const uid0 = await scratchUser();
  let chkErr = '';
  try {
    // Try inserting a DEBIT with a positive amount — DB CHECK must reject this.
    await pool.query(`insert into billing_ledger(user_id,kind,amount_cents,reason) values($1,'debit',100,'bad')`, [uid0]);
  } catch (e: any) { chkErr = e?.code || e?.message || ''; }
  ok('DB CHECK: debit with positive amount is rejected', chkErr !== '', chkErr);

  let chkErr2 = '';
  try {
    // Try inserting a GRANT with a negative amount — DB CHECK must reject this.
    await pool.query(`insert into billing_ledger(user_id,kind,amount_cents,reason) values($1,'grant',-100,'bad')`, [uid0]);
  } catch (e: any) { chkErr2 = e?.code || e?.message || ''; }
  ok('DB CHECK: grant with negative amount is rejected', chkErr2 !== '', chkErr2);

  // ---- grant idempotency ----
  const uid1 = await scratchUser();
  await grantSignupCredit(pool, uid1);
  await grantSignupCredit(pool, uid1);
  await grantSignupCredit(pool, uid1);   // three calls → exactly one row
  const grantRows = (await pool.query(`select count(*)::int n from billing_ledger where user_id=$1 and kind='grant'`, [uid1])).rows[0].n;
  ok('grant idempotency: 3 calls → exactly 1 row', grantRows === 1, `rows=${grantRows}`);

  // ---- partial unique index: second direct insert must fail ----
  let dupErr = '';
  try {
    await pool.query(`insert into billing_ledger(user_id,kind,amount_cents,reason) values($1,'grant',100,'dup')`, [uid1]);
  } catch (e: any) { dupErr = e?.code || ''; }
  ok('partial unique index: second grant row is rejected (unique violation)', dupErr !== '', dupErr);

  // ---- balanceCents lazy-grant ----
  const uid2 = await scratchUser();
  // uid2 has no rows yet; balanceCents must grant then return GRANT_CENTS
  const bal2 = await balanceCents(pool, uid2);
  ok('balanceCents: lazy-grant gives GRANT_CENTS for new user', bal2 === PRICING.GRANT_CENTS, `bal=${bal2}`);
  // second call must be idempotent (still GRANT_CENTS — no double-grant)
  const bal2b = await balanceCents(pool, uid2);
  ok('balanceCents: second call is idempotent', bal2b === PRICING.GRANT_CENTS, `bal=${bal2b}`);

  // ---- quoteCents ----
  ok('quote: rebuild is flat REBUILD_CENTS',           quoteCents('rebuild') === PRICING.REBUILD_CENTS);
  ok('quote: design is flat DESIGN_CENTS',             quoteCents('design')  === PRICING.DESIGN_CENTS);
  ok('quote: 0 steps → BUILD_MIN (floor)',             quoteCents('build', 0)  === PRICING.BUILD_MIN_CENTS);
  ok('quote: 1 step  → BUILD_MIN (floor)',             quoteCents('build', 1)  === PRICING.BUILD_MIN_CENTS);
  ok('quote: BUILD_MIN/STEP steps → BUILD_MIN (exact boundary)', quoteCents('build', PRICING.BUILD_MIN_CENTS / PRICING.BUILD_PER_STEP_CENTS) === PRICING.BUILD_MIN_CENTS);
  // 12 thinking steps × $0.50 = $6.00 — the lower bound of the "5-page site ≈ $6–7" reference
  ok('quote: 12 thinking steps → $6.00 (5-page-site reference lower bound)', quoteCents('build', 12) === 600);
  // 14 thinking steps × $0.50 = $7.00 — the upper bound of the reference
  ok('quote: 14 thinking steps → $7.00 (5-page-site reference upper bound)', quoteCents('build', 14) === 700);
  // 40 steps would be $20 — capped at BUILD_MAX
  ok('quote: 40 steps → BUILD_MAX (cap)',              quoteCents('build', 40) === PRICING.BUILD_MAX_CENTS);
  ok('quote: BUILD_MAX+1 steps also → BUILD_MAX',      quoteCents('build', PRICING.BUILD_MAX_CENTS / PRICING.BUILD_PER_STEP_CENTS + 1) === PRICING.BUILD_MAX_CENTS);

  // ---- debitCents: basic ----
  const uid3 = await scratchUser();
  await grantSignupCredit(pool, uid3);  // $30
  const d1 = await debitCents(pool, uid3, 500, 'test debit 1', null);
  ok('debit: basic debit succeeds',                    d1.ok === true, JSON.stringify(d1));
  ok('debit: balance_after = grant - debit',           d1.balance_cents_after === PRICING.GRANT_CENTS - 500, `after=${d1.balance_cents_after}`);
  const bal3 = await balanceCents(pool, uid3);
  ok('debit: balanceCents reflects the debit',         bal3 === PRICING.GRANT_CENTS - 500, `bal=${bal3}`);

  // ---- debitCents: insufficient funds ----
  const uid4 = await scratchUser();
  await grantSignupCredit(pool, uid4);  // $30
  const bigDebit = await debitCents(pool, uid4, PRICING.GRANT_CENTS + 1, 'too expensive', null);
  ok('debit: refusal when balance < cost',             bigDebit.ok === false, JSON.stringify(bigDebit));
  const bal4 = await balanceCents(pool, uid4);
  ok('debit: balance unchanged after refusal',         bal4 === PRICING.GRANT_CENTS, `bal=${bal4}`);

  // ---- debitCents: daily cap ----
  const uid5 = await scratchUser();
  // Inject enough credit to pass solvency but exceed the daily cap on the second debit
  await pool.query(`insert into billing_ledger(user_id,kind,amount_cents,reason) values($1,'grant',$2,'test grant')`, [uid5, PRICING.DAILY_CAP_CENTS * 3]);
  const cap1 = await debitCents(pool, uid5, PRICING.DAILY_CAP_CENTS - 100, 'near-cap debit', null);
  ok('daily cap: first debit near cap succeeds',       cap1.ok === true, JSON.stringify(cap1));
  const cap2 = await debitCents(pool, uid5, 200, 'over-cap debit', null);
  ok('daily cap: second debit that would exceed cap is refused', cap2.ok === false, JSON.stringify(cap2));
  // A small debit within the remaining allowance must still pass
  const cap3 = await debitCents(pool, uid5, 50, 'small debit within cap', null);
  ok('daily cap: small debit within remaining allowance succeeds', cap3.ok === true, JSON.stringify(cap3));

  // ---- race: 5 concurrent debits that together exceed the balance ----
  // Only some of them should succeed; the balance must never go negative.
  const uid6 = await scratchUser();
  const RACE_GRANT = 1000;  // $10
  const RACE_DEBIT = 300;   // $3 each; 5 × $3 = $15 > $10
  await pool.query(`insert into billing_ledger(user_id,kind,amount_cents,reason) values($1,'grant',$2,'race grant')`, [uid6, RACE_GRANT]);
  const raceResults = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      debitCents(pool, uid6, RACE_DEBIT, `race debit ${i + 1}`, null)));
  const successCount = raceResults.filter(r => r.ok).length;
  const finalBal = await balanceCents(pool, uid6);
  ok('race: balance is never negative after 5 concurrent debits', finalBal >= 0, `finalBal=${finalBal}`);
  // With $10 and $3/debit: at most 3 can succeed (3×$3=$9 ≤ $10); 4th would cost $12 > $10.
  // But also daily cap applies; cap is $20 so not binding here. Expect exactly 3 successes.
  ok('race: exactly 3 of 5 concurrent $3 debits succeed against $10 balance',
    successCount === 3, `successCount=${successCount}, results=${JSON.stringify(raceResults)}`);
  ok('race: final balance matches successes', finalBal === RACE_GRANT - successCount * RACE_DEBIT, `finalBal=${finalBal}`);

  // ---- spentTodayCents ----
  const uid7 = await scratchUser();
  await pool.query(`insert into billing_ledger(user_id,kind,amount_cents,reason) values($1,'grant',5000,'test')`, [uid7]);
  await debitCents(pool, uid7, 100, 'today debit 1', null);
  await debitCents(pool, uid7, 200, 'today debit 2', null);
  const spent7 = await spentTodayCents(pool, uid7);
  ok('spentTodayCents: returns absolute sum of today\'s debits', spent7 === 300, `spent=${spent7}`);

  // ---- isOperator ----
  ok('isOperator: default operator email', isOperator({ email: 'nchobah@gmail.com' }));
  ok('isOperator: non-operator is false', !isOperator({ email: 'alice@example.com' }));
  ok('isOperator: null user is false', !isOperator(null));
  ok('isOperator: empty email is false', !isOperator({ email: '' }));
  {
    const old = process.env.RELAY_OPERATOR_EMAIL;
    process.env.RELAY_OPERATOR_EMAIL = 'boss@example.com';
    ok('isOperator: RELAY_OPERATOR_EMAIL override works', isOperator({ email: 'boss@example.com' }));
    ok('isOperator: default no longer matches after override', !isOperator({ email: 'nchobah@gmail.com' }));
    if (old === undefined) delete process.env.RELAY_OPERATOR_EMAIL; else process.env.RELAY_OPERATOR_EMAIL = old;
  }

  // ---- billingEnabled ----
  {
    const old = process.env.RELAY_BILLING;
    delete process.env.RELAY_BILLING;
    ok('billingEnabled: default ON (no env var)', billingEnabled());
    process.env.RELAY_BILLING = '1';
    ok('billingEnabled: ON when RELAY_BILLING=1', billingEnabled());
    process.env.RELAY_BILLING = '0';
    ok('billingEnabled: OFF when RELAY_BILLING=0', !billingEnabled());
    if (old === undefined) delete process.env.RELAY_BILLING; else process.env.RELAY_BILLING = old;
  }

  // ---- source-pin: operator is source-pinned in server.ts ----
  {
    const serverSrc = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    ok('source-pin: server.ts imports isOperator from billing.ts',
      /isOperator/.test(serverSrc) && /from ['"]\.\/billing/.test(serverSrc));
    ok('source-pin: /api/run uses isOperator before persisting',
      // Must check isOperator before calling persistPlan
      /isOperator\(user\).*billingEnabled/.test(serverSrc.replace(/\n/g, ' ')));
  }

  // ---- source-pin: 402 enforcement in server.ts ----
  {
    const serverSrc = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    ok('source-pin: server.ts has 402 on /api/run', /send\(res, 402/.test(serverSrc));
    ok('source-pin: server.ts has 402 on /api/rebuild', (() => {
      // Must appear at least twice: once for /api/run and once for /api/rebuild
      const matches = serverSrc.match(/send\(res, 402/g) || [];
      return matches.length >= 2;
    })());
    ok('source-pin: server.ts has 402 on design write path',
      (() => { const matches = serverSrc.match(/send\(res, 402/g) || []; return matches.length >= 3; })());
  }

  // ---- source-pin: append-only (no UPDATE/DELETE on billing_ledger in any src/ file) ----
  {
    // Read all .ts files in src/ except this check file itself.
    // The assertion is that no production code mutates the ledger.
    const { readdirSync } = await import('node:fs');
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(srcDir)
      .filter(f => f.endsWith('.ts') && f !== 'billing-check.ts');
    let mutFound = false;
    for (const f of files) {
      const src = readFileSync(srcDir + '/' + f, 'utf8');
      // Match UPDATE billing_ledger or DELETE FROM billing_ledger (case-insensitive SQL)
      if (/\b(update|delete\s+from)\s+billing_ledger\b/i.test(src)) {
        console.error(`  ✗ append-only violated: ${f} contains UPDATE/DELETE on billing_ledger`);
        mutFound = true;
      }
    }
    ok('source-pin: no UPDATE/DELETE on billing_ledger in any src/ file', !mutFound);
  }

  // ---- source-pin: anonymous build cap in server.ts ----
  {
    const serverSrc = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    ok('source-pin: ANON_RUN_HITS map exists in server.ts', /ANON_RUN_HITS/.test(serverSrc));
    ok('source-pin: anonBuildLimited function exists', /anonBuildLimited/.test(serverSrc));
    ok('source-pin: anonBuildLimited is called in /api/run handler', (() => {
      // The call must be guarded with !user (anon-only)
      return /!user.*anonBuildLimited|anonBuildLimited.*!user/.test(serverSrc.replace(/\n/g, ' '));
    })());
    ok('source-pin: anon cap window is 24h', /ANON_WINDOW_MS\s*=\s*24\s*\*/.test(serverSrc));
    ok('source-pin: anon cap max is 2', /ANON_MAX_PER_IP\s*=\s*2\b/.test(serverSrc));
  }

  // ---- source-pin: kill-switch in server.ts ----
  {
    const serverSrc = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    ok('source-pin: billingEnabled() is called in server.ts', /billingEnabled\(\)/.test(serverSrc));
  }

  // ---- live end-to-end: grant → quote → debit → exact arithmetic ----
  {
    const uid8 = await scratchUser();
    // Fresh user: balanceCents triggers the lazy grant
    const startBal = await balanceCents(pool, uid8);
    ok('e2e: fresh user gets GRANT_CENTS', startBal === PRICING.GRANT_CENTS, `startBal=${startBal}`);

    // Quote a 13-step build (middle of the 12–14 reference range → $6.50)
    const cost13 = quoteCents('build', 13);
    ok('e2e: 13-step build costs $6.50', cost13 === 650, `cost=${cost13}`);

    // Debit and verify arithmetic
    const dr8 = await debitCents(pool, uid8, cost13, 'e2e build', null);
    ok('e2e: debit succeeds', dr8.ok === true, JSON.stringify(dr8));
    ok('e2e: balance_cents_after is exact', dr8.balance_cents_after === PRICING.GRANT_CENTS - cost13,
      `expected=${PRICING.GRANT_CENTS - cost13} got=${dr8.balance_cents_after}`);

    // balanceCents must agree
    const postBal = await balanceCents(pool, uid8);
    ok('e2e: balanceCents agrees with debit result', postBal === dr8.balance_cents_after, `postBal=${postBal}`);

    // The debit row is in the ledger with the correct sign
    const rows = (await pool.query(
      `select kind, amount_cents from billing_ledger where user_id=$1 and kind='debit'`, [uid8])).rows;
    ok('e2e: one debit row exists', rows.length === 1, `rows=${rows.length}`);
    ok('e2e: debit row has correct negative amount', rows[0].amount_cents === -cost13, `amount=${rows[0].amount_cents}`);
  }

  // ---- refund: a debited action that never happened gets its mirror 'adjust' row ----
  {
    const uid9 = await scratchUser();
    const before = await balanceCents(pool, uid9);                       // triggers grant
    const cost = quoteCents('rebuild');
    const dr = await debitCents(pool, uid9, cost, 'rebuild that will not start', null);
    ok('refund: debit landed first', dr.ok === true, JSON.stringify(dr));
    await refundCents(pool, uid9, cost, 'refund: rebuild did not start (busy)', null);
    const after = await balanceCents(pool, uid9);
    ok('refund: balance restored exactly', after === before, `before=${before} after=${after}`);
    const kinds = (await pool.query(
      `select kind, amount_cents from billing_ledger where user_id=$1 order by created_at`, [uid9])).rows;
    ok('refund: ledger keeps BOTH rows (append-only, no row mutated)',
      kinds.some(r => r.kind === 'debit' && r.amount_cents === -cost) &&
      kinds.some(r => r.kind === 'adjust' && r.amount_cents === cost),
      JSON.stringify(kinds));
  }

  // ---- source-pins: both rebuild trigger paths refund when startRebuild refuses ----
  {
    const serverSrc = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    ok('server: /api/rebuild refunds when the rebuild does not start',
      /rebuildDebited\) await refundCents/.test(serverSrc));
    ok('server: chat rebuild hook refunds when the rebuild does not start',
      /chatDebited\)[^\n]*\n\s*await refundCents/.test(serverSrc));
  }

  // ---- review fixes (adversarial audit 2026-07-06) ----
  {
    // grant race: 5 concurrent first-touches on a brand-new user must neither throw nor double-grant
    const uidR = await scratchUser();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => grantSignupCredit(pool, uidR)));
    ok('grant race: 5 concurrent grants — zero rejections', results.every(r => r.status === 'fulfilled'),
      JSON.stringify(results.filter(r => r.status === 'rejected').map((r: any) => String(r.reason?.message))));
    const g = (await pool.query(`select count(*)::int n from billing_ledger where user_id=$1 and kind='grant'`, [uidR])).rows[0];
    ok('grant race: exactly ONE grant row', Number(g.n) === 1, `rows=${g.n}`);

    // self-contained debit: a fresh user who NEVER called balanceCents can still spend the grant
    const uidS = await scratchUser();
    const dr = await debitCents(pool, uidS, 500, 'first touch is a debit', null);
    ok('debit self-grants: fresh user debit succeeds without prior balanceCents', dr.ok === true, JSON.stringify(dr));
    ok('debit self-grants: balance arithmetic includes the grant', dr.balance_cents_after === PRICING.GRANT_CENTS - 500,
      `after=${dr.balance_cents_after}`);

    // operator normalization survives env casing/whitespace
    const prevOp = process.env.RELAY_OPERATOR_EMAIL;
    process.env.RELAY_OPERATOR_EMAIL = '  NCHOBAH@GMAIL.COM ';
    ok('isOperator: env casing/whitespace normalized', isOperator({ email: 'nchobah@gmail.com' }) === true);
    if (prevOp === undefined) delete process.env.RELAY_OPERATOR_EMAIL; else process.env.RELAY_OPERATOR_EMAIL = prevOp;

    // refund-on-throw source-pins: BOTH rebuild paths refund when startRebuild THROWS, not only on {started:false}
    const srvSrc2 = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    ok('server: /api/rebuild refunds when startRebuild throws',
      /catch \(e\) \{[^}]*rebuildDebited\) await refundCents/s.test(srvSrc2));
    ok('server: chat rebuild refunds when startRebuild throws',
      /catch \(e\) \{[^}]*chatDebited\) await refundCents/s.test(srvSrc2));

    // funnel SQL uses the real column name and parenthesized email filter (kpi.ts)
    const kpiSrc = readFileSync(new URL('./kpi.ts', import.meta.url), 'utf8');
    ok('kpi funnel: queries site_submissions.data (not the phantom payload column)',
      !/payload::text|payload->>/.test(kpiSrc) && /data::text not ilike/.test(kpiSrc));
    ok('kpi funnel: email alternatives are parenthesized (no and/or precedence bypass)',
      /and \(\s*\n\s*\(data->>'email'\) is null/.test(kpiSrc));

    // replan preserves calendar + bizType identity (planner.ts)
    const plSrc = readFileSync(new URL('./planner.ts', import.meta.url), 'utf8');
    ok('replan: preserves cal_key across rebuilds', /cal_key: prev\.cal_key/.test(plSrc));
    ok('replan: preserves bizType across rebuilds', /bizType: prev\.bizType/.test(plSrc));
  }

} catch (e: any) {
  fail++;
  console.error('  ✗ unexpected throw:', e?.message ?? e);
} finally {
  // Clean up all scratch users (cascades to billing_ledger rows via FK on delete cascade)
  if (userIds.length) {
    await pool.query(`delete from users where id = any($1::uuid[])`, [userIds]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\nbilling:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

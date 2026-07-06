// billing.ts — ARC A: prepaid credits / quota / billing.
// DESIGN PRINCIPLES:
//   • The ledger is APPEND-ONLY — no UPDATE or DELETE ever runs on billing_ledger.
//     A partial unique index enforces one 'grant' row per user at the DB layer.
//   • debitCents is ONE atomic CTE: reads balance + today-spend in a single snapshot, then
//     inserts the negative row only when both the solvency and daily-cap invariants hold.
//     Race-safe by construction — no application-level locking needed.
//   • billingEnabled() is a kill-switch (RELAY_BILLING=0) for stress/dev runs.
//   • isOperator() is a pure function; operator accounts skip debit + block entirely
//     so nightly canaries never fail due to quota.
import pg from 'pg';

// ---- pricing constants (all amounts in US cents) ----
export const PRICING = {
  GRANT_CENTS:           3000,  // $30 signup credit
  BUILD_PER_STEP_CENTS:    50,  // $0.50 per task in the final DAG
  BUILD_MIN_CENTS:         300, // $3.00 floor (even a tiny 4-step plan)
  BUILD_MAX_CENTS:        2000, // $20.00 cap (guards against LLM-generated giant plans)
  REBUILD_CENTS:           200, // $2.00 flat (replan + re-render)
  DESIGN_CENTS:            100, // $1.00 flat (token import / preset apply)
  DAILY_CAP_CENTS:        2000, // $20.00 max spend in any UTC calendar day
};

// ---- table DDL ----

export async function ensureBillingTables(pool: pg.Pool): Promise<void> {
  // Main ledger: every financial event is one immutable row. The CHECK forces the sign
  // invariant at the DB layer: debits are always negative, grants/adjusts non-negative.
  await pool.query(`
    create table if not exists billing_ledger (
      id           uuid        primary key default gen_random_uuid(),
      user_id      uuid        not null references users(id) on delete cascade,
      kind         text        not null check (kind in ('grant','debit','adjust')),
      amount_cents int         not null
                               check ((kind = 'debit'  and amount_cents <  0)
                                   or (kind <> 'debit' and amount_cents >= 0)),
      reason       text        not null,
      project_id   uuid,
      created_at   timestamptz not null default now()
    )`);

  // ONE grant per user — the partial unique index enforces this without any special ON CONFLICT
  // target (grantSignupCredit uses WHERE NOT EXISTS which is index-shape-agnostic).
  await pool.query(`
    create unique index if not exists billing_one_grant
      on billing_ledger(user_id) where kind = 'grant'`);
}

// ---- pricing / quoting ----

// quoteCents: returns the cost in cents for a given operation.
//   build: clamp(steps × BUILD_PER_STEP_CENTS, BUILD_MIN_CENTS, BUILD_MAX_CENTS)
//   The "5-page site ≈ $6–7" reference (owner-stated pricing):
//     LLM returns 4-7 thinking tasks; validate() adds a branding/database/policies/integrations
//     guard, bringing thinking tasks to ~12-14. Those 12-14 × $0.50 = $6-$7 is the reference.
//     persistPlan adds: 1 compose + N renders + 1 QA — those push the final count higher,
//     but the pricing reference is the thinking-step span. The suite asserts this exactly.
export function quoteCents(kind: 'build' | 'rebuild' | 'design', steps?: number): number {
  if (kind === 'rebuild') return PRICING.REBUILD_CENTS;
  if (kind === 'design')  return PRICING.DESIGN_CENTS;
  // build: clamp to [BUILD_MIN, BUILD_MAX]
  const raw = (steps ?? 0) * PRICING.BUILD_PER_STEP_CENTS;
  return Math.max(PRICING.BUILD_MIN_CENTS, Math.min(PRICING.BUILD_MAX_CENTS, raw));
}

// ---- grant ----

// grantSignupCredit: insert a GRANT_CENTS grant for this user exactly once. Idempotent forever.
// Uses WHERE NOT EXISTS so it works with the partial unique index without needing ON CONFLICT
// (which would require repeating the partial predicate verbatim in the WHERE clause).
export async function grantSignupCredit(pool: pg.Pool, userId: string): Promise<void> {
  await pool.query(`
    insert into billing_ledger(user_id, kind, amount_cents, reason)
    select $1, 'grant', $2, 'signup credit'
    where not exists (
      select 1 from billing_ledger where user_id = $1 and kind = 'grant'
    )`, [userId, PRICING.GRANT_CENTS]);
}

// ---- balance ----

// balanceCents: lazily grants the signup credit (idempotent) then sums the ledger.
// EXISTING users who signed up before billing launched get their $30 on the first API touch.
export async function balanceCents(pool: pg.Pool, userId: string): Promise<number> {
  await grantSignupCredit(pool, userId);
  const r = await pool.query(
    `select coalesce(sum(amount_cents), 0)::int as balance
     from billing_ledger where user_id = $1`, [userId]);
  return Number(r.rows[0].balance);
}

// spentTodayCents: absolute sum of debit rows for this user in today's UTC calendar day.
export async function spentTodayCents(pool: pg.Pool, userId: string): Promise<number> {
  const r = await pool.query(
    `select coalesce(sum(amount_cents), 0)::int as spent
     from billing_ledger
     where user_id    = $1
       and kind       = 'debit'
       and created_at >= date_trunc('day', now() at time zone 'UTC')`, [userId]);
  // debits are stored as negative values; return the absolute amount spent
  return Math.abs(Number(r.rows[0].spent));
}

// ---- debit (the only mutation, and it's INSERT-only) ----

// debitCents: race-safe debit using a Postgres session-level advisory lock keyed on the user.
// The lock serialises concurrent debits per user — only one debit runs at a time per user,
// so the balance snapshot is always current when the guard check runs.
//
// WHY advisory lock (not SERIALIZABLE):
//   SERIALIZABLE would require retry loops (serialization failures are expected and retriable).
//   Advisory locks are cheaper and sufficient: we hold the lock only for the duration of one
//   short read+insert, release it immediately, and never hold it across network calls.
//
// HOW: pg_advisory_xact_lock(key) is a transaction-scoped lock — released automatically
//   when the transaction commits or rolls back. We hash the UUID to a bigint key.
//
// Returns {ok:true, balance_cents_after} on success or {ok:false, balance_cents_after} on refusal.
export async function debitCents(
  pool:      pg.Pool,
  userId:    string,
  cents:     number,
  reason:    string,
  projectId: string | null,
): Promise<{ ok: boolean; balance_cents_after: number }> {
  // Run inside a transaction so the advisory lock is tied to the transaction lifetime.
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Acquire a per-user advisory lock (transaction-scoped). hashtext() maps the user UUID
    // to a 32-bit int, which is the correct input type for pg_advisory_xact_lock(int, int).
    // We use (1, hashtext(userId)) — namespace 1 = billing, to avoid colliding with other
    // advisory locks in the system.
    await client.query(`select pg_advisory_xact_lock(1, hashtext($1::text))`, [userId]);

    // Now read the snapshot (no concurrent debit can run for this user while we hold the lock).
    // Parameters: $1=userId, $2=cents, $3=reason, $4=projectId, $5=DAILY_CAP_CENTS
    const r = await client.query(`
      with snapshot as (
        select
          coalesce(sum(amount_cents), 0)::int as balance,
          coalesce(abs(sum(
            case when kind = 'debit'
                  and created_at >= date_trunc('day', now() at time zone 'UTC')
                 then amount_cents else 0 end
          )), 0)::int as today_spent_abs
        from billing_ledger
        where user_id = $1
      ),
      ins as (
        insert into billing_ledger(user_id, kind, amount_cents, reason, project_id)
        select $1, 'debit', -$2::int, $3, $4
        from snapshot
        where balance >= $2                              -- solvency
          and today_spent_abs + $2 <= $5                -- daily cap
        returning amount_cents
      )
      select
        (select balance from snapshot)                  as balance_before,
        (exists (select 1 from ins))                    as inserted,
        (select balance from snapshot)
          + coalesce((select amount_cents from ins), 0) as balance_after
    `, [userId, cents, reason, projectId, PRICING.DAILY_CAP_CENTS]);

    await client.query('commit');
    const row = r.rows[0];
    return {
      ok:                  row.inserted  === true,
      balance_cents_after: Number(row.balance_after),
    };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---- operator check ----

// isOperator: the named operator email is never billed or blocked.
// Nightly canaries run as the operator account — billing must be a no-op.
export function isOperator(user: { email?: string } | null | undefined): boolean {
  if (!user?.email) return false;
  return user.email === (process.env.RELAY_OPERATOR_EMAIL || 'nchobah@gmail.com');
}

// ---- kill-switch ----

// billingEnabled: false when RELAY_BILLING=0 (stress tests, dev runs). Default ON.
export function billingEnabled(): boolean {
  return process.env.RELAY_BILLING !== '0';
}

// ---- human-readable error ----

// formatInsufficientFunds: phone-readable 402 message.
export function formatInsufficientFunds(balanceCents: number, costCents: number): string {
  const bal  = (balanceCents / 100).toFixed(2);
  const cost = (costCents    / 100).toFixed(2);
  return `Out of credit — $${bal} left, this build needs $${cost}.`;
}

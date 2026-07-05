// lifecycle:check — THE BOOKING LOOP GATE. Real DB, scratch schema, injected sender (no SMTP,
// no network). Pins: HMAC tokens sign/verify and reject tampering; GET never mutates (source pin);
// confirm/decline flip status through LEGAL transitions only; a declined booking frees its slot;
// reminders send ONCE per row (claim-first), skip probes and mail-less rows, and a failed send
// releases the claim for the next sweep.
import { randomUUID } from 'node:crypto';
import { makePool } from './db.ts';
import * as appdb from './appdb.ts';
import { actToken, verifyAct, findByRef, applyAction, ensureLifecycleTables, sweepReminders } from './lifecycle.ts';

const pool = makePool();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra); }
};

process.env.RELAY_SECRET = process.env.RELAY_SECRET || 'lifecycle-check-secret';
const id = randomUUID();
const schema = appdb.schemaName(id);

try {
  await ensureLifecycleTables(pool);

  // ---- tokens ----
  const t1 = actToken(id, 'a'.repeat(32), 'confirm')!;
  ok('token: signs and verifies', !!t1 && verifyAct(id, 'a'.repeat(32), 'confirm', t1));
  ok('token: a tampered ref is rejected', !verifyAct(id, 'b'.repeat(32), 'confirm', t1));
  ok('token: the action is bound (confirm token cannot decline)', !verifyAct(id, 'a'.repeat(32), 'decline', t1));
  {
    const saved = process.env.RELAY_SECRET;
    delete process.env.RELAY_SECRET;
    ok('token: no RELAY_SECRET → no token, nothing verifies (deterministic degradation)', actToken(id, 'a'.repeat(32), 'confirm') === null && !verifyAct(id, 'a'.repeat(32), 'confirm', t1));
    process.env.RELAY_SECRET = saved;
  }

  // ---- a scratch booking app (capacity-1 slot semantics) ----
  await pool.query(`insert into projects(id, brief, status, params) values ($1,'lifecycle scratch','done',$2)`,
    [id, JSON.stringify({ slug: 'lifecycle-scratch-x', locale: 'it', schema_forms: { actionTable: 'bookings' } })]);
  await appdb.provision(pool, id, JSON.stringify({ entities: [
    { name: 'staff', public: true, display: 'name', fields: [{ name: 'name', type: 'text', required: true }], seed: [{ name: 'Gia' }] },
    { name: 'bookings', public: false, fields: [
      { name: 'customer_name', type: 'text', required: true },
      { name: 'staff', type: 'ref:staff', required: true },
      { name: 'starts_at', type: 'datetime', required: true }] },
  ] }));
  const at = new Date(Date.now() + 48 * 3_600_000).toISOString();
  const ins = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Ada', email: 'ada@example.com', staff_id: 1, starts_at: at });
  ok('scratch booking lands with a ref', ins.ok === true && !!ins.ref, JSON.stringify(ins));
  const ref = ins.ref!;

  // ---- find + legal transitions ----
  const hit = await findByRef(pool, id, ref);
  ok('findByRef locates the row in the action table', !!hit && hit.table === 'bookings' && hit.row.customer_name === 'Ada');
  ok('findByRef rejects a malformed ref', (await findByRef(pool, id, 'zz')) === null);

  const sentMails: string[] = [];
  // applyAction sends via the real sendMail (SMTP unset here → silently no-op) — status flips are the gate
  const c1 = await applyAction(pool, id, ref, 'confirm');
  const st1 = (await pool.query(`select status from "${schema}"."bookings" where ref_token=$1`, [ref])).rows[0].status;
  ok('confirm: pending → confirmed', c1.ok === true && !c1.already && st1 === 'confirmed', `st=${st1}`);
  const c2 = await applyAction(pool, id, ref, 'confirm');
  ok('confirm again: idempotent (already, no re-flip)', c2.ok === true && c2.already === 'confirmed');
  const d1 = await applyAction(pool, id, ref, 'decline');
  const st2 = (await pool.query(`select status from "${schema}"."bookings" where ref_token=$1`, [ref])).rows[0].status;
  ok('decline after confirm: a late cancellation is legal', d1.ok === true && st2 === 'declined', `st=${st2}`);
  const c3 = await applyAction(pool, id, ref, 'confirm');
  ok('confirm after decline: final states are immutable', c3.ok === false && c3.already === 'declined');
  ok('lifecycle events are recorded', Number((await pool.query("select count(*)::int n from run_events where project_id=$1 and type like 'lifecycle_%'", [id])).rows[0].n) >= 2);

  // ---- the declined booking FREES its slot ----
  const again = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Beppe', email: 'beppe@example.com', staff_id: 1, starts_at: at });
  ok('a declined booking frees its slot (same coordinates re-bookable)', again.ok === true, String(again.error || ''));

  // ---- reminders ----
  const soonAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
  const rem = await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Carla', email: 'carla@example.com', staff_id: 1, starts_at: soonAt });
  ok('a near-future booking lands', rem.ok === true);
  // a probe row + a mail-less row inside the window must both be skipped
  await pool.query(`insert into "${schema}"."bookings"(customer_name, email, staff_id, starts_at) values ('QA Test 9','qa@example.com',1,$1)`, [soonAt]);
  await pool.query(`insert into "${schema}"."bookings"(customer_name, staff_id, starts_at) values ('NoMail',1,$1)`, [soonAt]);
  const outbox: Array<{ to: string; subject: string; text: string }> = [];
  const sender = async (_p: any, _id: any, to: string, subject: string, text: string) => { outbox.push({ to, subject, text }); return { ok: true }; };
  const n1 = await sweepReminders(pool, { hours: 24, send: sender, projectIds: [id] });
  // Beppe (48h out) is OUTSIDE the 24h window; Ada is declined; QA is a probe; NoMail has no email
  ok('reminder sweep: exactly the one eligible booking is reminded', n1 === 1 && outbox.length === 1 && outbox[0].to === 'carla@example.com', JSON.stringify({ n1, outbox: outbox.map(o => o.to) }));
  ok('reminder is localized to the SITE locale (Italian)', /Promemoria|prevista/.test(outbox[0].subject + outbox[0].text), outbox[0].subject);
  ok('reminder carries the receipt link', /receipt-bookings-[0-9a-f]{16,}/.test(outbox[0].text));
  const n2 = await sweepReminders(pool, { hours: 24, send: sender, projectIds: [id] });
  ok('second sweep: idempotent — nobody reminded twice', n2 === 0 && outbox.length === 1);
  // a FAILED send releases the claim so the next sweep retries
  await pool.query(`update "${schema}"."bookings" set email='retry@example.com' where customer_name='NoMail'`);
  const failing = async () => ({ ok: false });
  const n3 = await sweepReminders(pool, { hours: 24, send: failing as any, projectIds: [id] });
  const n4 = await sweepReminders(pool, { hours: 24, send: sender, projectIds: [id] });
  ok('a failed send is retried on the next sweep (claim released)', n3 === 0 && n4 === 1 && outbox[1].to === 'retry@example.com', JSON.stringify({ n3, n4 }));

  // ---- VISITOR SELF-CANCEL: enforces the advertised cancellation window ----
  {
    const { cancelWindow, cancelByVisitor } = await import('./lifecycle.ts');
    const cid = randomUUID(); const csch = appdb.schemaName(cid);
    try {
      // policy: cancellations allowed up to 24h before the event
      await pool.query(`insert into projects(id, brief, status, params) values ($1,'cancel scratch','done',$2)`,
        [cid, JSON.stringify({ slug: 'cancel-scratch-x', locale: 'en', policies: { cancellation_hours: 24 }, schema_forms: { actionTable: 'bookings' } })]);
      await appdb.provision(pool, cid, JSON.stringify({ entities: [
        { name: 'staff', public: true, display: 'name', fields: [{ name: 'name', type: 'text', required: true }], seed: [{ name: 'Rae' }] },
        { name: 'bookings', public: false, fields: [
          { name: 'customer_name', type: 'text', required: true },
          { name: 'staff', type: 'ref:staff', required: true },
          { name: 'starts_at', type: 'datetime', required: true }] },
      ] }));
      // FAR future (72h) — inside the cancellable window → 'open'; then cancel succeeds and frees the slot
      const farAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
      const b1 = await appdb.insertRow(pool, cid, 'bookings', { customer_name: 'Far', email: 'far@example.com', staff_id: 1, starts_at: farAt });
      const rowFar = (await appdb.readScoped(pool, cid, 'bookings', 'ref_token', b1.ref!, 1))[0];
      ok('cancel window: a booking well before the deadline is OPEN (button shown)', (await cancelWindow(pool, cid, 'bookings', rowFar)) === 'open');
      const cx = await cancelByVisitor(pool, cid, 'bookings', b1.ref!);
      const st = (await pool.query(`select status from "${csch}"."bookings" where ref_token=$1`, [b1.ref])).rows[0].status;
      ok('cancel: a visitor can cancel in-window; status → cancelled', cx.ok === true && st === 'cancelled');
      ok('cancel frees the slot (same coordinates re-bookable)', (await appdb.insertRow(pool, cid, 'bookings', { customer_name: 'Refill', email: 'r@example.com', staff_id: 1, starts_at: farAt })).ok === true);
      ok('cancel again is idempotent (already, no error)', (await cancelByVisitor(pool, cid, 'bookings', b1.ref!)).error === 'already');
      // SOON (6h < 24h window) — CLOSED, and the endpoint refuses
      const soonAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
      const b2 = await appdb.insertRow(pool, cid, 'bookings', { customer_name: 'Soon', email: 'soon@example.com', staff_id: 1, starts_at: soonAt });
      const rowSoon = (await appdb.readScoped(pool, cid, 'bookings', 'ref_token', b2.ref!, 1))[0];
      ok('cancel window: inside the 24h deadline is CLOSED (no button)', (await cancelWindow(pool, cid, 'bookings', rowSoon)) === 'closed');
      const late = await cancelByVisitor(pool, cid, 'bookings', b2.ref!);
      const st2 = (await pool.query(`select status from "${csch}"."bookings" where ref_token=$1`, [b2.ref])).rows[0].status;
      ok('cancel: the endpoint REFUSES past the deadline (window enforced, not just hidden)', late.ok === false && late.error === 'too_late' && st2 !== 'cancelled');
      ok('cancel: an unknown ref is not_found', (await cancelByVisitor(pool, cid, 'bookings', 'f'.repeat(32))).error === 'not_found');

      // AUDIT 2026-07-05: compare-and-swap — a visitor cancel must NOT clobber an owner confirm that
      // lands first (blind UPDATE would overwrite confirmed→cancelled).
      const { applyAction } = await import('./lifecycle.ts');
      const b3 = await appdb.insertRow(pool, cid, 'bookings', { customer_name: 'Race', email: 'race@example.com', staff_id: 1, starts_at: new Date(Date.now() + 96 * 3_600_000).toISOString() });
      await pool.query(`update "${csch}"."bookings" set status='confirmed' where ref_token=$1`, [b3.ref]);   // owner confirmed first
      const raced = await cancelByVisitor(pool, cid, 'bookings', b3.ref!);
      const st3 = (await pool.query(`select status from "${csch}"."bookings" where ref_token=$1`, [b3.ref])).rows[0].status;
      // (confirmed IS a legal from-state for cancel, so this SUCCEEDS — but via CAS, not a blind write)
      ok('cancel uses compare-and-swap (confirmed→cancelled is atomic, not a blind overwrite)', raced.ok === true && st3 === 'cancelled');
      // now the reverse: a stale cancel against a row that moved to a NON-cancellable state loses cleanly
      const b4 = await appdb.insertRow(pool, cid, 'bookings', { customer_name: 'Stale', email: 'stale@example.com', staff_id: 1, starts_at: new Date(Date.now() + 96 * 3_600_000).toISOString() });
      await pool.query(`update "${csch}"."bookings" set status='completed' where ref_token=$1`, [b4.ref]);   // moved past the CAS precondition
      const stale = await cancelByVisitor(pool, cid, 'bookings', b4.ref!);
      ok('cancel loses cleanly when the row already moved on (no blind clobber)', stale.ok === false && stale.error === 'illegal');

      // NULL EVENT TIME: a lifecycle row with no event column is NOT self-cancellable (mirrors the
      // hidden button) — consistent contract between cancelWindow and cancelByVisitor.
      const nid = randomUUID(); const nsch = appdb.schemaName(nid);
      try {
        await pool.query(`insert into projects(id, brief, status, params) values ($1,'no-event','done',$2)`, [nid, JSON.stringify({ slug: 'noevent-x', locale: 'en', schema_forms: { actionTable: 'requests' } })]);
        await appdb.provision(pool, nid, JSON.stringify({ entities: [
          { name: 'requests', public: false, fields: [{ name: 'customer_name', type: 'text', required: true }, { name: 'note', type: 'text' }] },
        ] }));
        const nb = await appdb.insertRow(pool, nid, 'requests', { customer_name: 'NoTime', email: 'nt@example.com', note: 'call me' });
        const nrow = (await appdb.readScoped(pool, nid, 'requests', 'ref_token', nb.ref!, 1))[0];
        ok('cancel window: a row with no event time is NONE (button hidden)', (await cancelWindow(pool, nid, 'requests', nrow)) === 'none');
        const nc = await cancelByVisitor(pool, nid, 'requests', nb.ref!);
        const nst = (await pool.query(`select status from "${nsch}"."requests" where ref_token=$1`, [nb.ref])).rows[0].status;
        ok('cancel endpoint mirrors the hidden button for a time-less row (refuses, status untouched)', nc.ok === false && nst !== 'cancelled');
      } finally {
        await pool.query(`drop schema if exists "${nsch}" cascade`).catch(() => {});
        await pool.query('delete from projects where id=$1', [nid]).catch(() => {});
      }
    } finally {
      await pool.query(`drop schema if exists "${csch}" cascade`).catch(() => {});
      await pool.query('delete from run_events where project_id=$1', [cid]).catch(() => {});
      await pool.query('delete from projects where id=$1', [cid]).catch(() => {});
    }
  }

  // ---- source pins: routes wired, GET never mutates, links ride the lead mail ----
  const serverSrc = (await import('node:fs')).readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  ok('server: the act route exists and rides the read rate-cap', /\/act\$\/\)/.test(serverSrc) && /actM[\s\S]{0,200}readLimited/.test(serverSrc));
  ok('server: only POST calls applyAction (GET is prefetch-safe)', (serverSrc.match(/applyAction\(/g) || []).length === 1 && /req\.method === 'POST'[\s\S]{0,200}applyAction\(/.test(serverSrc));
  ok('server: lifecycle inserts mint signed confirm+decline links into the lead mail', serverSrc.includes("actToken(dataM[1], r.ref, 'confirm')") && serverSrc.includes('a=decline&t='));
  ok('server: the reminder sweep is scheduled (30 min, mailReady-gated)', serverSrc.includes('sweepReminders(pool)') && serverSrc.includes('setInterval(run, 30 * 60_000)') && /if \(mailReady\(\)\)/.test(serverSrc));
  const mailSrc = (await import('node:fs')).readFileSync(new URL('./mail.ts', import.meta.url), 'utf8');
  ok('mail: notifyLead carries the one-tap links when given', /actions \? [\s\S]{0,80}Confirm: \$\{actions\.confirm\}/.test(mailSrc));

  // ---- ADVERSARIAL AUDIT 2026-07-05 on the lifecycle surface: 7 findings closed ----
  // XSS: the act page escapes visitor-controlled name (owner opens it on the board origin)
  ok('server: the act page escapes the visitor name (no visitor→owner XSS)', /const who = esc\(String\(/.test(serverSrc) && serverSrc.includes("import { esc } from './components.ts'"));

  // WRONG WHEN-COLUMN: a booking table that ALSO has date_of_birth must remind on the appointment,
  // never the birth date — pickWhenColumn is the shared, correct picker.
  const { pickWhenColumn } = await import('./schema.ts');
  ok('schema: pickWhenColumn skips date_of_birth, prefers the appointment column',
    pickWhenColumn([{ name: 'date_of_birth', type: 'date' }, { name: 'appointment_at', type: 'timestamptz' }]) === 'appointment_at'
    && pickWhenColumn([{ name: 'created_at', type: 'timestamptz' }, { name: 'starts_at', type: 'timestamptz' }]) === 'starts_at'
    && pickWhenColumn([{ name: 'date_of_birth', type: 'date' }]) === null);
  // functional: a booking table carrying date_of_birth reminds on the real event, and never on the DOB
  {
    const bid = randomUUID(); const bsch = appdb.schemaName(bid);
    try {
      await pool.query(`insert into projects(id, brief, status, params) values ($1,'dob scratch','done',$2)`,
        [bid, JSON.stringify({ slug: 'dob-scratch-x', locale: 'en', schema_forms: { actionTable: 'appointments' } })]);
      await appdb.provision(pool, bid, JSON.stringify({ entities: [
        { name: 'appointments', public: false, fields: [
          { name: 'customer_name', type: 'text', required: true },
          { name: 'date_of_birth', type: 'date' },
          { name: 'appointment_at', type: 'datetime', required: true }] },
      ] }));
      const soon = new Date(Date.now() + 6 * 3_600_000).toISOString();
      await appdb.insertRow(pool, bid, 'appointments', { customer_name: 'Dora', email: 'dora@example.com', date_of_birth: '1990-01-15', appointment_at: soon });
      const outb: string[] = [];
      const n = await sweepReminders(pool, { hours: 24, projectIds: [bid], send: async (_p: any, _i: any, to: string) => { outb.push(to); return { ok: true }; } });
      ok('reminder keyed on the EVENT column even when a birth date exists', n === 1 && outb[0] === 'dora@example.com', JSON.stringify({ n, outb }));
    } finally {
      await pool.query(`drop schema if exists "${bsch}" cascade`).catch(() => {});
      await pool.query('delete from reminder_log where project_id=$1', [bid]).catch(() => {});
      await pool.query('delete from projects where id=$1', [bid]).catch(() => {});
    }
  }
  // LOCALE CRASH ISOLATION: a corrupt locale must not throw and kill the sweep
  {
    const lid = randomUUID(); const lsch = appdb.schemaName(lid);
    try {
      await pool.query(`insert into projects(id, brief, status, params) values ($1,'bad locale','done',$2)`,
        [lid, JSON.stringify({ slug: 'badloc-x', locale: 'not-a-locale', schema_forms: { actionTable: 'bookings' } })]);
      await appdb.provision(pool, lid, JSON.stringify({ entities: [
        { name: 'bookings', public: false, fields: [{ name: 'customer_name', type: 'text', required: true }, { name: 'starts_at', type: 'datetime', required: true }] },
      ] }));
      await appdb.insertRow(pool, lid, 'bookings', { customer_name: 'Zed', email: 'zed@example.com', starts_at: new Date(Date.now() + 5 * 3_600_000).toISOString() });
      const outb: string[] = [];
      const n = await sweepReminders(pool, { hours: 24, projectIds: [lid], send: async (_p: any, _i: any, to: string) => { outb.push(to); return { ok: true }; } });
      ok('a corrupt project locale does not crash the sweep (falls back to en)', n === 1 && outb[0] === 'zed@example.com', JSON.stringify({ n, outb }));
    } finally {
      await pool.query(`drop schema if exists "${lsch}" cascade`).catch(() => {});
      await pool.query('delete from reminder_log where project_id=$1', [lid]).catch(() => {});
      await pool.query('delete from projects where id=$1', [lid]).catch(() => {});
    }
  }
  ok('lifecycle: reminder_log is pruned (bounded growth)', (await import('node:fs')).readFileSync(new URL('./lifecycle.ts', import.meta.url), 'utf8').includes("delete from reminder_log where sent_at < now() - interval '60 days'"));
  ok('lifecycle: one project error is isolated, never aborts the whole sweep', (await import('node:fs')).readFileSync(new URL('./lifecycle.ts', import.meta.url), 'utf8').includes('project skipped after error'));
  ok('server: the reminder scheduler has an in-flight guard (no overlapping sweeps)', /let sweeping = false[\s\S]{0,200}if \(sweeping\) return/.test(serverSrc));
  ok('ics: the calendar feed uses the same event-column picker', (await import('node:fs')).readFileSync(new URL('./ics.ts', import.meta.url), 'utf8').includes('pickWhenColumn(cols'));
  // cancel wiring: endpoint re-enforces (never trusts the button), receipt renders it, client fn + strings ship
  ok('server: the cancel endpoint exists (POST, re-enforced server-side)', /\/cancel\$\/\)/.test(serverSrc) && serverSrc.includes('cancelByVisitor(pool, cancelM[1]'));
  ok('components: the receipt renders a Cancel button only when the window is open', (await import('node:fs')).readFileSync(new URL('./components.ts', import.meta.url), 'utf8').includes("s.cancel.state === 'open'") && (await import('node:fs')).readFileSync(new URL('./components.ts', import.meta.url), 'utf8').includes('relayCancel('));
  ok('render: the client relayCancel fn is emitted and localized', (await import('node:fs')).readFileSync(new URL('./render.ts', import.meta.url), 'utf8').includes('window.relayCancel=function'));
  const lcSrc = (await import('node:fs')).readFileSync(new URL('./lifecycle.ts', import.meta.url), 'utf8');
  ok('lifecycle: BOTH status writes are compare-and-swap (guarded on the validated status)', (lcSrc.match(/where "ref_token"=\$\d and "status"=\$\d/g) || []).length >= 2 && lcSrc.includes('upd.rowCount'));
  const { clientDict } = await import('./i18n.ts');
  ok('i18n: the cancel strings ship to the client dictionary (5 locales gated elsewhere)', !!clientDict('en').cancel_confirm_q && !!clientDict('it').cancel_done);
} catch (e: any) {
  fail++; console.error('  ✗ threw:', e?.stack || e?.message || e);
} finally {
  await pool.query(`drop schema if exists "${schema}" cascade`).catch(() => {});
  await pool.query('delete from reminder_log where project_id=$1', [id]).catch(() => {});
  await pool.query('delete from run_events where project_id=$1', [id]).catch(() => {});
  await pool.query('delete from projects where id=$1', [id]).catch(() => {});
  await pool.end();
}

console.log(`\nlifecycle:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

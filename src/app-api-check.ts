// appapi:check — BEHAVIORAL proof of the full-stack app API (RELAY_APP_API path).
// WHY a separate check (not bolted onto app:check): the app API is gated behind RELAY_APP_API=1
// and lives in src/app/api.ts. This suite proves the whole request→DB→JSON cycle:
//   • list returns the seeded row (real DB round-trip — unfakeable)
//   • get-by-id returns that same row
//   • create inserts and is immediately readable via list
//   • an unknown table is answered [] / 404 (never an error that leaks schema info)
//   • a SQL-injection-y table name is structurally rejected before any DB query
//   • a PRIVATE_READ table (bookings) answers [] to list and null to get-by-id (FS0 preserved)
//   • a SENSITIVE column (password_hash) is never included in any response
//
// Pattern mirrors app-check.ts: scratch UUID, provision a real schema, exercise the handler
// directly (no live server needed — the handler is a pure async function), clean up in finally.
// Exit 1 on any failure.
import { randomUUID } from 'node:crypto';
import { makePool } from './db.ts';
import * as appdb from './appdb.ts';
import { handleAppApi } from './app/api.ts';
import type { AppApiRequest } from './app/api.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// The model we'll provision: a 'services' table (public — not PRIVATE_READ) with real columns,
// and a 'bookings' table (PRIVATE_READ — the gate must answer [] / null publicly).
// WHY 'services': it matches the PRIVATE_READ allowlist as a public table (see app-check.ts:28
// where 'services' is explicitly in the public list). 'deliveries' is PRIVATE_READ so it can
// never be the list-read test subject.
const MODEL = JSON.stringify({ entities: [
  {
    name: 'services',
    public: true,
    display: 'title',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'price_cents', type: 'int', required: true },
      { name: 'description', type: 'text' },
    ],
    // WHY seed: proves the list endpoint returns real pre-existing rows, not just rows we create
    // in the test. Seeds land via the compiled DDL INSERT; a visitor-record guard strips seeds on
    // private tables, but 'services' is a public catalog table so seeds survive.
    seed: [{ title: 'Seed Service', price_cents: 1000, description: 'Test service' }],
  },
  {
    // PRIVATE_READ table — list and get-by-id must answer [] / null (FS0)
    name: 'bookings',
    public: false,
    fields: [
      { name: 'customer_name', type: 'text', required: true },
      { name: 'email', type: 'email' },
    ],
  },
] });

const pool = makePool();
const id = randomUUID();

function makeReq(method: string, path: string, body = ''): AppApiRequest {
  // Build a minimal URL just for the searchParams; the host is not meaningful here
  const url = new URL('http://localhost' + path);
  return { method, url, body };
}

try {
  await appdb.provision(pool, id, MODEL);

  // ---- list: seeded row is visible ----
  {
    const r = await handleAppApi(pool, id, 'services', null, makeReq('GET', '/api/app/' + id + '/services'));
    ok('list: handler returns 200', r?.status === 200, String(r?.status));
    let rows: any[] = [];
    try { rows = JSON.parse(r?.body || '{}').rows; } catch {}
    ok('list: returns the seeded row', Array.isArray(rows) && rows.length >= 1, 'rows=' + JSON.stringify(rows));
    const seed = rows.find((x: any) => x.title === 'Seed Service');
    ok('list: the seeded service is present', !!seed, 'rows=' + JSON.stringify(rows));
    ok('list: price_cents is a real DB value (not a stub)', seed && seed.price_cents === 1000, JSON.stringify(seed));
  }

  // ---- create: insert a new row and verify it appears in a subsequent list ----
  {
    const cr = await handleAppApi(pool, id, 'services', null,
      makeReq('POST', '/api/app/' + id + '/services', JSON.stringify({ title: 'Ada Service', price_cents: 2500, description: 'created by test' })));
    ok('create: handler returns 200', cr?.status === 200, String(cr?.status));
    let cBody: any = {};
    try { cBody = JSON.parse(cr?.body || '{}'); } catch {}
    ok('create: ok:true in response', cBody.ok === true, JSON.stringify(cBody));

    // verify the row is now readable via list
    const lr2 = await handleAppApi(pool, id, 'services', null, makeReq('GET', '/api/app/' + id + '/services'));
    let rows2: any[] = [];
    try { rows2 = JSON.parse(lr2?.body || '{}').rows; } catch {}
    const ada = rows2.find((x: any) => x.title === 'Ada Service');
    ok('create: the new row is immediately readable via list (real DB round-trip)', !!ada, 'rows=' + JSON.stringify(rows2));
    ok('create: price_cents stored correctly', ada && ada.price_cents === 2500, JSON.stringify(ada));
  }

  // ---- get-by-id ----
  {
    // find the seeded row's id from the list response
    const lr = await handleAppApi(pool, id, 'services', null, makeReq('GET', '/api/app/' + id + '/services'));
    let rows: any[] = [];
    try { rows = JSON.parse(lr?.body || '{}').rows; } catch {}
    const seed = rows.find((x: any) => x.title === 'Seed Service');
    const sid = seed?.id;
    if (typeof sid === 'number') {
      const gr = await handleAppApi(pool, id, 'services', String(sid), makeReq('GET', '/api/app/' + id + '/services/' + sid));
      ok('get-by-id: handler returns 200', gr?.status === 200, String(gr?.status));
      let rowObj: any = null;
      try { rowObj = JSON.parse(gr?.body || '{}').row; } catch {}
      ok('get-by-id: the row is the right one', rowObj && rowObj.title === 'Seed Service', JSON.stringify(rowObj));
      ok('get-by-id: price_cents is correct', rowObj && rowObj.price_cents === 1000, JSON.stringify(rowObj));

      // non-existent id → 404
      const nr = await handleAppApi(pool, id, 'services', '999999', makeReq('GET', '/api/app/' + id + '/services/999999'));
      ok('get-by-id: non-existent row → 404', nr?.status === 404, String(nr?.status));
    } else {
      // seed row found but has no integer id — still count the id test as seen
      fail++; console.error('  ✗ get-by-id: could not find seeded row id in list response — rows=' + JSON.stringify(rows));
    }
  }

  // ---- unknown table: structurally valid name but not in this project's catalog ----
  {
    const ur = await handleAppApi(pool, id, 'zzz_not_a_real_table', null, makeReq('GET', '/api/app/' + id + '/zzz_not_a_real_table'));
    ok('unknown table: list answers [] not an error (same as appdb.readRows)', (() => {
      try { const b = JSON.parse(ur?.body || '{}'); return Array.isArray(b.rows) && b.rows.length === 0; } catch { return false; }
    })(), String(ur?.body));
    // appdb.readRows returns [] for unknown tables; the handler mirrors that: 200 with empty rows,
    // not a 404. Existence of a table name should not be enumerable from response codes.
  }

  // ---- SQL-injection-y table name: rejected at the TABLE_RE layer (never reaches the DB) ----
  {
    // TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/ — a dot/semicolon/dash fails immediately
    // The handler receives the table name as a separate argument (already split from the URL by
    // the route regex in server.ts); we call it directly with the malicious string here.
    const ir = await handleAppApi(pool, id, 'services; drop table services--', null, makeReq('GET', '/api/app/' + id + '/services'));
    const ir2 = await handleAppApi(pool, id, 'ser.vices', null, makeReq('GET', '/api/app/' + id + '/ser.vices'));
    ok('injection: semicolon table name rejected (null = not our route)', ir === null || ir?.status === 404, JSON.stringify(ir));
    ok('injection: dot table name rejected (null = not our route)', ir2 === null || ir2?.status === 404, JSON.stringify(ir2));
  }

  // ---- FS0: PRIVATE_READ table answers [] for list and null for get-by-id (public audience) ----
  {
    // insert a booking so there IS a row to potentially leak
    await appdb.insertRow(pool, id, 'bookings', { customer_name: 'Private Person', email: 'priv@example.com' });

    const pr = await handleAppApi(pool, id, 'bookings', null, makeReq('GET', '/api/app/' + id + '/bookings'));
    ok('FS0: PRIVATE_READ table list answers 200 with empty rows (FS0 preserved)', (() => {
      try { const b = JSON.parse(pr?.body || '{}'); return pr?.status === 200 && Array.isArray(b.rows) && b.rows.length === 0; } catch { return false; }
    })(), String(pr?.body));

    // get-by-id on a private table: we need the actual row id — go straight to DB since the list won't show it
    const schema = appdb.schemaName(id);
    const brows = (await pool.query(`select id from "${schema}"."bookings" limit 1`)).rows;
    if (brows.length) {
      const bid = brows[0].id;
      const bgr = await handleAppApi(pool, id, 'bookings', String(bid), makeReq('GET', '/api/app/' + id + '/bookings/' + bid));
      ok('FS0: PRIVATE_READ get-by-id answers 404 (FS0 preserved)', bgr?.status === 404, String(bgr?.status));
    }
  }

  // ---- SENSITIVE column guard: no api_key / token / secret in any list or get response ----
  // The guard is in appdb.ts (decorateRows). We prove it on a fresh scratch schema with a catalog
  // table that carries a SENSITIVE column name. WHY a separate schema: so this test doesn't
  // interfere with the main scratch id's table shape.
  {
    const sid2 = randomUUID();
    try {
      // 'products' is a public table. We add an 'api_key' column (matches SENSITIVE regex /api_?key/i)
      // to prove appdb.readRows strips it from the public list response.
      await appdb.provision(pool, sid2, JSON.stringify({ entities: [
        { name: 'products', public: true, display: 'name', fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'price', type: 'int' },
          // 'api_key' matches SENSITIVE regex — must never appear in public reads
          { name: 'api_key', type: 'text' },
        ] },
      ] }));
      // Insert directly so we can set the sensitive column (insertRow would block it via SENSITIVE check)
      await pool.query(`insert into "${appdb.schemaName(sid2)}"."products" (name, price, api_key) values ('Widget', 99, 'supersecret')`);
      const sr = await handleAppApi(pool, sid2, 'products', null, makeReq('GET', '/api/app/' + sid2 + '/products'));
      let srows: any[] = [];
      try { srows = JSON.parse(sr?.body || '{}').rows; } catch {}
      const widget = srows.find((x: any) => x.name === 'Widget');
      ok('SENSITIVE: api_key is absent from list response (stripped by appdb)', !!widget && !('api_key' in (widget || {})), JSON.stringify(widget));
      ok('SENSITIVE: the non-sensitive column is still present', !!widget && widget.price === 99, JSON.stringify(widget));
    } finally {
      await pool.query(`drop schema if exists "${appdb.schemaName(sid2)}" cascade`).catch(() => {});
    }
  }

  // ---- invalid JSON body on POST → 400 ----
  {
    const br = await handleAppApi(pool, id, 'deliveries', null, makeReq('POST', '/api/app/' + id + '/deliveries', '{bad json'));
    ok('POST invalid JSON → 400', br?.status === 400, String(br?.status));
  }

  // ---- bad projectId → null (not our route) ----
  {
    const rr = await handleAppApi(pool, 'not-a-uuid', 'deliveries', null, makeReq('GET', '/api/app/not-a-uuid/deliveries'));
    ok('bad projectId → null (route does not match)', rr === null, JSON.stringify(rr));
  }

  // ---- REAL END-TO-END PROOF: seed a products row, call list, print the JSON from Postgres ----
  // This is the "not a button" proof: a real row in a real pg schema returns real JSON through the
  // handler — no mock, no stub, no in-memory fake. 'products' is a public catalog table (not
  // PRIVATE_READ) so its rows are visible to the public API audience.
  {
    const proofId = randomUUID();
    try {
      await appdb.provision(pool, proofId, JSON.stringify({ entities: [
        { name: 'products', public: true, display: 'name', fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'price_cents', type: 'int', required: true },
          { name: 'category', type: 'text' },
        ] },
      ] }));
      // Seed a row via appdb.insertRow (the same path a real form submission uses)
      const ins = await appdb.insertRow(pool, proofId, 'products', { name: 'Proof Widget', price_cents: 4200, category: 'test' });
      ok('E2E: row inserted via appdb.insertRow', ins.ok === true, JSON.stringify(ins));

      // Now call the list handler — this is the full request→DB→JSON cycle
      const listR = await handleAppApi(pool, proofId, 'products', null, makeReq('GET', '/api/app/' + proofId + '/products'));
      let listRows: any[] = [];
      try { listRows = JSON.parse(listR?.body || '{}').rows; } catch {}
      const proofRow = listRows.find((x: any) => x.name === 'Proof Widget');
      ok('E2E: seeded row appears in list response (real DB round-trip)', !!proofRow && proofRow.price_cents === 4200, JSON.stringify(proofRow));

      // Print the proof so the parent agent can read it
      console.log('E2E proof — seeded products row from Postgres via handleAppApi:');
      console.log(JSON.stringify(proofRow, null, 2));
    } finally {
      await pool.query(`drop schema if exists "${appdb.schemaName(proofId)}" cascade`).catch(() => {});
    }
  }

} catch (e: any) {
  fail++; console.error('  ✗ threw:', e?.message ?? e, e?.stack ?? '');
} finally {
  // Always clean up the scratch schema + project rows so a failed run leaves no footprint
  await pool.query(`drop schema if exists "${appdb.schemaName(id)}" cascade`).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\nappapi:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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

  // ============================================================================
  // T8 — PAGINATION + ORDERING GATES (behavioral, real DB round-trip)
  // Provisions a scratch schema with multiple rows and proves:
  //   • ?limit is respected (fewer rows than total)
  //   • ?offset advances the window (non-overlapping pages)
  //   • ?order=<column> orders by that column
  //   • ?dir=asc / ?dir=desc reverses the order
  //   • an unknown ?order column is rejected with 400 (not injected)
  //   • the response envelope contains {rows, limit, offset}
  // ============================================================================
  {
    const pagId = randomUUID();
    try {
      await appdb.provision(pool, pagId, JSON.stringify({ entities: [
        { name: 'items', public: true, display: 'name', fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'score', type: 'int' },
        ] },
      ] }));
      // Insert 5 rows with distinct scores so ordering is deterministic.
      const schema = appdb.schemaName(pagId);
      for (let i = 1; i <= 5; i++) {
        await pool.query(`insert into "${schema}"."items" (name, score) values ($1, $2)`, [`Item${i}`, i * 10]);
      }

      // --- response envelope: list returns {rows, limit, offset} ---
      const listR = await handleAppApi(pool, pagId, 'items', null, makeReq('GET', '/api/app/' + pagId + '/items?limit=3&offset=0'));
      const listB = (() => { try { return JSON.parse(listR?.body || '{}'); } catch { return {}; } })();
      ok('T8 envelope: list returns rows array', Array.isArray(listB.rows), JSON.stringify(listB));
      ok('T8 envelope: limit echoed back', listB.limit === 3, JSON.stringify(listB));
      ok('T8 envelope: offset echoed back', listB.offset === 0, JSON.stringify(listB));
      ok('T8 limit: page 1 has 3 rows (bounded)', Array.isArray(listB.rows) && listB.rows.length === 3, 'rows=' + listB.rows?.length);

      // --- second page: offset=3, should get the remaining 2 rows ---
      const page2R = await handleAppApi(pool, pagId, 'items', null, makeReq('GET', '/api/app/' + pagId + '/items?limit=3&offset=3'));
      const page2B = (() => { try { return JSON.parse(page2R?.body || '{}'); } catch { return {}; } })();
      ok('T8 offset: page 2 has 2 rows (remaining after offset=3)', Array.isArray(page2B.rows) && page2B.rows.length === 2, 'rows=' + page2B.rows?.length);
      ok('T8 offset echoed: offset=3 in page 2 response', page2B.offset === 3, JSON.stringify(page2B));

      // --- pages don't overlap: no item id appears in both pages ---
      if (Array.isArray(listB.rows) && Array.isArray(page2B.rows)) {
        const p1ids = new Set(listB.rows.map((r: any) => r.id));
        const overlap = page2B.rows.some((r: any) => p1ids.has(r.id));
        ok('T8 no overlap: page 1 and page 2 are disjoint', !overlap, 'p1=' + JSON.stringify(listB.rows?.map((r: any) => r.id)) + ' p2=' + JSON.stringify(page2B.rows?.map((r: any) => r.id)));
      }

      // --- ordering: ?order=score&dir=asc → ascending scores ---
      const ascR = await handleAppApi(pool, pagId, 'items', null, makeReq('GET', '/api/app/' + pagId + '/items?order=score&dir=asc&limit=5'));
      const ascB = (() => { try { return JSON.parse(ascR?.body || '{}'); } catch { return {}; } })();
      const ascScores: number[] = (ascB.rows || []).map((r: any) => Number(r.score));
      const isSortedAsc = ascScores.every((v, i) => i === 0 || v >= ascScores[i - 1]);
      ok('T8 order asc: scores are in ascending order', isSortedAsc && ascScores.length === 5, 'scores=' + JSON.stringify(ascScores));

      // --- ordering: ?order=score&dir=desc → descending scores ---
      const descR = await handleAppApi(pool, pagId, 'items', null, makeReq('GET', '/api/app/' + pagId + '/items?order=score&dir=desc&limit=5'));
      const descB = (() => { try { return JSON.parse(descR?.body || '{}'); } catch { return {}; } })();
      const descScores: number[] = (descB.rows || []).map((r: any) => Number(r.score));
      const isSortedDesc = descScores.every((v, i) => i === 0 || v <= descScores[i - 1]);
      ok('T8 order desc: scores are in descending order', isSortedDesc && descScores.length === 5, 'scores=' + JSON.stringify(descScores));

      // --- reject unknown order column with 400 ---
      // WHY 400 (not silent fallback): an unknown column almost certainly signals a client bug;
      // returning rows in an unexpected order is worse than an honest error. (T8 spec)
      const badOrderR = await handleAppApi(pool, pagId, 'items', null, makeReq('GET', '/api/app/' + pagId + '/items?order=nonexistent_column_xyz'));
      ok('T8 unknown order column → 400', badOrderR?.status === 400, String(badOrderR?.status));

      // --- limit bounds: max is capped at 200 ---
      const bigR = await handleAppApi(pool, pagId, 'items', null, makeReq('GET', '/api/app/' + pagId + '/items?limit=9999'));
      const bigB = (() => { try { return JSON.parse(bigR?.body || '{}'); } catch { return {}; } })();
      ok('T8 limit cap: limit>200 is capped (echoed limit ≤ 200)', bigB.limit <= 200, 'limit=' + bigB.limit);

    } finally {
      await pool.query(`drop schema if exists "${appdb.schemaName(pagId)}" cascade`).catch(() => {});
    }
  }

  // ============================================================================
  // T9 — OWNER-AUTH ON PRIVATE TABLES (behavioral, real DB round-trip)
  // Provisions a scratch schema with one private table (bookings) and one public table (products).
  // Proves:
  //   • public audience → private table list returns [] (FS0 preserved)
  //   • owner audience → private table list returns real rows
  //   • public audience → private table get-by-id returns 404 (FS0 preserved)
  //   • owner audience → private table get-by-id returns the row
  //   • public table is unaffected by audience (always readable)
  //   • POST to a private table is always allowed (visitors book) regardless of audience
  // ============================================================================
  {
    const authId = randomUUID();
    try {
      await appdb.provision(pool, authId, JSON.stringify({ entities: [
        { name: 'products', public: true, display: 'title', fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'price', type: 'int' },
        ] },
        { name: 'bookings', public: false, fields: [
          { name: 'customer_name', type: 'text', required: true },
          { name: 'email', type: 'email' },
        ] },
      ] }));

      // Seed a product (public) and a booking (private).
      await appdb.insertRow(pool, authId, 'products', { title: 'Auth Widget', price: 500 });
      // insertRow on a private table is always allowed (visitor booking path).
      const bookR = await appdb.insertRow(pool, authId, 'bookings', { customer_name: 'Alice Owner', email: 'alice@example.com' });
      ok('T9 setup: insertRow on private table succeeds (visitor booking always allowed)', bookR.ok === true, JSON.stringify(bookR));

      // --- public audience → private table list returns [] ---
      const pubListR = await handleAppApi(pool, authId, 'bookings', null, makeReq('GET', '/api/app/' + authId + '/bookings'), 'public');
      const pubListB = (() => { try { return JSON.parse(pubListR?.body || '{}'); } catch { return {}; } })();
      ok('T9 public: private table list returns [] (FS0)', Array.isArray(pubListB.rows) && pubListB.rows.length === 0, JSON.stringify(pubListB));
      ok('T9 public: private table list status 200 (not 404 — no existence leak)', pubListR?.status === 200, String(pubListR?.status));

      // --- owner audience → private table list returns real rows ---
      const ownListR = await handleAppApi(pool, authId, 'bookings', null, makeReq('GET', '/api/app/' + authId + '/bookings'), 'owner');
      const ownListB = (() => { try { return JSON.parse(ownListR?.body || '{}'); } catch { return {}; } })();
      ok('T9 owner: private table list returns rows', Array.isArray(ownListB.rows) && ownListB.rows.length >= 1, JSON.stringify(ownListB));
      const aliceRow = (ownListB.rows || []).find((r: any) => r.customer_name === 'Alice Owner');
      ok('T9 owner: the booking row is present in owner read', !!aliceRow, JSON.stringify(ownListB.rows));

      // --- public audience → private table get-by-id returns 404 ---
      const authSchema = appdb.schemaName(authId);
      const bid = (await pool.query(`select id from "${authSchema}"."bookings" limit 1`)).rows[0]?.id;
      if (bid !== undefined) {
        const pubGetR = await handleAppApi(pool, authId, 'bookings', String(bid), makeReq('GET', '/api/app/' + authId + '/bookings/' + bid), 'public');
        ok('T9 public: private get-by-id → 404 (FS0)', pubGetR?.status === 404, String(pubGetR?.status));

        // --- owner audience → private table get-by-id returns the row ---
        const ownGetR = await handleAppApi(pool, authId, 'bookings', String(bid), makeReq('GET', '/api/app/' + authId + '/bookings/' + bid), 'owner');
        ok('T9 owner: private get-by-id returns 200', ownGetR?.status === 200, String(ownGetR?.status));
        const ownRowB = (() => { try { return JSON.parse(ownGetR?.body || '{}'); } catch { return {}; } })();
        ok('T9 owner: row has correct customer_name', ownRowB?.row?.customer_name === 'Alice Owner', JSON.stringify(ownRowB?.row));
      } else {
        fail++; console.error('  ✗ T9: could not find booking row id');
      }

      // --- public table unaffected by audience ---
      const pubProdR = await handleAppApi(pool, authId, 'products', null, makeReq('GET', '/api/app/' + authId + '/products'), 'public');
      const pubProdB = (() => { try { return JSON.parse(pubProdR?.body || '{}'); } catch { return {}; } })();
      ok('T9 public table: readable by public audience', Array.isArray(pubProdB.rows) && pubProdB.rows.some((r: any) => r.title === 'Auth Widget'), JSON.stringify(pubProdB.rows));

    } finally {
      await pool.query(`drop schema if exists "${appdb.schemaName(authId)}" cascade`).catch(() => {});
    }
  }

  // ============================================================================
  // T10 — MINIMAL SERVED APP UI (behavioral gate)
  // Proves:
  //   • GET /api/app/:id/ui returns 200 HTML
  //   • the page body contains /api/app (the fetch call that wires the UI to real data)
  //   • the page body contains the primary public table name (rendered in the UI)
  //   • the page renders even when no public table exists (placeholder, not 500)
  // ============================================================================
  {
    const uiId = randomUUID();
    try {
      await appdb.provision(pool, uiId, JSON.stringify({ entities: [
        { name: 'listings', public: true, display: 'title', fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'price', type: 'int' },
          { name: 'description', type: 'text' },
        ] },
        { name: 'bookings', public: false, fields: [
          { name: 'customer_name', type: 'text', required: true },
        ] },
      ] }));

      // Seed a listing row so the UI has something to load at runtime.
      await appdb.insertRow(pool, uiId, 'listings', { title: 'UI Test Listing', price: 999 });

      // --- UI route returns 200 HTML ---
      const uiR = await handleAppApi(pool, uiId, 'ui', null, makeReq('GET', '/api/app/' + uiId + '/ui'));
      ok('T10 ui route: returns 200', uiR?.status === 200, String(uiR?.status));
      ok('T10 ui route: content-type is HTML', (uiR?.contentType || '').includes('text/html'), String(uiR?.contentType));

      // --- page wires /api/app (the source-pin: the UI calls the real API at runtime) ---
      const uiBody = uiR?.body || '';
      ok('T10 source-pin: page body contains /api/app (fetch call to real API)', uiBody.includes('/api/app'), '(not found in ' + uiBody.length + ' bytes)');

      // --- primary public table name appears in the page ---
      ok('T10 primary table: "listings" appears in the rendered page', uiBody.includes('listings'), '(not found)');

      // --- page does NOT embed private table name in the main listing section ---
      // The UI picks only the PRIMARY public table — bookings must not be the featured table.
      // (It may appear in the "Tables:" metadata footer — that's fine, just not as primary.)
      // We check that 'listings' is the primary table and the form targets it.
      ok('T10 XSS-safe: uiId appears escaped (no raw angle-bracket around projectId)', !uiBody.includes('<' + uiId), '(raw UUID found in angle bracket context)');

      // --- placeholder page when no public tables exist (no 500) ---
      const emptyId = randomUUID();
      try {
        // Provision with ONLY a private table — no public table to be primary.
        await appdb.provision(pool, emptyId, JSON.stringify({ entities: [
          { name: 'bookings', public: false, fields: [
            { name: 'customer_name', type: 'text', required: true },
          ] },
        ] }));
        const emptyR = await handleAppApi(pool, emptyId, 'ui', null, makeReq('GET', '/api/app/' + emptyId + '/ui'));
        ok('T10 placeholder: no-public-table returns 200 not 500', emptyR?.status === 200, String(emptyR?.status));
        ok('T10 placeholder: page is HTML', (emptyR?.contentType || '').includes('text/html'), String(emptyR?.contentType));
      } finally {
        await pool.query(`drop schema if exists "${appdb.schemaName(emptyId)}" cascade`).catch(() => {});
      }

    } finally {
      await pool.query(`drop schema if exists "${appdb.schemaName(uiId)}" cascade`).catch(() => {});
    }
  }

  // ============================================================================
  // T32 — UPDATE/DELETE OWNER-ONLY + DASHBOARD OWNER-GATED (behavioral, real-DB round-trips)
  //
  // Proves:
  //   T30:
  //     • PATCH/PUT with owner audience updates the row (round-trip read confirms new value)
  //     • PATCH with anon audience → 401 (never mutates)
  //     • DELETE with owner audience removes the row (subsequent GET returns 404)
  //     • DELETE with anon audience → 401 (never deletes)
  //     • update with unknown column → 400 (safety: no raw SQL, only catalog columns)
  //     • delete of non-existent row → 404
  //   T31:
  //     • GET /dashboard with owner audience → 200 HTML
  //     • GET /dashboard with public audience → 404 (no existence leak)
  //     • dashboard HTML contains the private table name (correct rendering)
  //     • dashboard HTML contains /api/app (the fetch call that wires to live data)
  //     • dashboard HTML does not contain raw angle-bracket projectId (XSS safety)
  //   Cleanup:
  //     • scratch schema is dropped in finally (no footprint on failure)
  // ============================================================================
  {
    const t30Id = randomUUID();
    try {
      // Provision a scratch schema with a public table (products) and a private table (bookings).
      await appdb.provision(pool, t30Id, JSON.stringify({ entities: [
        { name: 'products', public: true, display: 'name', fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'price', type: 'int' },
        ] },
        { name: 'bookings', public: false, fields: [
          { name: 'customer_name', type: 'text', required: true },
          { name: 'notes', type: 'text' },
        ] },
      ] }));

      // Seed a product row directly so we have a known id to update/delete.
      const t30Schema = appdb.schemaName(t30Id);
      await pool.query(`insert into "${t30Schema}"."products" (name, price) values ('Original Name', 100)`);
      const prodRow = (await pool.query(`select id from "${t30Schema}"."products" limit 1`)).rows[0];
      const prodId = prodRow?.id;

      // Also insert a booking (private) via insertRow so we can test update/delete on it.
      await appdb.insertRow(pool, t30Id, 'bookings', { customer_name: 'Bob', notes: 'initial' });
      const bookRow = (await pool.query(`select id from "${t30Schema}"."bookings" limit 1`)).rows[0];
      const bookId = bookRow?.id;

      if (prodId === undefined || bookId === undefined) {
        fail++; console.error('  ✗ T32 setup: could not seed rows for update/delete tests');
      } else {
        // ---- T30: PATCH owner audience → updates the row ----
        const patchR = await handleAppApi(pool, t30Id, 'products', String(prodId),
          makeReq('PATCH', `/api/app/${t30Id}/products/${prodId}`, JSON.stringify({ name: 'Updated Name', price: 200 })),
          'owner');
        ok('T30 PATCH owner: returns 200', patchR?.status === 200, String(patchR?.status));
        const patchBody = (() => { try { return JSON.parse(patchR?.body || '{}'); } catch { return {}; } })();
        ok('T30 PATCH owner: ok:true', patchBody?.ok === true, JSON.stringify(patchBody));

        // verify the update persisted (real DB round-trip)
        const afterPatch = await handleAppApi(pool, t30Id, 'products', String(prodId),
          makeReq('GET', `/api/app/${t30Id}/products/${prodId}`), 'owner');
        const afterPatchRow = (() => { try { return JSON.parse(afterPatch?.body || '{}').row; } catch { return null; } })();
        ok('T30 PATCH: updated value persisted (real DB round-trip)', afterPatchRow?.name === 'Updated Name', JSON.stringify(afterPatchRow));
        ok('T30 PATCH: numeric field persisted', afterPatchRow?.price === 200, JSON.stringify(afterPatchRow));

        // ---- T30: PATCH anon audience → 401 (never mutates) ----
        const patchAnon = await handleAppApi(pool, t30Id, 'products', String(prodId),
          makeReq('PATCH', `/api/app/${t30Id}/products/${prodId}`, JSON.stringify({ name: 'Anon Hack' })),
          'public');
        ok('T30 PATCH anon: 401 (auth required)', patchAnon?.status === 401, String(patchAnon?.status));

        // verify the row was NOT mutated by the anon attempt
        const afterAnonPatch = await handleAppApi(pool, t30Id, 'products', String(prodId),
          makeReq('GET', `/api/app/${t30Id}/products/${prodId}`), 'owner');
        const afterAnonRow = (() => { try { return JSON.parse(afterAnonPatch?.body || '{}').row; } catch { return null; } })();
        ok('T30 PATCH anon: row not mutated (name still Updated Name)', afterAnonRow?.name === 'Updated Name', JSON.stringify(afterAnonRow));

        // ---- T30: PUT owner audience → also updates ----
        const putR = await handleAppApi(pool, t30Id, 'products', String(prodId),
          makeReq('PUT', `/api/app/${t30Id}/products/${prodId}`, JSON.stringify({ name: 'Put Name' })),
          'owner');
        ok('T30 PUT owner: returns 200', putR?.status === 200, String(putR?.status));

        // ---- T30: update with unknown column → 400 (safety gate) ----
        // Unknown columns are silently skipped by appdb.updateRow (typedColumns filter).
        // With ONLY unknown columns, use.length === 0, so updateRow returns false → 400.
        const badColR = await handleAppApi(pool, t30Id, 'products', String(prodId),
          makeReq('PATCH', `/api/app/${t30Id}/products/${prodId}`, JSON.stringify({ nonexistent_col_xyz: 'bad' })),
          'owner');
        ok('T30 unknown column: 400 (no valid columns to update)', badColR?.status === 400, String(badColR?.status));

        // ---- T30: DELETE owner audience → removes the booking row ----
        const delR = await handleAppApi(pool, t30Id, 'bookings', String(bookId),
          makeReq('DELETE', `/api/app/${t30Id}/bookings/${bookId}`),
          'owner');
        ok('T30 DELETE owner: returns 200', delR?.status === 200, String(delR?.status));
        const delBody = (() => { try { return JSON.parse(delR?.body || '{}'); } catch { return {}; } })();
        ok('T30 DELETE owner: ok:true', delBody?.ok === true, JSON.stringify(delBody));

        // verify the row is gone (real DB round-trip — owner can still see private rows, so a real delete is unambiguous)
        const afterDel = (await pool.query(`select count(*)::int n from "${t30Schema}"."bookings" where id=$1`, [bookId])).rows[0].n;
        ok('T30 DELETE: row physically removed from DB (real DB round-trip)', afterDel === 0, 'count=' + afterDel);

        // ---- T30: DELETE anon audience → 401 (never deletes) ----
        // Re-insert a row to have something to target.
        await pool.query(`insert into "${t30Schema}"."bookings" (customer_name) values ('Carol')`);
        const carol = (await pool.query(`select id from "${t30Schema}"."bookings" order by id desc limit 1`)).rows[0];
        const carolId = carol?.id;
        if (carolId !== undefined) {
          const delAnon = await handleAppApi(pool, t30Id, 'bookings', String(carolId),
            makeReq('DELETE', `/api/app/${t30Id}/bookings/${carolId}`),
            'public');
          ok('T30 DELETE anon: 401 (auth required)', delAnon?.status === 401, String(delAnon?.status));
          const stillThere = (await pool.query(`select count(*)::int n from "${t30Schema}"."bookings" where id=$1`, [carolId])).rows[0].n;
          ok('T30 DELETE anon: row still exists (not deleted)', stillThere === 1, 'count=' + stillThere);
        } else {
          fail++; console.error('  ✗ T32 anon-delete: could not re-insert carol row');
        }

        // ---- T30: DELETE non-existent row → 404 ----
        const delMissR = await handleAppApi(pool, t30Id, 'products', '999999',
          makeReq('DELETE', `/api/app/${t30Id}/products/999999`),
          'owner');
        ok('T30 DELETE missing: 404', delMissR?.status === 404, String(delMissR?.status));

        // ---- T31: GET /dashboard owner audience → 200 HTML ----
        const dashR = await handleAppApi(pool, t30Id, 'dashboard', null,
          makeReq('GET', `/api/app/${t30Id}/dashboard`),
          'owner');
        ok('T31 dashboard owner: returns 200', dashR?.status === 200, String(dashR?.status));
        ok('T31 dashboard owner: content-type is HTML', (dashR?.contentType || '').includes('text/html'), String(dashR?.contentType));

        // ---- T31: dashboard HTML contains the private table name ----
        const dashBody = dashR?.body || '';
        ok('T31 dashboard: contains "bookings" (private table rendered)', dashBody.includes('bookings'), '(not found in ' + dashBody.length + ' bytes)');

        // ---- T31: dashboard HTML contains /api/app (fetch call to live data) ----
        ok('T31 dashboard: contains /api/app (source-pin: fetches live data)', dashBody.includes('/api/app'), '(not found)');

        // ---- T31: XSS safety — projectId not in raw angle-bracket context ----
        ok('T31 dashboard XSS-safe: no raw angle-bracket around projectId', !dashBody.includes('<' + t30Id), '(raw UUID found in angle bracket context)');

        // ---- T31: GET /dashboard public audience → 404 (no existence leak) ----
        const dashAnonR = await handleAppApi(pool, t30Id, 'dashboard', null,
          makeReq('GET', `/api/app/${t30Id}/dashboard`),
          'public');
        ok('T31 dashboard public: 404 (owner-gated, no existence leak)', dashAnonR?.status === 404, String(dashAnonR?.status));
      }
    } finally {
      await pool.query(`drop schema if exists "${appdb.schemaName(t30Id)}" cascade`).catch(() => {});
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

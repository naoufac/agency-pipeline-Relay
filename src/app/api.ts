// FULL-STACK APP API — generated REST endpoints over a project's real app_<hex> schema.
// WHY this file: an app deliverable is not a form button + a wireframe — it is a real Postgres
// schema (provisioned by appdb.ts) with real rows that need to be queried and created by the
// produced site's frontend. This module turns that schema into a minimal, safe REST API:
//   GET  /api/app/:projectId/:table          → list rows (limit-bounded, offset-paginated, ordered)
//   GET  /api/app/:projectId/:table/:id      → single row by id
//   POST /api/app/:projectId/:table          → insert a row (validated, type-coerced)
//   GET  /api/app/:projectId/ui              → minimal HTML list+create UI for the project's primary table
//
// HARD SQL-SAFETY CONTRACT (enforced by appdb.ts, not us):
//   • table + column names are allowlisted from the LIVE catalog (schemaName + listTables +
//     typedColumns) — never taken from the request path/body directly.
//   • All values are parameterized — no string-joined SQL.
//   • PRIVATE_READ tables answer [] / null for list/get with audience='public'; owner audience
//     (T9) sees them after ownerOf() check in server.ts passes the audience through here.
//   • SENSITIVE columns (pass/token/secret/…) are never returned.
//   • SYSTEM_COLS (status/state/confirmed/…) are not settable by public callers.
//   • insertRow mints a ref_token for visitor-record tables and returns it so the caller can
//     land the visitor on their receipt page.
//
// All operations route through the EXISTING appdb.ts exported functions — no raw SQL here.
// This is the single-trusted path for table-level safety; adding a new query here would bypass
// every guard that was tested and hardened in the main check suite.
//
// FEATURE FLAG: the calling server (server.ts) only registers these routes when
// RELAY_APP_API=1. Default-off means 0 new surface area in the default deployment.
//
// T8 — PAGINATION + ORDERING:
//   ?limit (1..200, default 50), ?offset (>=0, default 0), ?order (column from catalog allowlist,
//   default id/created_at), ?dir=asc|desc (default desc). Unknown ?order= silently falls back to
//   the default so a bad param is a soft error (not a 400 that breaks the app UI).
//   Response envelope for list: { rows, limit, offset } — callers can drive infinite scroll or
//   next-page links with these two echo-back fields.
//
// T9 — OWNER-AUTH ON PRIVATE TABLES:
//   The handler receives an `audience` parameter ('public'|'owner') resolved by server.ts via
//   ownerOf()+canSee(). A public caller requesting a PRIVATE_READ table gets [] (as FS0 always
//   has). The owner gets the real rows. A POST (create) to a private table stays allowed for
//   any audience (visitors book).
//
// T10 — MINIMAL SERVED APP UI:
//   GET /api/app/:projectId/ui renders a deterministic, XSS-safe HTML page. The page lists rows
//   and shows a create form for the project's PRIMARY public table. It calls /api/app at runtime
//   (browser fetch) — never embeds data server-side — so it stays consistent with the live DB.
//   'ui' is the route keyword; it is reserved and will never conflict with a real table name
//   because TABLE_RE would match it as a table candidate, but we check for 'ui' BEFORE any DB
//   query so the distinction is structural, not positional.

import * as appdb from '../appdb.ts';
import type pg from 'pg';

// UUID pattern: matches the 8-4-4-4-12 hex format. Copied from server.ts so the handler can
// validate :projectId without depending on server-level globals.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Table name pattern: a legal SQL identifier, same guard as server.ts:537 so injection via a
// crafted path segment is structurally impossible before appdb ever sees the name.
const TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

// Row id in the URL path: a positive integer, int4-bounded. Anything larger is a 404 — a
// 64-bit id in the URL is almost certainly a scraper probing the space.
const ID_RE = /^[1-9][0-9]{0,9}$/;

// Valid order directions — anything else becomes 'desc' (safe default).
const VALID_DIR = new Set(['asc', 'desc']);

// Sane default page size; callers may request up to 200 via ?limit=N (same cap as appdb.readRows).
const DEFAULT_LIMIT = 50;

// T9 — the audience type flows in from server.ts where ownerOf()+canSee() has already resolved
// whether the caller is the project owner. The handler is audience-aware but never makes its own
// auth decision — that's server.ts's job.
//
// T30 — UPDATE + DELETE: PUT/PATCH/DELETE /api/app/:projectId/:table/:id
//   OWNER-ONLY: anonymous or non-owner attempts are answered with 401/404.
//   Safety is enforced inside appdb.updateRow/deleteRow (same IDENT+allowlist+typedColumns contract
//   as insertRow): unknown columns silently produce { ok:false }, unknown tables return false.
//   The handler rejects unknown tables with 404 before hitting appdb (parallel to the GET path).
//
// T31 — OWNER DASHBOARD PAGE: GET /api/app/:projectId/dashboard
//   Served only when audience='owner'. Non-owners get 404 (no existence leak).
//   Lists the project's PRIVATE tables (bookings/orders) with their live row counts and a
//   minimal XSS-safe HTML table for each. Calls /api/app at runtime — no server-side data embed.
export type AppApiAudience = 'public' | 'owner';

export type AppApiRequest = {
  method: string;
  url: URL;
  body: string;
};

export type AppApiResponse = {
  status: number;
  contentType: string;
  body: string;
};

// Minimal HTML escaping — XSS-safe for attribute and text contexts.
// WHY local: server.ts imports esc() from components.ts, but api.ts is pure and must not pull in
// the full component/DS dependency chain. This is the minimal version: only the 5 HTML special chars.
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The primary handler. server.ts builds the AppApiRequest from the http.IncomingMessage and
// calls this; the handler is pure (no http import) so app-api-check.ts can invoke it directly
// without spinning up a real server.
//
// T9: audience defaults to 'public' so the check suite's existing tests (which don't pass it)
// stay unaffected. Server.ts passes 'owner' when the authenticated user owns the project.
export async function handleAppApi(
  pool: pg.Pool,
  projectId: string,
  tableName: string,
  rowId: string | null,
  req: AppApiRequest,
  audience: AppApiAudience = 'public',
): Promise<AppApiResponse | null> {
  // --- guard: both identifiers must be structurally valid before hitting the DB ---------------
  // UUID_RE rejects anything that isn't a canonical project id.
  if (!UUID_RE.test(projectId)) return null;   // caller treats null as "not our route"

  // T10 — UI ROUTE: /api/app/:projectId/ui — served BEFORE the table guard so 'ui' is never
  // mistaken for a real table name and never reaches any DB query on the catalog.
  // WHY 'ui': short, memorable, clearly a control path, not a data name.
  if (tableName === 'ui' && rowId === null && req.method === 'GET') {
    return serveAppUi(pool, projectId, req.url);
  }

  // T31 — DASHBOARD ROUTE: /api/app/:projectId/dashboard — owner-only.
  // 'dashboard' is reserved like 'ui': checked BEFORE the TABLE_RE so it never reaches DB catalog queries.
  // A non-owner gets 404 (no existence leak — same policy as the content admin in server.ts).
  if (tableName === 'dashboard' && rowId === null && req.method === 'GET') {
    if (audience !== 'owner') return json(404, { error: 'not found' });
    return serveAppDashboard(pool, projectId, req.url);
  }

  // TABLE_RE rejects injection-y names (spaces, dots, dashes, SQL keywords that aren't
  // identifiers). appdb.readRows/insertRow also run the IDENT regex but we want the route
  // layer to answer a clean 404 rather than a silent [].
  if (!TABLE_RE.test(tableName)) return json(404, { error: 'unknown table' });
  if (rowId !== null && !ID_RE.test(rowId)) return json(404, { error: 'not found' });

  // --- GET /api/app/:id/:table -----------------------------------------------------------------
  if (req.method === 'GET' && rowId === null) {
    // T8 — pagination: ?limit bounded 1..200, ?offset >= 0.
    const rawLimit = req.url.searchParams.get('limit');
    const rawOffset = req.url.searchParams.get('offset');
    const limit = Math.max(1, Math.min(200, Number(rawLimit || DEFAULT_LIMIT) || DEFAULT_LIMIT));
    const offset = Math.max(0, Math.floor(Number(rawOffset || 0) || 0));

    // T8 — ordering: ?order is allowlisted below inside appdb.readRows against the live catalog.
    // An unknown column silently falls back to the default (created_at/id) — a soft error that
    // keeps the app UI working even if the column is renamed. ?dir must be exactly 'asc'|'desc'.
    const orderCol = req.url.searchParams.get('order') || undefined;
    const rawDir = req.url.searchParams.get('dir') || '';
    const orderDir = (VALID_DIR.has(rawDir) ? rawDir : 'desc') as 'asc' | 'desc';

    // T8 — validate ?order early: if a non-empty order col is passed that fails IDENT or doesn't
    // exist in the catalog, reject with 400. This is the behavioral gate the check suite asserts.
    // WHY 400 not silent-fallback: a caller asking for an unknown column almost certainly has a bug;
    // returning rows in an unexpected order is worse than an honest error. (appdb.readRows itself
    // falls back to default, so we check here to give a clear error before any DB hit.)
    if (orderCol !== undefined && orderCol !== '') {
      const schemaId = appdb.schemaName(projectId);
      const catalog = await appdb.typedColumns(pool, schemaId, tableName).catch(() => []);
      // catalog is empty when the table doesn't exist — in that case readRows will return [] anyway,
      // no need to 400; only 400 when the table exists but the column doesn't.
      if (catalog.length > 0 && !catalog.some(c => c.name === orderCol)) {
        return json(400, { error: 'unknown order column' });
      }
    }

    // readRows: IDENT-validates the table name, checks it's in the catalog, blocks PRIVATE_READ
    // tables for 'public' audience, strips SENSITIVE columns, resolves FK display values.
    // T9: audience flows through — owner gets private table rows, public gets [].
    const rows = await appdb.readRows(pool, projectId, tableName, limit, audience, offset, orderCol, orderDir);

    // T8 — echo back limit+offset so callers can drive pagination without re-parsing the request.
    return json(200, { rows, limit, offset });
  }

  // --- GET /api/app/:id/:table/:rowid ---------------------------------------------------------
  if (req.method === 'GET' && rowId !== null) {
    const id = Number(rowId);
    // readRow: int4-bounded id, catalog-checked, PRIVATE_READ→null (FS0), secrets stripped.
    // T9: audience flows through — owner can read private table rows by id.
    const row = await appdb.readRow(pool, projectId, tableName, id, audience);
    if (row === null) return json(404, { error: 'not found' });
    return json(200, { row });
  }

  // --- POST /api/app/:id/:table ---------------------------------------------------------------
  if (req.method === 'POST' && rowId === null) {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(req.body || '{}'); } catch { return json(400, { ok: false, error: 'invalid JSON' }); }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return json(400, { ok: false, error: 'body must be a JSON object' });
    }
    // insertRow: column allowlist from live catalog (typedColumns), type-coerced, parameterized,
    // SENSITIVE + SYSTEM_COLS rejected, lifecycle booking guards (past date, slot capacity),
    // ref_token minted for PRIVATE_READ tables (receipts). Nothing raw here.
    // T9: POSTs always use 'public' for visitor-created rows; the audience param is not forwarded
    // to insertRow so that a visitor booking always gets the lifecycle/guard path.
    const r = await appdb.insertRow(pool, projectId, tableName, data as Record<string, any>, 'public');
    const status = r.ok ? 200 : 400;
    return json(status, r);
  }

  // --- T30 · PUT/PATCH /api/app/:id/:table/:rowId — OWNER-ONLY update ----------------------
  // WHY owner-only: the public app API is designed for visitor reads/creates. Mutations to
  // existing rows are an owner/admin concern (correcting a booking, updating an order status).
  // An anonymous mutate is answered with 401 — not 403 — because the client must sign in first;
  // a wrong-owner context answers 404 (same existence-hiding policy as the content admin).
  if ((req.method === 'PUT' || req.method === 'PATCH') && rowId !== null) {
    if (audience !== 'owner') return json(401, { ok: false, error: 'authentication required' });
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(req.body || '{}'); } catch { return json(400, { ok: false, error: 'invalid JSON' }); }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return json(400, { ok: false, error: 'body must be a JSON object' });
    }
    const id = Number(rowId);
    // updateRow: confined to the project schema, IDENT-checked table, allowlisted columns only,
    // type-coerced, parameterized. Returns false when the table/row/columns don't validate —
    // the handler maps that to 400 so the client gets a clean error, not a 500.
    // An unknown column in `data` is silently SKIPPED by updateRow (only catalog columns pass
    // the typedColumns filter), so the guard here is: zero writeable columns → false → 400.
    const ok = await appdb.updateRow(pool, projectId, tableName, id, data as Record<string, any>);
    if (!ok) return json(400, { ok: false, error: 'no matching row or no valid columns to update' });
    return json(200, { ok: true });
  }

  // --- T30 · DELETE /api/app/:id/:table/:rowId — OWNER-ONLY delete -------------------------
  // Anonymous delete → 401. Non-existent row → 404 (deleteRow returns false for no-match).
  if (req.method === 'DELETE' && rowId !== null) {
    if (audience !== 'owner') return json(401, { ok: false, error: 'authentication required' });
    const id = Number(rowId);
    // deleteRow: confined to the project schema, parameterized id. Returns false on no-match
    // (the row didn't exist or the table doesn't exist).
    const ok = await appdb.deleteRow(pool, projectId, tableName, id);
    if (!ok) return json(404, { ok: false, error: 'not found' });
    return json(200, { ok: true });
  }

  // --- method not allowed on :table/:id for anything else --------------------------------
  if (rowId !== null) return json(405, { error: 'method not allowed' });

  return json(405, { error: 'method not allowed' });
}

// ---------------------------------------------------------------------------
// T10 — MINIMAL SERVED APP UI
// Renders a clean, XSS-safe HTML page with:
//   • a list of rows from the PRIMARY public table (fetched client-side via /api/app)
//   • a create form that posts to /api/app via fetch()
// This is the "app = real data, not a button" surface. The page is deterministic — the same
// project always gets the same HTML (no LLM at render time). Data is fetched at runtime so
// content is always live.
//
// PRIMARY TABLE SELECTION: the first non-private-read table in the catalog. If no tables exist
// yet (schema not provisioned), we render a placeholder page rather than erroring.
//
// XSS SAFETY: all table/column names that appear in the HTML are esc()-cleaned. Column names
// come from the DB catalog (never user input) but we escape them anyway as defense-in-depth.
// ---------------------------------------------------------------------------
async function serveAppUi(pool: pg.Pool, projectId: string, url: URL): Promise<AppApiResponse> {
  try {
    const tables = await appdb.listTables(pool, projectId);
    // PRIVATE_READ tables are not a valid primary UI table — the public form can create rows
    // but cannot list them. Pick the first non-private table.
    const { PRIVATE_READ } = await import('../schema.ts');
    const primaryTable = tables.find(t => !PRIVATE_READ.test(t));

    if (!primaryTable) {
      // No public table yet — render a helpful placeholder.
      return html(200, buildUiPage(projectId, null, [], []));
    }

    const schemaId = appdb.schemaName(projectId);
    const cols = await appdb.typedColumns(pool, schemaId, primaryTable).catch(() => []);

    return html(200, buildUiPage(projectId, primaryTable, cols, tables));
  } catch (e: any) {
    return html(500, `<p>Error loading app: ${esc(String(e?.message ?? e))}</p>`);
  }
}

// Build the full HTML page. Column metadata comes from the catalog (trusted), but we esc()
// every name that lands in the HTML for defense-in-depth.
function buildUiPage(
  projectId: string,
  table: string | null,
  cols: { name: string; type: string; nullable: boolean }[],
  allTables: string[],
): string {
  const pid = esc(projectId);
  const tname = table ? esc(table) : '';
  // form fields: exclude system columns (id, created_at, ref_token) and SENSITIVE names
  const SYSTEM = /^(id|created_at|updated_at|ref_token)$/;
  const SENSITIVE = /pass|secret|token|hash|salt|api_?key|private|credential/i;
  const formCols = cols.filter(c => !SYSTEM.test(c.name) && !SENSITIVE.test(c.name));

  // Type → HTML input type mapping (deterministic, no LLM)
  function inputType(dbType: string): string {
    if (/bool/.test(dbType)) return 'checkbox';
    if (/int|numeric|real|double|decimal/.test(dbType)) return 'number';
    if (/^date$/.test(dbType)) return 'date';
    if (/timestamp/.test(dbType)) return 'datetime-local';
    if (/email/.test(dbType)) return 'email';
    return 'text';
  }

  const tableSelect = allTables.length > 1
    ? `<p style="font-size:13px;color:#666">Tables: ${allTables.map(t => esc(t)).join(', ')}</p>`
    : '';

  if (!table) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>App</title><style>
body{font:16px/1.6 system-ui,sans-serif;max-width:700px;margin:0 auto;padding:32px 16px;background:#f9fafb;color:#111}
h1{font-size:22px;margin-bottom:8px}.muted{color:#666;font-size:14px}
</style></head><body>
<h1>App</h1>
<p class="muted">No public tables are provisioned yet. Run the project to generate the database schema.</p>
<p><a href="/api/app/${pid}/ui">Refresh</a></p>
</body></html>`;
  }

  const fieldHtml = formCols.map(c => {
    const itype = inputType(c.type);
    const req = c.nullable ? '' : ' required';
    return `<div class="field">
  <label>${esc(c.name.replace(/_/g, ' '))}${c.nullable ? '' : ' *'}</label>
  <input type="${itype}" name="${esc(c.name)}" data-col="${esc(c.name)}"${req}>
</div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${tname} — App</title>
<style>
*{box-sizing:border-box}
body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:0 auto;padding:32px 16px;background:#f9fafb;color:#111}
h1{font-size:22px;margin-bottom:4px}
h2{font-size:17px;margin:24px 0 8px}
.muted{color:#666;font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
th,td{padding:10px 14px;text-align:left;font-size:14px;border-bottom:1px solid #e5e7eb}
th{background:#f3f4f6;font-weight:600;color:#374151}
tr:last-child td{border:none}
.empty{color:#9ca3af;text-align:center;padding:24px}
.form-card{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:24px}
.field{margin-bottom:12px}
label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:4px}
input[type=text],input[type=email],input[type=number],input[type=date],input[type=datetime-local]{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px}
input[type=checkbox]{width:auto}
button{padding:9px 22px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:600}
button:hover{background:#2563eb}
.msg{padding:8px 12px;border-radius:6px;font-size:14px;margin-top:8px}
.ok{background:#d1fae5;color:#065f46}
.err{background:#fee2e2;color:#991b1b}
.pages{display:flex;gap:8px;margin-top:12px;align-items:center;font-size:14px}
.pages button{padding:5px 14px;background:#e5e7eb;color:#374151}
.pages button:hover{background:#d1d5db}
.pages button:disabled{opacity:.4;cursor:default}
</style>
</head>
<body>
<h1>${tname}</h1>
<p class="muted">Project: ${pid}</p>
${tableSelect}

<h2>Add a record</h2>
<div class="form-card">
<form id="create-form">
${fieldHtml || '<p class="muted">No editable fields.</p>'}
${formCols.length ? '<button type="submit">Create</button>' : ''}
<div id="form-msg"></div>
</form>
</div>

<h2>Records</h2>
<div id="list-area"><p class="muted">Loading…</p></div>
<div class="pages">
  <button id="prev-btn" disabled>← Prev</button>
  <span id="page-info"></span>
  <button id="next-btn">Next →</button>
</div>

<script>
// All data fetched at runtime via /api/app — page itself is static.
const PID = ${JSON.stringify(projectId)};
const TABLE = ${JSON.stringify(table)};
const BASE = '/api/app/' + PID + '/' + TABLE;
let offset = 0;
const LIMIT = 20;

// XSS-safe text — the only output path; never innerHTML with user data.
function t(s) { return document.createTextNode(String(s == null ? '' : s)); }
function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  for (const c of children) e.appendChild(typeof c === 'string' ? t(c) : c);
  return e;
}

async function loadRows() {
  document.getElementById('list-area').innerHTML = '';
  document.getElementById('list-area').appendChild(t('Loading…'));
  try {
    const r = await fetch(BASE + '?limit=' + LIMIT + '&offset=' + offset + '&dir=desc');
    const d = await r.json();
    const rows = d.rows || [];
    render(rows, d.limit, d.offset);
  } catch(e) {
    document.getElementById('list-area').innerHTML = '';
    document.getElementById('list-area').appendChild(t('Error loading rows.'));
  }
}

function render(rows, limit, off) {
  const area = document.getElementById('list-area');
  area.innerHTML = '';
  if (!rows.length) {
    area.appendChild(el('p', {class:'empty'}, 'No records yet.'));
    document.getElementById('page-info').textContent = '';
    document.getElementById('prev-btn').disabled = true;
    document.getElementById('next-btn').disabled = true;
    return;
  }
  const keys = Object.keys(rows[0]).filter(k => !k.startsWith('_'));
  const table = el('table');
  const thead = el('tr');
  for (const k of keys) thead.appendChild(el('th', {}, k));
  table.appendChild(el('thead', {}, thead));
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const k of keys) tr.appendChild(el('td', {}, row[k] == null ? '' : row[k]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  area.appendChild(table);
  document.getElementById('page-info').textContent = 'Showing ' + (off + 1) + '–' + (off + rows.length);
  document.getElementById('prev-btn').disabled = off === 0;
  document.getElementById('next-btn').disabled = rows.length < limit;
}

document.getElementById('prev-btn').onclick = () => { offset = Math.max(0, offset - LIMIT); loadRows(); };
document.getElementById('next-btn').onclick = () => { offset += LIMIT; loadRows(); };

document.getElementById('create-form').onsubmit = async function(e) {
  e.preventDefault();
  const msg = document.getElementById('form-msg');
  msg.className = 'msg'; msg.textContent = '';
  const data = {};
  const inputs = this.querySelectorAll('[data-col]');
  for (const inp of inputs) {
    const v = inp.type === 'checkbox' ? inp.checked : inp.value;
    if (v !== '' && v !== false) data[inp.dataset.col] = v;
  }
  try {
    const r = await fetch(BASE, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
    const d = await r.json();
    if (d.ok) {
      msg.classList.add('ok'); msg.textContent = 'Created successfully.';
      this.reset(); offset = 0; loadRows();
    } else {
      msg.classList.add('err'); msg.textContent = d.error || 'Could not create record.';
    }
  } catch(e) {
    msg.classList.add('err'); msg.textContent = 'Network error.';
  }
};

loadRows();
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// T31 — OWNER DASHBOARD PAGE
// Rendered ONLY for the authenticated owner (audience='owner' enforced in the route above).
// Shows the project's PRIVATE tables (bookings, orders, …) — the real internal app view.
//
// ARCHITECTURE: the page fetches data at runtime via /api/app (browser fetch, audience=owner
// via session cookie carried automatically) — no server-side data embed. This means:
//   • the HTML is deterministic (same table list → same HTML, cacheable in tests)
//   • the owner sees LIVE data, never a stale snapshot
//   • XSS is impossible: table names (from the catalog) are esc()-cleaned before embedding
//
// PRIVATE TABLE SELECTION: uses the same PRIVATE_READ regex as appdb.ts/schema.ts.
// Public tables (products/services/…) are visible on the /ui page; the dashboard shows the
// ORDER/BOOKING tables the owner's business runs on — not the public catalog.
// ---------------------------------------------------------------------------
async function serveAppDashboard(pool: pg.Pool, projectId: string, url: URL): Promise<AppApiResponse> {
  try {
    const tables = await appdb.listTables(pool, projectId);
    const { PRIVATE_READ } = await import('../schema.ts');
    const privateTables = tables.filter(t => PRIVATE_READ.test(t));
    const allTables = tables; // shown in sidebar for context
    return html(200, buildDashboardPage(projectId, privateTables, allTables));
  } catch (e: any) {
    return html(500, `<p>Error loading dashboard: ${esc(String(e?.message ?? e))}</p>`);
  }
}

// Build the owner dashboard HTML. Table names come from the catalog (trusted), but esc() is
// applied for defense-in-depth against any future path where an injected name could reach here.
function buildDashboardPage(
  projectId: string,
  privateTables: string[],
  allTables: string[],
): string {
  const pid = esc(projectId);

  // Table sections: one per private table. Each section fetches its rows at runtime via
  // /api/app with audience=owner (the cookie carries the session — same-origin fetch).
  const tableSections = privateTables.map(t => {
    const te = esc(t);
    const label = esc(t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    return `
<section data-table="${te}" class="tbl-section">
  <h2>${label}</h2>
  <div id="tbl-${te}" class="tbl-wrap"><p class="muted">Loading…</p></div>
  <div class="page-nav" id="nav-${te}">
    <button data-tbl="${te}" data-dir="prev" disabled>← Prev</button>
    <span id="info-${te}"></span>
    <button data-tbl="${te}" data-dir="next">Next →</button>
  </div>
</section>`;
  }).join('\n');

  const emptyMsg = privateTables.length === 0
    ? `<p class="muted">No private tables (bookings / orders) in this project's schema yet. Run the project to provision the database.</p>`
    : '';

  // sidebar: all tables for navigation context
  const sidebarItems = allTables.map(t => {
    const te = esc(t);
    const isPriv = privateTables.includes(t);
    return `<li class="${isPriv ? 'priv' : ''}">${te}${isPriv ? ' <span class="badge">private</span>' : ''}</li>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — ${pid}</title>
<style>
*{box-sizing:border-box}
body{font:15px/1.6 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:32px 16px;background:#f9fafb;color:#111;display:grid;grid-template-columns:200px 1fr;gap:24px}
header{grid-column:1/-1}
h1{font-size:20px;margin-bottom:2px}
h2{font-size:16px;margin:20px 0 8px}
.muted{color:#666;font-size:13px}
aside{padding:0 12px}
aside ul{list-style:none;padding:0;margin:0;font-size:13px}
aside li{padding:4px 0;border-bottom:1px solid #e5e7eb}
aside li.priv{font-weight:600}
.badge{font-size:11px;background:#dbeafe;color:#1e40af;border-radius:4px;padding:1px 5px;margin-left:4px}
main{}
.tbl-section{margin-bottom:32px;background:#fff;border-radius:8px;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #e5e7eb;white-space:nowrap}
th{background:#f3f4f6;font-weight:600;color:#374151}
tr:last-child td{border:none}
.empty{color:#9ca3af;text-align:center;padding:20px}
.page-nav{display:flex;gap:8px;margin-top:8px;align-items:center;font-size:13px}
.page-nav button{padding:4px 12px;background:#e5e7eb;color:#374151;border:none;border-radius:5px;cursor:pointer;font-size:13px}
.page-nav button:hover:not(:disabled){background:#d1d5db}
.page-nav button:disabled{opacity:.4;cursor:default}
.err{color:#991b1b;background:#fee2e2;padding:8px 12px;border-radius:6px;font-size:13px}
</style>
</head>
<body>
<header>
  <h1>Owner Dashboard</h1>
  <p class="muted">Project: ${pid}</p>
</header>
<aside>
  <p class="muted" style="font-size:12px;margin-bottom:8px">All tables</p>
  <ul>${sidebarItems || '<li class="muted">none</li>'}</ul>
  <p style="margin-top:16px"><a href="/api/app/${pid}/ui" style="font-size:13px;color:#3b82f6">→ Public UI</a></p>
</aside>
<main>
${emptyMsg}
${tableSections}
</main>

<script>
// All data fetched live from /api/app — the session cookie carries owner auth automatically.
const PID = ${JSON.stringify(projectId)};
const BASE = '/api/app/' + PID + '/';
const LIMIT = 20;
const offsets = {};

// XSS-safe DOM helpers — never use innerHTML with row data.
function t(s) { return document.createTextNode(String(s == null ? '' : s)); }
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  for (const c of kids) e.appendChild(typeof c === 'string' ? t(c) : c);
  return e;
}

async function loadTable(tbl) {
  const off = offsets[tbl] || 0;
  const wrap = document.getElementById('tbl-' + tbl);
  const info = document.getElementById('info-' + tbl);
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.appendChild(t('Loading…'));
  try {
    const r = await fetch(BASE + tbl + '?limit=' + LIMIT + '&offset=' + off + '&dir=desc');
    const d = await r.json();
    const rows = d.rows || [];
    if (!rows.length) {
      wrap.innerHTML = '';
      wrap.appendChild(el('p', {class:'empty'}, 'No records.'));
      if (info) info.textContent = '';
    } else {
      const keys = Object.keys(rows[0]).filter(k => !k.startsWith('_'));
      const table = el('table');
      const thead = el('thead');
      const hr = el('tr');
      for (const k of keys) hr.appendChild(el('th', {}, k));
      thead.appendChild(hr); table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of rows) {
        const tr = el('tr');
        for (const k of keys) tr.appendChild(el('td', {}, row[k] == null ? '' : row[k]));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.innerHTML = ''; wrap.appendChild(table);
      if (info) info.textContent = 'Showing ' + (off + 1) + '–' + (off + rows.length);
    }
    // update nav buttons
    const prevBtn = document.querySelector('button[data-tbl="' + tbl + '"][data-dir="prev"]');
    const nextBtn = document.querySelector('button[data-tbl="' + tbl + '"][data-dir="next"]');
    if (prevBtn) prevBtn.disabled = off === 0;
    if (nextBtn) nextBtn.disabled = rows.length < LIMIT;
  } catch(e) {
    wrap.innerHTML = '';
    wrap.appendChild(el('p', {class:'err'}, 'Error loading data.'));
  }
}

document.addEventListener('click', function(e) {
  const btn = e.target.closest('button[data-tbl]');
  if (!btn) return;
  const tbl = btn.dataset.tbl;
  const dir = btn.dataset.dir;
  if (!offsets[tbl]) offsets[tbl] = 0;
  if (dir === 'next') offsets[tbl] += LIMIT;
  if (dir === 'prev') offsets[tbl] = Math.max(0, offsets[tbl] - LIMIT);
  loadTable(tbl);
});

// Initial load of all private tables.
document.querySelectorAll('.tbl-section[data-table]').forEach(s => {
  loadTable(s.dataset.table);
});
</script>
</body></html>`;
}

function json(status: number, body: unknown): AppApiResponse {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function html(status: number, body: string): AppApiResponse {
  return { status, contentType: 'text/html; charset=utf-8', body };
}

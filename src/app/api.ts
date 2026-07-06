// FULL-STACK APP API — generated REST endpoints over a project's real app_<hex> schema.
// WHY this file: an app deliverable is not a form button + a wireframe — it is a real Postgres
// schema (provisioned by appdb.ts) with real rows that need to be queried and created by the
// produced site's frontend. This module turns that schema into a minimal, safe REST API:
//   GET  /api/app/:projectId/:table          → list rows (limit-bounded, public-safe)
//   GET  /api/app/:projectId/:table/:id      → single row by id
//   POST /api/app/:projectId/:table          → insert a row (validated, type-coerced)
//
// HARD SQL-SAFETY CONTRACT (enforced by appdb.ts, not us):
//   • table + column names are allowlisted from the LIVE catalog (schemaName + listTables +
//     typedColumns) — never taken from the request path/body directly.
//   • All values are parameterized — no string-joined SQL.
//   • PRIVATE_READ tables answer [] / null for list/get exactly as if they don't exist (FS0).
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

// Sane default page size; callers may request up to 200 via ?limit=N (same cap as appdb.readRows).
const DEFAULT_LIMIT = 50;

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

// The primary handler. server.ts builds the AppApiRequest from the http.IncomingMessage and
// calls this; the handler is pure (no http import) so app-api-check.ts can invoke it directly
// without spinning up a real server.
export async function handleAppApi(
  pool: pg.Pool,
  projectId: string,
  tableName: string,
  rowId: string | null,
  req: AppApiRequest,
): Promise<AppApiResponse | null> {
  // --- guard: both identifiers must be structurally valid before hitting the DB ---------------
  // UUID_RE rejects anything that isn't a canonical project id.
  if (!UUID_RE.test(projectId)) return null;   // caller treats null as "not our route"
  // TABLE_RE rejects injection-y names (spaces, dots, dashes, SQL keywords that aren't
  // identifiers). appdb.readRows/insertRow also run the IDENT regex but we want the route
  // layer to answer a clean 404 rather than a silent [].
  if (!TABLE_RE.test(tableName)) return json(404, { error: 'unknown table' });
  if (rowId !== null && !ID_RE.test(rowId)) return json(404, { error: 'not found' });

  // --- GET /api/app/:id/:table -----------------------------------------------------------------
  if (req.method === 'GET' && rowId === null) {
    const limit = Math.max(1, Math.min(200, Number(req.url.searchParams.get('limit') || DEFAULT_LIMIT) || DEFAULT_LIMIT));
    // readRows: IDENT-validates the table name, checks it's in the catalog, blocks PRIVATE_READ
    // tables for 'public' audience, strips SENSITIVE columns, resolves FK display values.
    const rows = await appdb.readRows(pool, projectId, tableName, limit, 'public');
    return json(200, { rows });
  }

  // --- GET /api/app/:id/:table/:rowid ---------------------------------------------------------
  if (req.method === 'GET' && rowId !== null) {
    const id = Number(rowId);
    // readRow: int4-bounded id, catalog-checked, PRIVATE_READ→null (FS0), secrets stripped.
    const row = await appdb.readRow(pool, projectId, tableName, id, 'public');
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
    const r = await appdb.insertRow(pool, projectId, tableName, data as Record<string, any>, 'public');
    const status = r.ok ? 200 : 400;
    return json(status, r);
  }

  // --- method not allowed on :table/:id (no PUT/DELETE in the public API) --------------------
  if (rowId !== null) return json(405, { error: 'method not allowed' });

  return json(405, { error: 'method not allowed' });
}

function json(status: number, body: unknown): AppApiResponse {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

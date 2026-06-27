// LIVE per-project database — the leap from "ships a schema file" to "the app runs on a real DB".
// Each project's tables live in their OWN Postgres schema `app_<hex>`, NEVER `public`. Every operation
// is namespace-isolated, identifier-validated, and parameterized, so a produced app's data model is real
// and queryable while the engine's tables (public) can never be touched. This is the safety contract:
// the only schema we ever create/drop/write is `app_<32hex>` derived from the project UUID.
import pg from 'pg';

const IDENT = /^[a-z_][a-z0-9_]*$/;            // a legal, safe SQL identifier (no quoting tricks)

// app_<32 hex of the project uuid>. Throws on anything that wouldn't be exactly this — so we can NEVER
// accidentally operate on `public`, an empty name, or an injected identifier.
export function schemaName(projectId: string): string {
  const hex = String(projectId || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  if (hex.length < 16) throw new Error('appdb: refusing — project id too short to namespace: ' + projectId);
  const name = 'app_' + hex.slice(0, 32);
  if (!/^app_[a-f0-9]{16,32}$/.test(name)) throw new Error('appdb: bad schema name ' + name);
  return name;
}

const stripFences = (s: string) => s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
function sqlBody(content: string): string { const s = stripFences(content); const at = s.search(/create\s+table/i); return at >= 0 ? s.slice(at) : s; }

// Reject any DDL that could escape the project's schema or touch the engine. Generated app DDL never
// legitimately references another schema or session settings — so blocking these is free safety.
function assertConfined(ddl: string) {
  const lower = ddl.toLowerCase();
  for (const bad of ['public.', 'pg_catalog', 'pg_class', 'information_schema', 'search_path', 'set role', 'set session', 'create schema', 'drop schema', 'drop database', 'alter system', '\\connect', 'dblink', 'copy ', 'pg_read', 'pg_sleep'])
    if (lower.includes(bad)) throw new Error('appdb: schema DDL contains a disallowed construct: ' + bad.trim());
}

// Provision the project's schema FOR REAL: drop+recreate its isolated namespace and apply the DDL (+ any
// seed INSERTs) inside it. Idempotent — a rebuild re-provisions cleanly. Returns the tables that now exist.
export async function provision(pool: pg.Pool, projectId: string, content: string): Promise<{ schema: string; tables: string[] }> {
  const schema = schemaName(projectId);
  const ddl = sqlBody(content);
  if (!/create\s+table/i.test(ddl)) throw new Error('appdb: no CREATE TABLE in the schema output');
  assertConfined(ddl);
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`drop schema if exists "${schema}" cascade`);   // only ever app_<hex> — never public
    await c.query(`create schema "${schema}"`);
    await c.query(`set local search_path to "${schema}"`);         // unqualified CREATE/INSERT land HERE; tx-scoped
    await c.query(ddl);
    await c.query('commit');
  } catch (e) { try { await c.query('rollback'); } catch {} throw e; }
  finally { c.release(); }
  return { schema, tables: await listTables(pool, projectId) };
}

export async function listTables(pool: pg.Pool, projectId: string): Promise<string[]> {
  const schema = schemaName(projectId);
  const r = await pool.query(
    "select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE' order by table_name", [schema]);
  return r.rows.map((x: any) => x.table_name);
}

async function columns(pool: pg.Pool, schema: string, table: string): Promise<string[]> {
  const r = await pool.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2', [schema, table]);
  return r.rows.map((x: any) => x.column_name);
}

// Read rows from a REAL project table (validated against the schema's own catalog; never arbitrary SQL).
export async function readRows(pool: pg.Pool, projectId: string, table: string, limit = 50): Promise<any[]> {
  const schema = schemaName(projectId);
  if (!IDENT.test(table)) return [];
  const tables = await listTables(pool, projectId);
  if (!tables.includes(table)) return [];
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const r = await pool.query(`select * from "${schema}"."${table}" limit ${lim}`);
  return r.rows;
}

// Insert one row into a REAL project table — only into columns that actually exist, fully parameterized.
export async function insertRow(pool: pg.Pool, projectId: string, table: string, data: Record<string, any>): Promise<boolean> {
  const schema = schemaName(projectId);
  if (!IDENT.test(table)) return false;
  const tables = await listTables(pool, projectId);
  if (!tables.includes(table)) return false;
  const cols = (await columns(pool, schema, table)).filter(col => col in (data || {}) && IDENT.test(col) && col !== 'id' && col !== 'created_at');
  if (!cols.length) return false;
  const vals = cols.map((_, i) => '$' + (i + 1));
  await pool.query(`insert into "${schema}"."${table}" (${cols.map(c => `"${c}"`).join(',')}) values (${vals.join(',')})`,
    cols.map(col => data[col]));
  return true;
}

// rowmedia.ts (PQ agency-grade) — real photos on DB-backed cards. The build-time media pass only
// fills static <img data-q> tags, but product/collection/feed cards render CLIENT-SIDE from DB rows
// that carry no image — so every catalog grid was text-on-white. This enriches each content row with
// a locally-cached, on-topic Pexels photo, ONCE at build time (deterministic, cached by a stable hash
// of the query, byte-stable across rebuilds, no LLM). readRows then attaches `_image` when the cached
// file exists, so the existing client card loaders render it with zero client changes.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { mediaReady, pexelsPhoto } from './media.ts';

// self-contained sites dir (avoid an import cycle through verify.ts, which imports appdb)
const SITES = new URL('../sites/', import.meta.url);
const IMG_COL = /image|photo|cover|thumb|picture|avatar|banner|logo/i;
const MAX_ROWS = 24;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// FNV-1a — stable, dependency-free. Same query → same cached file forever (reproducible).
function hash(s: string): string { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }

// The search phrase for a row: its human display value (product/category name). Descriptive product
// names ("Terracotta Mug with Handle") are already great queries; fall back to the table noun.
export function rowQuery(table: string, row: any): string {
  const disp = ['title', 'name', 'label', 'headline'].map(k => row?.[k]).find(v => typeof v === 'string' && v.trim());
  const base = String(disp || table.replace(/_/g, ' ')).trim().toLowerCase().slice(0, 60);
  return base || table;
}
const assetRel = (query: string) => `assets/row-${hash(query)}.jpg`;

// The absolute served path of a row's cached image IF it exists on disk (else null). Pure + sync — safe
// to call from readRows on every request (no network). Absolute (/sites/…) so the client card loaders,
// which only render values starting with http/'/', pick it up.
export function localRowImage(projectId: string, table: string, row: any): string | null {
  // an already-populated real image column wins (owner-set URL, etc.)
  for (const k of Object.keys(row || {})) if (IMG_COL.test(k) && typeof row[k] === 'string' && (/^https?:/.test(row[k]) || row[k].charAt(0) === '/')) return null;
  const rel = assetRel(rowQuery(table, row));
  const abs = fileURLToPath(new URL(projectId + '/' + rel, SITES));
  return existsSync(abs) ? '/sites/' + projectId + '/' + rel : null;
}

// BUILD-TIME enrichment: for every catalog-style content table, download a real photo per row (cached
// by query hash so each is fetched exactly once), and — if the table has an empty image column — bake
// the local path into the row. Bounded + best-effort; a failed fetch just leaves that row image-less.
export async function enrichRowImages(pool: pg.Pool, projectId: string, tables: { table: string; display: string }[]): Promise<{ fetched: number }> {
  if (!mediaReady()) return { fetched: 0 };
  const { schemaName, listTables } = await import('./appdb.ts');
  const schema = schemaName(projectId);
  const dir = fileURLToPath(new URL(projectId + '/assets/', SITES));
  mkdirSync(dir, { recursive: true });
  let fetched = 0;
  const live = await listTables(pool, projectId);
  for (const { table } of tables) {
    if (!live.includes(table)) continue;
    let rows: any[] = [];
    try { rows = (await pool.query(`select * from "${schema}"."${table}" order by id limit ${MAX_ROWS}`)).rows; } catch { continue; }
    // does this table have an image column we can bake into?
    const imgCol = rows.length ? Object.keys(rows[0]).find(k => IMG_COL.test(k)) : null;
    for (const row of rows) {
      // skip rows that already carry a real image
      if (imgCol && typeof row[imgCol] === 'string' && (/^https?:/.test(row[imgCol]) || row[imgCol].charAt(0) === '/')) continue;
      const q = rowQuery(table, row);
      const rel = assetRel(q);
      const abs = fileURLToPath(new URL(projectId + '/' + rel, SITES));
      if (!existsSync(abs)) {
        // RELIABLE: space requests + retry with backoff so a burst rate-limit (429) doesn't leave most
        // cards image-less. Each row gets up to 3 tries; a genuine no-result just skips that row.
        let buf: Buffer | null = null;
        for (let attempt = 0; attempt < 3 && !buf; attempt++) {
          if (attempt) await sleep(400 * attempt);
          buf = await pexelsPhoto(q, false).catch(() => null);
        }
        if (!buf || buf.length < 1000) continue;
        writeFileSync(abs, buf);
        fetched++;
        await sleep(250);   // be gentle with the Pexels rate window between rows
      }
      // bake the local path into an empty image column so it's served identically on every request
      if (imgCol) { try { await pool.query(`update "${schema}"."${table}" set "${imgCol}"=$1 where id=$2`, ['/sites/' + projectId + '/' + rel, row.id]); } catch {} }
    }
  }
  return { fetched };
}

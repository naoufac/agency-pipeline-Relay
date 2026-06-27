// CMS core (roadmap 08) — edit a page's content and re-publish ONE page through the SAME
// verified path, deterministically. Design: the build freezes each page's POST-media /
// PRE-excellence HTML (with stable data-edit ids on text leaves) as the editable source in
// Postgres. An edit is a PURE STRING substitution on that frozen snapshot (no LLM, so the design
// can never drift). Re-publish overlays the edits, runs the identical finalize (excellence) +
// the identical site_renders gate against a <slug>.html.tmp, and only atomically renames it over
// the live file ON PASS — so an unverified edit never reaches /sites. v1 = text editing; photos
// stay byte-identical (they're already local in the snapshot). Pure functions never throw.
import pg from 'pg';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { processMedia } from './media.ts';
import { applyExcellence } from './excellence.ts';
import { verify, SITES } from './verify.ts';
import { ev } from './db.ts';

const TAGS = 'h[1-6]|p|li|blockquote|figcaption|button';
const ATTRS = '(?:"[^"]*"|\'[^\']*\'|[^>"\'])*';   // quote-aware start-tag attribute span (handles '>' inside quotes)

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
const labelFor = (tag: string) => ({ p: 'Paragraph', li: 'List item', button: 'Button', blockquote: 'Quote', figcaption: 'Caption', h1: 'Heading', h2: 'Subheading', h3: 'Subheading', h4: 'Subheading', h5: 'Subheading', h6: 'Subheading' } as Record<string, string>)[tag.toLowerCase()] || 'Text';

// ---- the build tail, shared so build & republish can never diverge ----
// fence-strip + doctype-slice + real Pexels media + strip every external/placeholder asset.
export async function cleanBody(content: string, dirUrl: URL): Promise<string> {
  let body = content.replace(/^\s*```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
  const at = body.search(/<!doctype html|<html/i); if (at > 0) body = body.slice(at);
  body = await processMedia(body, dirUrl);
  return body
    .replace(/<script\b[^>]*\bsrc\s*=\s*["']?https?:\/\/[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*\bhref\s*=\s*["']?https?:\/\/[^>]*?>/gi, '')
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']?https?:\/\/[^>]*?>/gi, '')
    .replace(/<img\b[^>]*placeholder[^>]*?>/gi, '')
    .replace(/url\(\s*["']?https?:\/\/[^)]*\)/gi, 'linear-gradient(135deg,#e9ecf3,#c9d2e3)')
    .replace(/url\(\s*["']?[^)]*placeholder[^)]*\)/gi, 'linear-gradient(135deg,#e9ecf3,#c9d2e3)');
}

// stamp a stable data-edit id on each editable block-leaf, in document order. Idempotent.
// CMS owns the data-edit namespace: any agent-authored data-edit ATTR is dropped (so ids can't collide),
// while data-edit text in the COPY is untouched. Quote-aware so '>' inside an attribute value is safe.
export function instrument(html: string): string {
  let n = 0;
  return html.replace(new RegExp(`<(${TAGS})\\b(${ATTRS})>([\\s\\S]*?)<\\/\\1>`, 'gi'), (_m, tag, attrs, inner) => {
    attrs = attrs.replace(/\s+data-edit\s*=\s*("[^"]*"|'[^']*')/gi, '');
    return `<${tag} data-edit="e${n++}"${attrs}>${inner}</${tag}>`;
  });
}

// EXACT inverse of instrument: remove ONLY the id we stamped as the first attr of an editable start tag.
// Never touches a data-edit="..." sitting in the page copy or text — so the round-trip is byte-identical.
export function stripEditAttrs(html: string): string {
  return html.replace(new RegExp(`(<(?:${TAGS})\\b)\\sdata-edit="e\\d+"`, 'gi'), '$1');
}

// the FINAL ship step. Deterministically-rendered pages already have their CSS/fonts inlined and a
// proper responsive nav, so they skip the Tailwind/excellence pass; legacy LLM-HTML still gets it.
export function shipHtml(html: string): string {
  const stripped = stripEditAttrs(html);
  return stripped.includes('<!--relay:rendered-->') ? stripped : applyExcellence(stripped);
}

export interface Block { block_id: string; kind: string; label: string; seq: number; value: string; read_only: boolean; }

// list the editable blocks of an instrumented snapshot
export function extractBlocks(html: string): Block[] {
  const re = new RegExp(`<(${TAGS})\\sdata-edit="([^"]+)"(${ATTRS})>([\\s\\S]*?)<\\/\\1>`, 'gi');
  const out: Block[] = []; let m: RegExpExecArray | null; let seq = 0;
  while ((m = re.exec(html))) {
    const [, tag, id, , inner] = m;
    const hasChild = /<\/[a-z]/i.test(inner) || /<(?:br|hr|img|input|source|wbr|svg|path|use)\b/i.test(inner);   // real child element (paired close or known void) — NOT 'a<b' text
    const raw = hasChild ? inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : inner;   // read-only: show plain text, no tags
    const text = decodeEntities(raw).trim();
    if (!text) continue;                                   // skip empty
    out.push({ block_id: id, kind: 'text', label: labelFor(tag), seq: seq++, value: text, read_only: hasChild });
  }
  return out;
}

// pure substitution: replace ONLY the inner of edited (non-read-only) data-edit nodes
export function applyOverlay(html: string, edits: Map<string, string>): string {
  if (!edits.size) return html;
  return html.replace(new RegExp(`<(${TAGS})\\sdata-edit="([^"]+)"(${ATTRS})>([\\s\\S]*?)<\\/\\1>`, 'gi'),
    (m, tag, id, post, _inner) => edits.has(id) ? `<${tag} data-edit="${id}"${post}>${escapeHtml(edits.get(id)!)}</${tag}>` : m);
}

// persist the snapshot + blocks after a successful build (preserves existing drafts)
export async function syncBlocks(pool: pg.Pool, projectId: string, slug: string, artifact: string, snapshot: string): Promise<void> {
  const blocks = extractBlocks(snapshot);
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `insert into page_snapshots(project_id,slug,artifact,src_html,state,log,updated_at)
       values($1,$2,$3,$4,'live','',now())
       on conflict(project_id,slug) do update set src_html=excluded.src_html, artifact=excluded.artifact,
         state=(case when page_snapshots.state='publishing' then page_snapshots.state else 'live' end), updated_at=now()`,
      [projectId, slug, artifact, snapshot]);
    for (const b of blocks)
      await c.query(
        `insert into page_blocks(project_id,slug,block_id,kind,label,seq,published,read_only,updated_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,now())
         on conflict(project_id,slug,block_id) do update set label=excluded.label, seq=excluded.seq, published=excluded.published, read_only=excluded.read_only, updated_at=now()`,
        [projectId, slug, b.block_id, b.kind, b.label, b.seq, b.value, b.read_only]);
    await c.query(`delete from page_blocks where project_id=$1 and slug=$2 and not (block_id = any($3))`,
      [projectId, slug, blocks.map(b => b.block_id)]);
    await c.query('commit');
  } catch (e) { try { await c.query('rollback'); } catch {} throw e; } finally { c.release(); }
}

// re-publish ONE page: overlay drafts -> finalize -> verify against .tmp -> atomic rename on PASS.
export async function republishPage(pool: pg.Pool, projectId: string, slug: string): Promise<{ ok: boolean; log: string }> {
  const snap = (await pool.query('select artifact, src_html from page_snapshots where project_id=$1 and slug=$2', [projectId, slug])).rows[0];
  if (!snap) return { ok: false, log: 'no editable snapshot for this page' };
  const dir = new URL(projectId + '/', SITES);
  const tmpArt = snap.artifact + '.tmp';
  const tmpPath = fileURLToPath(new URL(tmpArt, dir));
  const livePath = fileURLToPath(new URL(snap.artifact, dir));
  try {
    // overlay every block that has EVER been edited (dirty) or has a pending draft — so prior
    // published edits persist across publishes; untouched blocks are never overlaid (byte-identical).
    const edits = new Map<string, string>();
    const dr = await pool.query('select block_id, coalesce(draft, published) as val from page_blocks where project_id=$1 and slug=$2 and read_only=false and (draft is not null or dirty)', [projectId, slug]);
    for (const r of dr.rows) edits.set(r.block_id, r.val);

    const candidate = shipHtml(applyOverlay(snap.src_html, edits));
    writeFileSync(tmpPath, candidate);
    const { ok, log } = await verify(pool, { project_id: projectId, artifact: tmpArt, verify: 'site_renders' }, candidate);
    if (ok) {
      renameSync(tmpPath, livePath);                                     // atomic, same dir/fs
      // fold ONLY the exact values we shipped; if the user edited a block mid-publish, keep that newer draft
      for (const [bid, val] of edits)
        await pool.query("update page_blocks set published=$3, dirty=true, draft=(case when draft=$3 then null else draft end), updated_at=now() where project_id=$1 and slug=$2 and block_id=$4", [projectId, slug, val, bid]);
      await pool.query("update page_snapshots set state='live', log=$3, updated_at=now() where project_id=$1 and slug=$2", [projectId, slug, log]);
      await ev(pool, projectId, null, 'page_republished', `${slug}.html re-published [${log}]`);
    } else {
      try { unlinkSync(tmpPath); } catch {}                             // live file never touched
      await pool.query("update page_snapshots set state='failed', log=$3, updated_at=now() where project_id=$1 and slug=$2", [projectId, slug, log]);
    }
    return { ok, log };
  } catch (e: any) {                                                     // never strand state at 'publishing'
    try { unlinkSync(tmpPath); } catch {}
    const msg = 'publish error: ' + (e?.message ?? e);
    try { await pool.query("update page_snapshots set state='failed', log=$3, updated_at=now() where project_id=$1 and slug=$2", [projectId, slug, msg]); } catch {}
    return { ok: false, log: msg };
  }
}

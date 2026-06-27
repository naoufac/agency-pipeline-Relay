import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SITES = new URL('../sites/', import.meta.url);

// ---- helpers ----
function stripFences(s: string) { return s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim(); }
function firstJson(s: string): any {
  const t = stripFences(s);
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  const c = t.indexOf('['), d = t.lastIndexOf(']');
  for (const [lo, hi] of [[a, b], [c, d]] as [number, number][]) {
    if (lo >= 0 && hi > lo) { try { return JSON.parse(t.slice(lo, hi + 1)); } catch {} }
  }
  return undefined;
}
function rgb(h: string) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lum([r, g, b]: number[]) { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
function contrast(a: string, b: string) { const L1 = lum(rgb(a)), L2 = lum(rgb(b)); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); }

// Zero-trust completion: a deterministic check the agent cannot fake.
//   nonempty · contains:<s> · min:<n>            (weak floors)
//   json · json:k1,k2 · wcag                      (real: structured output the build consumes)
//   sql_applies · site_renders                    (real: actually runs/renders)
export async function verify(pool: pg.Pool, task: any, content: string): Promise<{ ok: boolean; log: string }> {
  const rule: string = task.verify;

  if (rule === 'nonempty') return { ok: content.trim().length > 0, log: content.trim() ? 'non-empty' : 'empty' };

  if (rule.startsWith('min:')) {
    const n = parseInt(rule.slice(4), 10) || 1; const len = content.trim().length;
    return { ok: len >= n, log: `${len} chars (need ${n})` };
  }

  if (rule.startsWith('contains:')) {
    const needle = rule.slice(9).toLowerCase(); const ok = content.toLowerCase().includes(needle);
    return { ok, log: ok ? `contains "${needle}"` : `missing "${needle}"` };
  }

  if (rule === 'json' || rule.startsWith('json:')) {
    const obj = firstJson(content);
    if (obj === undefined) return { ok: false, log: 'not valid JSON' };
    const keys = rule.startsWith('json:') ? rule.slice(5).split(',').map(s => s.trim()).filter(Boolean) : [];
    const missing = keys.filter(k => !(k in (obj || {})));
    return { ok: missing.length === 0, log: missing.length ? 'missing keys: ' + missing.join(',') : 'valid JSON' };
  }

  if (rule === 'wcag') {
    const obj = firstJson(content);
    const hexes = (content.match(/#[0-9a-fA-F]{3,6}\b/g) || []);
    if (!hexes.length) return { ok: false, log: 'no colours found' };
    let pair: [string, string] | null = null;
    const p = obj?.palette || obj;
    if (p?.text && p?.bg) pair = [p.text, p.bg];
    let best = 0;
    if (pair) best = contrast(pair[0], pair[1]);
    else for (let i = 0; i < hexes.length; i++) for (let k = i + 1; k < hexes.length; k++) best = Math.max(best, contrast(hexes[i], hexes[k]));
    return { ok: best >= 4.5, log: `best contrast ${best.toFixed(2)}:1 (need 4.5)` };
  }

  if (rule === 'sql_applies') {
    let sql = stripFences(content); const at = sql.search(/create\s+table/i); if (at >= 0) sql = sql.slice(at);
    const c = await pool.connect();
    try { await c.query('begin'); await c.query(sql); await c.query('rollback'); return { ok: true, log: 'sql applied cleanly' }; }
    catch (e: any) { try { await c.query('rollback'); } catch {} return { ok: false, log: 'sql error: ' + (e?.message ?? e) }; }
    finally { c.release(); }
  }

  if (rule === 'site_renders') {
    const dir = new URL(task.project_id + '/', SITES);
    const index = fileURLToPath(new URL('index.html', dir));
    if (!existsSync(index)) return { ok: false, log: 'no index.html produced' };
    const size = statSync(index).size;
    if (size < 400) return { ok: false, log: `index.html too small (${size}b)` };
    const html = readFileSync(index, 'utf8').toLowerCase();
    if (!/<html|<!doctype/.test(html.slice(0, 400)) || !/<body|<div|<section/.test(html)) return { ok: false, log: 'not valid HTML structure' };
    const shot = fileURLToPath(new URL('preview.png', dir));
    try {
      execFileSync('chromium-browser', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--hide-scrollbars', '--force-device-scale-factor=1', '--screenshot=' + shot, '--window-size=1280,860',
        '--virtual-time-budget=7000', 'file://' + index], { timeout: 45000, stdio: 'ignore' });
    } catch {}
    if (existsSync(shot) && statSync(shot).size > 3000) return { ok: true, log: `renders ok (${size}b html, ${statSync(shot).size}b preview)` };
    return { ok: false, log: 'render produced a blank/no screenshot' };
  }

  return { ok: false, log: 'unknown verify rule: ' + rule };
}

import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SITES = new URL('../sites/', import.meta.url);

// ---- helpers ----
function stripFences(s: string) { return s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim(); }
// parse the FIRST brace-balanced object/array (handles multiple concatenated JSON blocks)
function firstJson(s: string): any {
  const t = stripFences(s);
  for (const open of ['{', '[']) {
    const start = t.indexOf(open); if (start < 0) continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === open) depth++;
      else if (t[i] === close) { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { break; } } }
    }
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
    // strict: the tokens MUST declare the actual text & bg colours, and THAT pair must pass AA.
    // (no 'best pair anywhere' fallback — that was gameable.)
    const obj = firstJson(content);
    const p = obj?.palette || obj;
    const hex = (v: any) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim());
    if (!p || !hex(p.text) || !hex(p.bg)) return { ok: false, log: 'tokens must declare palette.text and palette.bg as hex' };
    const c = contrast(p.text.trim(), p.bg.trim());
    return { ok: c >= 4.5, log: `text/bg contrast ${c.toFixed(2)}:1 (need 4.5)` };
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
    const raw = readFileSync(index, 'utf8');
    const html = raw.toLowerCase();
    if (!/<html|<!doctype/.test(html.slice(0, 400)) || !/<body|<div|<section/.test(html)) return { ok: false, log: 'not valid HTML structure' };
    // QUALITY GATE: a rendered page that references external assets or has unfilled placeholders is broken
    if (/src\s*=\s*["']?https?:|url\(\s*["']?https?:|via\.placeholder/i.test(raw))
      return { ok: false, log: 'broken: external asset reference — build visuals with CSS/SVG, never <img>/url() to external URLs' };
    const ph = raw.match(/\[[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}\]/);
    if (ph) return { ok: false, log: 'unfilled placeholder left in copy: ' + ph[0] };
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

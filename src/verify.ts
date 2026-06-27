import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SITES = new URL('../sites/', import.meta.url);

// Zero-trust completion: a deterministic check the agent cannot influence decides 'done'.
//   nonempty / contains:<s> / sql_applies — as before
//   site_renders — the project's sites/<id>/index.html must REALLY render in a headless
//                  browser to a non-blank page (proves a usable website actually exists).
export async function verify(pool: pg.Pool, task: any, content: string): Promise<{ ok: boolean; log: string }> {
  const rule: string = task.verify;

  if (rule === 'nonempty') return { ok: content.trim().length > 0, log: content.trim() ? 'non-empty' : 'empty' };

  if (rule.startsWith('contains:')) {
    const needle = rule.slice(9).toLowerCase();
    const ok = content.toLowerCase().includes(needle);
    return { ok, log: ok ? `contains "${needle}"` : `missing "${needle}"` };
  }

  if (rule === 'sql_applies') {
    let sql = content.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
    const at = sql.search(/create\s+table/i); if (at >= 0) sql = sql.slice(at);
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
    const html = (await import('node:fs')).readFileSync(index, 'utf8').slice(0, 400).toLowerCase();
    if (!/<html|<!doctype/.test(html) || !/<body|<div|<section/.test((await import('node:fs')).readFileSync(index, 'utf8').toLowerCase()))
      return { ok: false, log: 'not valid HTML structure' };
    // REAL render check: headless screenshot must be a non-blank page
    const shot = fileURLToPath(new URL('preview.png', dir));
    try {
      execFileSync('chromium-browser', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--hide-scrollbars', '--force-device-scale-factor=1', '--screenshot=' + shot,
        '--window-size=1280,860', '--virtual-time-budget=7000', 'file://' + index],
        { timeout: 45000, stdio: 'ignore' });
    } catch { /* chromium can exit non-zero yet still write the screenshot; judge by the file */ }
    if (existsSync(shot) && statSync(shot).size > 3000)
      return { ok: true, log: `renders ok (${size}b html, ${statSync(shot).size}b preview)` };
    return { ok: false, log: 'render produced a blank/no screenshot' };
  }

  return { ok: false, log: 'unknown verify rule: ' + rule };
}

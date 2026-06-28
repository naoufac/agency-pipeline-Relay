// Visual QA runner: screenshot each produced page at mobile + desktop, have the vision model read
// each, and store the score + issues + the screenshot (served from the site dir for the dashboard).
// ASYNC chromium (never block the HTTP event loop), per-project in-flight guard, atomic upsert.
import pg from 'pg';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SITES } from './verify.ts';
import { critique, visionReady } from './vision.ts';
import { screenshot } from './browser.ts';
import { ev } from './db.ts';

const VIEWPORTS: [string, number, boolean][] = [['mobile', 390, true], ['desktop', 1280, false]];
const running = new Set<string>();                              // one review per project at a time
const base = () => 'http://localhost:' + (process.env.PORT || 8787);   // screenshot the SERVED page so live collections render

// shared Playwright browser (one persistent instance) — no per-call chromium spawn
async function snap(url: string, outPath: string, width: number, mobile: boolean): Promise<boolean> {
  try { writeFileSync(outPath, await screenshot(url, { width, mobile, fullPage: true, settleMs: 600 })); return true; }
  catch { return false; }
}

export function qaRunning(projectId: string): boolean { return running.has(projectId); }

// Review every page of a built site (mobile + desktop). Atomic per (slug,viewport). Never throws.
export async function reviewSite(pool: pg.Pool, projectId: string): Promise<{ views: number; worst: number }> {
  if (running.has(projectId)) return { views: 0, worst: 0 };   // a review is already in flight for this project
  running.add(projectId);
  try {
    const dir = new URL(projectId + '/', SITES);
    // board thumbnail — generated here (off the build hot path), ALWAYS, independent of vision
    if (existsSync(fileURLToPath(new URL('index.html', dir)))) {
      try { writeFileSync(fileURLToPath(new URL('preview.png', dir)), await screenshot(`${base()}/sites/${projectId}/index.html`, { width: 1280, height: 860, settleMs: 600 })); } catch {}
    }
    if (!visionReady()) { await ev(pool, projectId, null, 'qa_skipped', 'vision disabled (no GEMINI_API_KEY)'); return { views: 0, worst: 0 }; }
    const runStart = (await pool.query('select now() as t')).rows[0].t;
    const proj = await pool.query('select params from projects where id=$1', [projectId]);
    const pages = (proj.rows[0]?.params?.pages) || [{ slug: 'index', title: 'Home' }];
    let worst = 10, views = 0;
    for (const p of pages) {
      const artifact = (p.slug === 'index' ? 'index' : p.slug) + '.html';
      if (!existsSync(fileURLToPath(new URL(artifact, dir)))) continue;
      const pageUrl = `${base()}/sites/${projectId}/${artifact}`;
      for (const [vp, width, mobile] of VIEWPORTS) {
        const shotName = `_qa-${p.slug}-${vp}.png`;
        if (!await snap(pageUrl, fileURLToPath(new URL(shotName, dir)), width as number, mobile as boolean)) continue;
        let c; try { c = await critique(fileURLToPath(new URL(shotName, dir)), vp); }
        catch (e: any) { console.error('qa critique', p.slug, vp, e?.message); continue; }
        if (c.score == null) continue;                          // unparseable review -> don't store a fake 0
        await pool.query(
          `insert into qa_reviews(project_id,slug,viewport,score,issues,shot,created_at) values($1,$2,$3,$4,$5,$6,now())
           on conflict(project_id,slug,viewport) do update set score=excluded.score, issues=excluded.issues, shot=excluded.shot, created_at=now()`,
          [projectId, p.slug, vp, c.score, JSON.stringify(c.issues), shotName]);
        worst = Math.min(worst, c.score); views++;
      }
    }
    // drop rows from a PRIOR review (pages/viewports that no longer exist); this run's rows are >= runStart
    await pool.query('delete from qa_reviews where project_id=$1 and created_at < $2', [projectId, runStart]);
    await ev(pool, projectId, null, 'qa_reviewed', `${views} views reviewed, worst ${worst}/10`);
    return { views, worst };
  } catch (e: any) { console.error('reviewSite', projectId, e?.message); return { views: 0, worst: 0 }; }
  finally { running.delete(projectId); }
}

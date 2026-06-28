// src/browser.ts — ONE persistent Playwright browser, shared by QA, dogfood, thumbnails and theme:check.
// Replaces spawn-per-call `chromium-browser` + the hand-rolled CDP client (the source of the recurring
// "chromium CDP did not come up" / navigation / sandbox breakage). Playwright bundles its own Chromium
// (no snap), manages the lifecycle, auto-waits, and isolates a context per task. A small concurrency
// gate means a burst of completions can't open N pages at once and starve the host.
import { chromium, type Browser, type Page } from 'playwright';

let launching: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!launching) {
    launching = chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] })
      .then(b => { b.on('disconnected', () => { launching = null; }); return b; })
      .catch(e => { launching = null; throw e; });
  }
  return launching;
}

// tiny FIFO concurrency limiter (default 2 pages at once)
const LIMIT = Math.max(1, Number(process.env.BROWSER_CONCURRENCY || 2));
let active = 0; const waiters: (() => void)[] = [];
async function acquire() { if (active >= LIMIT) await new Promise<void>(r => waiters.push(r)); active++; }
function release() { active--; const w = waiters.shift(); if (w) w(); }

export type PageOpts = { width?: number; height?: number; mobile?: boolean };

// Run fn with a fresh isolated page; always closes the context + frees a slot. The browser stays warm.
export async function withPage<T>(opts: PageOpts, fn: (page: Page) => Promise<T>): Promise<T> {
  await acquire();
  let ctx: import('playwright').BrowserContext | null = null;
  try {
    const b = await getBrowser();
    ctx = await b.newContext({ viewport: { width: opts.width || 1280, height: opts.height || 900 }, isMobile: !!opts.mobile, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    return await fn(page);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    release();
  }
}

// Screenshot a URL into a PNG buffer (waits for network idle so async collections/feeds render).
export async function screenshot(url: string, opts: PageOpts & { fullPage?: boolean; settleMs?: number } = {}): Promise<Buffer> {
  return withPage(opts, async (page) => {
    try { await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }); }
    catch { try { await page.goto(url, { waitUntil: 'load', timeout: 30000 }); } catch {} }
    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
    return await page.screenshot({ fullPage: !!opts.fullPage });
  });
}

export async function closeBrowser() { if (launching) { const b = await launching.catch(() => null); launching = null; if (b) await b.close().catch(() => {}); } }

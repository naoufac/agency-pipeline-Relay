import pg from 'pg';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as appdb from './appdb.ts';
import { copySlop } from './spec.ts';

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
// copy-specificity floor (R3): copySlop now lives in spec.ts so it can gate at COMPOSE (the retryable stage),
// not only at render. Re-exported here for existing importers (eval.ts, spec-test.ts). Render keeps it as a backstop.
export { copySlop };

// STRUCTURAL INVARIANT — "one website = one navigation = one logo".
// The renderer composes EXACTLY one <nav class="nav"> + EXACTLY one <a class="nav-brand"> by
// construction. This makes that invariant LOAD-BEARING: a page that somehow carries a second <nav>
// (e.g. a footer that emits its own <nav>, a stray injected header) or a second/zero logo can NEVER
// be marked done — it fails the gate and re-opens with feedback. Section copy is HTML-escaped, so a
// literal "<nav" in copy becomes "&lt;nav" and never trips this. Pure + exported → reused by the
// site-consistency gate, the interaction reviewer (dogfood) and the stress harness (ONE source of truth).
export function navDefect(html: string): string | null {
  const navs = (html.match(/<nav[\s>]/gi) || []).length;
  if (navs !== 1) return `expected exactly 1 top <nav>, found ${navs}`;
  const logos = (html.match(/class="nav-brand"/g) || []).length;
  if (logos !== 1) return `expected exactly 1 logo (.nav-brand), found ${logos}`;
  return null;
}
// The brand text inside the single logo, and the page's locked palette — used to prove that EVERY page
// of a site shares ONE logo + ONE palette (no per-page drift). Returns '' when absent.
export function pageLogo(html: string): string { return ((html.match(/class="nav-brand"[^>]*>([^<]*)</) || [])[1] || '').trim(); }
export function pagePalette(html: string): string {
  return `${(html.match(/--primary:\s*(#[0-9a-fA-F]{3,8})/) || [])[1] || '?'}/${(html.match(/--bg:\s*(#[0-9a-fA-F]{3,8})/) || [])[1] || '?'}`;
}
// The ordered nav entries (page links + the CTA button label). The whole navigation — not just the logo —
// must be identical on every page; this catches a per-page CTA button label drifting (the renderer's nav
// links come from the shared page list, but the button label is brand.cta, which must be locked too).
export function pageNav(html: string): string {
  const ul = (html.match(/class="nav-links">([\s\S]*?)<\/ul>/) || [])[1] || '';
  return (ul.match(/>([^<]+)<\/a>/g) || []).map(s => s.replace(/^>|<\/a>$/g, '').trim()).join(' | ');
}

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
    try { await c.query('begin'); await c.query("set local statement_timeout='15s'"); await c.query(sql); await c.query('rollback'); return { ok: true, log: 'sql applied cleanly' }; }
    catch (e: any) { try { await c.query('rollback'); } catch {} return { ok: false, log: 'sql error: ' + (e?.message ?? e) }; }
    finally { c.release(); }
  }

  if (rule === 'app_db') {
    // Stronger than sql_applies: PROVISION the project's own isolated schema (app_<hex>) for real and
    // prove the tables now exist. The app runs on a live DB, not a file. Confined to its namespace.
    try {
      const { schema, tables } = await appdb.provision(pool, task.project_id, content);
      return { ok: tables.length >= 1, log: tables.length ? `app db live: ${tables.length} table(s) in ${schema} — ${tables.join(', ')}` : 'no tables created' };
    } catch (e: any) { return { ok: false, log: 'app db provision failed: ' + (e?.message ?? e) }; }
  }

  if (rule === 'site_renders') {
    const dir = new URL(task.project_id + '/', SITES);
    const file = task.artifact || 'index.html';                 // verify THIS page's file (qa -> index.html)
    const path = fileURLToPath(new URL(file, dir));
    if (!existsSync(path)) return { ok: false, log: `no ${file} produced` };
    const size = statSync(path).size;
    if (size < 400) return { ok: false, log: `${file} too small (${size}b)` };
    const raw = readFileSync(path, 'utf8');
    const html = raw.toLowerCase();
    if (!/<html|<!doctype/.test(html.slice(0, 400)) || !/<body|<div|<section/.test(html)) return { ok: false, log: 'not valid HTML structure' };
    if (/src\s*=\s*["']?https?:|url\(\s*["']?https?:|<link\b[^>]*href\s*=\s*["']?https?:|\bapp\.css\b|via\.placeholder/i.test(raw))
      return { ok: false, log: 'broken: external/unbundled asset reference — all CSS/fonts must be inlined' };
    const ph = raw.match(/\[[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}\]/);
    if (ph) return { ok: false, log: 'unfilled placeholder left in copy: ' + ph[0] };
    const slop = copySlop(raw);
    if (slop) return { ok: false, log: `slop copy — ${slop}. Write real, specific copy for this brief.` };
    // INTERACTION: a button that goes nowhere is a defect. Every CTA must have a real target
    // (a page or an in-page anchor), and every form must be wired to submit.
    const dead = (raw.match(/<a\b[^>]*class="btn"[^>]*>/gi) || []).filter(b => !/href="/i.test(b) || /href="#"/i.test(b) || /href=""/i.test(b)).length;
    if (dead) return { ok: false, log: `${dead} dead CTA button(s) (href="#"/empty) — a button must go somewhere` };
    const unwired = (raw.match(/<form\b[^>]*>/gi) || []).filter(f => !/onsubmit="return relaysubmit/i.test(f) && !/\baction=/i.test(f)).length;
    if (unwired) return { ok: false, log: `${unwired} form(s) not wired to submit` };
    // ONE website = ONE nav = ONE logo. A duplicated nav/logo is the most visible "the system is broken"
    // defect there is; it is now a hard, always-on gate so a page can never ship with it.
    const nd = navDefect(raw);
    if (nd) return { ok: false, log: `structural defect — ${nd}. A page must have exactly one top nav and one logo; a duplicate means a stray nav/header leaked in.` };
    // NO per-build chromium screenshot: the page is deterministically composed from vetted components,
    // so structure/CSS/contrast are correct by construction and proven by the static checks above (a blank
    // render would require a bug in our own vetted CSS, which theme:check catches). The board thumbnail is
    // produced once, off this hot path, by the QA pass (qa.ts → preview.png via the shared browser).
    return { ok: true, log: `${file} ok (${size}b · structure · no external assets · live CTAs · wired forms)` };
  }

  if (rule === 'site_consistent') {
    // SITE-LEVEL acceptance (the QA task): read EVERY produced page and prove the whole site is one
    // coherent identity — each page has exactly 1 nav + 1 logo, and ALL pages share the SAME logo text
    // and the SAME palette. This is the deterministic guarantee behind "1 website, 1 navigation, 1 logo".
    const dir = new URL(task.project_id + '/', SITES);
    let files: string[] = [];
    try { files = readdirSync(fileURLToPath(dir)).filter(f => f.endsWith('.html')).sort(); } catch {}
    if (!files.length) return { ok: false, log: 'no pages produced' };
    const logos = new Set<string>(); const palettes = new Set<string>(); const navs = new Set<string>();
    for (const f of files) {
      const html = readFileSync(fileURLToPath(new URL(f, dir)), 'utf8');
      const nd = navDefect(html);
      if (nd) return { ok: false, log: `${f}: ${nd}` };
      logos.add(pageLogo(html)); palettes.add(pagePalette(html)); navs.add(pageNav(html));
    }
    if (logos.size !== 1) return { ok: false, log: `logo drifts across pages — ${[...logos].map(l => JSON.stringify(l)).join(' · ')}. Every page must show ONE logo.` };
    if (palettes.size !== 1) return { ok: false, log: `palette drifts across pages — ${[...palettes].join(' · ')}. Every page must share ONE palette.` };
    if (navs.size !== 1) return { ok: false, log: `navigation drifts across pages — ${[...navs].map(n => JSON.stringify(n)).join(' · ')}. Every page must show the SAME nav (links + button).` };
    return { ok: true, log: `${files.length} pages consistent — 1 nav/1 logo each · logo ${JSON.stringify([...logos][0])} · palette ${[...palettes][0]} · nav [${[...navs][0]}]` };
  }

  if (rule === 'site_model') {
    // CMS-FIRST acceptance: the compose step stored the WHOLE-site model in params.site. Prove it covers
    // every planned page and each page is a valid, renderable spec (hero-first, >= 2 real sections) BEFORE
    // any deterministic render runs. A bad model rejects here into retry-with-feedback — pages never render
    // from a broken CMS.
    const r = await pool.query("select params->'site' as site, params->'pages' as pages from projects where id=$1", [task.project_id]);
    const site = r.rows[0]?.site; const planned = Array.isArray(r.rows[0]?.pages) ? r.rows[0].pages : [];
    const ps = (site && Array.isArray(site.pages)) ? site.pages : [];
    if (!ps.length) return { ok: false, log: 'no composed site model (params.site empty)' };
    if (ps.length < planned.length) return { ok: false, log: `site model covers ${ps.length}/${planned.length} planned pages` };
    for (const p of ps) {
      if (!Array.isArray(p.sections) || p.sections.length < 2) return { ok: false, log: `page "${p.slug}" has <2 sections` };
      if (p.sections[0]?.type !== 'hero') return { ok: false, log: `page "${p.slug}" must open with a hero` };
    }
    return { ok: true, log: `site model ok — ${ps.length} pages composed (one CMS)` };
  }

  return { ok: false, log: 'unknown verify rule: ' + rule };
}

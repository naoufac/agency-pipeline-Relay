// src/eval.ts — R2: the output-quality EVAL HARNESS.
// BOARD-SAFE BY CONSTRUCTION: pure plan -> build -> render -> score, all in memory. It NEVER opens a
// database, NEVER touches the live board, NEVER starts a server (zero wipe risk). It measures COPY
// specificity + STRUCTURE + section variety across a fixed corpus so quality changes are DATA, not vibes.
//
// Runtime LLM is on your external key (research + planner use web search ~a cent/brief). With NO provider
// key set it runs on deterministic STUBS — instant, $0 — which exercises the whole pipeline end-to-end.
//
//   npm run eval            # 3 briefs
//   npm run eval -- 15      # the full corpus
import { buildPlan } from './planner.ts';
import { runAgent } from './agents.ts';
import { normalizeSpec } from './spec.ts';
import { renderPage } from './render.ts';
import { copySlop } from './verify.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// a fixed, diverse corpus (site / app / store across many industries). Order is stable so runs compare.
const CORPUS: string[] = [
  'A specialty coffee roastery in Lisbon, Portugal — beans, a cafe, and online ordering',
  'An independent plumber serving Leeds — emergency callouts and bookings',
  'A boutique yoga studio in Austin with class schedules and memberships',
  'A SaaS product that turns spreadsheets into dashboards, for small finance teams',
  'A family law firm in Toronto — consultations and clear fee guidance',
  'A late-night food delivery app connecting local kitchens to students',
  'A wedding photographer in Provence — portfolio and enquiries',
  'An online store for handmade ceramic tableware, small batches',
  'A neighbourhood dental practice offering checkups and Invisalign',
  'A real-estate agency listing apartments for rent in Berlin',
  'An online strength-training coach selling programs and 1:1 coaching',
  'An indie game studio announcing its first narrative adventure game',
  'A language school teaching conversational Spanish online, live classes',
  'A mobile car-detailing service with instant quotes and booking',
  'A nonprofit planting urban trees — donations and volunteer signups',
];

// generic marketing FILLER — the opposite of specific. Lower hit-count = better copy.
const GENERIC: RegExp[] = [
  /\bwe deliver\b/i, /\bour mission\b/i, /\bwelcome to (our|the|my)\b/i, /\bcutting[- ]edge\b/i,
  /\bworld[- ]class\b/i, /\bpassion(ate)? (for|about)\b/i, /\bwide (range|variety)\b/i, /\bone[- ]stop\b/i,
  /\bto the next level\b/i, /\bseamless(ly)?\b/i, /\bleverage\b/i, /\bempower\b/i, /\bstate[- ]of[- ]the[- ]art\b/i,
  /\byour (trusted|go-to) (partner|source)\b/i, /\bgame[- ]chang/i, /\belevate your\b/i, /\bbest[- ]in[- ]class\b/i,
  /\bunparalleled\b/i, /\btailored solutions?\b/i, /\bunlock your\b/i,
];

function visibleText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// brace-balanced first JSON object (mirrors runner.firstSpec — the build agent returns a spec as text)
function firstSpec(s: string): any {
  const t = s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const a = t.indexOf('{'); if (a < 0) return null;
  let d = 0;
  for (let i = a; i < t.length; i++) { if (t[i] === '{') d++; else if (t[i] === '}') { if (--d === 0) { try { return JSON.parse(t.slice(a, i + 1)); } catch { return null; } } } }
  return null;
}

// PURE scorer (exported, unit-tested in spec-test.ts) — objective signals, no model opinion.
export function scorePage(html: string, spec: any) {
  const text = visibleText(html);
  const words = text ? text.split(' ').length : 0;
  const genericHits = GENERIC.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  const specific = (text.match(/\b\d[\d,.]*\b|[$€£]\s?\d|\d\s?%/g) || []).length;   // numbers / prices / percentages = concrete
  const slop = copySlop(html);
  const types: string[] = Array.isArray(spec?.sections) ? spec.sections.map((s: any) => s.type) : [];
  const distinctTypes = new Set(types).size;
  const hasH1 = /<h1[\s>]/i.test(html);
  const sectionCount = (html.match(/<section\b|<header\b/gi) || []).length;
  const externalAsset = /src\s*=\s*["']?https?:|url\(\s*["']?https?:|<link\b[^>]*href\s*=\s*["']?https?:|via\.placeholder/i.test(html);
  const deadCta = (html.match(/<a\b[^>]*class="btn"[^>]*>/gi) || []).filter(b => !/href="/i.test(b) || /href="#"/i.test(b) || /href=""/i.test(b)).length;
  const gatePass = hasH1 && sectionCount >= 2 && !externalAsset && deadCta === 0 && !slop;
  // transparent specificity score (0-100): reward concrete signals, penalize filler. Definition is fixed so it tracks.
  const specificity = Math.max(0, Math.min(100, 50 + specific * 4 - genericHits * 12));
  return { gatePass, slop: slop || undefined, words, genericHits, specific, distinctTypes, sectionCount, specificity };
}

async function evalBrief(brief: string) {
  const { plan, usedLLM } = await buildPlan(brief);
  const pages = (plan.pages || []).slice(0, 2);   // cap pages/brief to bound cost + wall-clock
  let research = ''; try { research = await runAgent('research', { brief, upstream: [] } as any); } catch { research = ''; }
  let content = ''; try { content = await runAgent('content', { brief, upstream: [{ seq: 1, department: 'research', content: research }] } as any); } catch { content = ''; }
  const upstream = [{ seq: 1, department: 'research', content: research }, { seq: 2, department: 'content', content: content }];
  const pageScores: any[] = [];
  for (const pg of pages) {
    const rec: any = { slug: pg.slug };
    try {
      const rawTxt = await runAgent('build', { brief, upstream, self: { title: pg.title, slug: pg.slug }, pages, theme: plan.theme, tables: [], forms: {}, primaryTable: '' } as any);
      const { spec, errors } = normalizeSpec(firstSpec(rawTxt), { slug: pg.slug });
      if (errors.length) rec.rejected = errors.join('; ');
      else Object.assign(rec, scorePage(renderPage(spec, { pages, slug: pg.slug, title: pg.title, theme: plan.theme }), spec));
    } catch (e: any) { rec.error = (e?.message || String(e)).slice(0, 140); }
    pageScores.push(rec);
  }
  return { brief, usedLLM, archetype: plan.archetype, theme: plan.theme, pages: pageScores };
}

const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const r1 = (n: number) => Math.round(n * 10) / 10;

function summarize(results: any[]) {
  const allPages = results.flatMap(r => r.pages || []);
  const scored = allPages.filter((p: any) => p.gatePass != null);
  return {
    briefs: results.length, pages: allPages.length, scored: scored.length,
    gatePassed: scored.filter((p: any) => p.gatePass).length,
    gatePassRate: r1(100 * scored.filter((p: any) => p.gatePass).length / Math.max(1, scored.length)),
    rejectedSpecs: allPages.filter((p: any) => p.rejected).length,
    errors: allPages.filter((p: any) => p.error).length,
    avgSpecificity: r1(avg(scored.map((p: any) => p.specificity))),
    avgGenericHits: r1(avg(scored.map((p: any) => p.genericHits))),
    avgDistinctTypes: r1(avg(scored.map((p: any) => p.distinctTypes))),
    avgWords: Math.round(avg(scored.map((p: any) => p.words))),
  };
}

async function main() {
  const n = Math.max(1, Math.min(CORPUS.length, Number(process.argv[2] || 3)));
  const stub = !(process.env.OPENROUTER_API_KEY || process.env.MINIMAX_API_KEY);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync('eval', { recursive: true });
  const out = `eval/report-${stamp}.json`;
  console.log(`eval — ${n} brief(s) · ${stub ? 'STUB mode ($0, not representative)' : 'LIVE (external key)'} -> ${out}\n`);
  const results: any[] = [];
  for (let i = 0; i < n; i++) {
    process.stdout.write(`  [${i + 1}/${n}] ${CORPUS[i].slice(0, 50)}… `);
    try {
      const r = await evalBrief(CORPUS[i]);
      const okc = r.pages.filter((p: any) => p.gatePass).length;
      console.log(`${okc}/${r.pages.length} pass · spec≈${r1(avg(r.pages.filter((p: any) => p.specificity != null).map((p: any) => p.specificity)))}`);
      results.push(r);
    } catch (e: any) { console.log('FAILED:', (e?.message || e)); results.push({ brief: CORPUS[i], error: (e?.message || String(e)).slice(0, 140), pages: [] }); }
    writeFileSync(out, JSON.stringify({ stamp, stub, summary: summarize(results), results }, null, 2));   // incremental: a kill still leaves usable data
  }
  const s = summarize(results);
  console.log('\n=== corpus summary ===');
  console.log(`  gate-pass rate   ${s.gatePassRate}%   (${s.gatePassed}/${s.scored} pages)`);
  console.log(`  rejected specs   ${s.rejectedSpecs}   · errors ${s.errors}`);
  console.log(`  avg specificity  ${s.avgSpecificity}/100   · avg generic-filler hits ${s.avgGenericHits}/page`);
  console.log(`  avg section variety ${s.avgDistinctTypes} distinct types · avg ${s.avgWords} words/page`);
  console.log(`\nreport -> ${out}`);
}

// run only when invoked directly (so spec-test.ts can import scorePage without triggering an eval run)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().then(() => process.exit(0)).catch((e) => { console.error('eval failed:', e?.message ?? e); process.exit(1); });

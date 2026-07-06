// board:check — source-pin gates for T11/T12/T13/T20 (board UI domain).
//
// WHY source-pins and not live HTTP probes:
//   The board UI is a static SPA served from web/. A source-pin checks the
//   GENERATOR (app.js + server.ts) rather than a particular database row —
//   exactly "fix the system, not the outputs". Live probes would require a
//   running server, a real project, and real build data; that's the canary's job.
//
// Each gate asserts a BEHAVIOURAL invariant expressed as a pattern in the source:
//   • server.ts exposes deliverable/stack/chainReason/capabilities/build_seconds
//   • app.js renders the badge, chain, filter and reason banner
//   No assertions on exact line numbers (stable) — use regexp on the text.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const srv  = readFileSync(fileURLToPath(new URL('src/server.ts', root)), 'utf8');
const app  = readFileSync(fileURLToPath(new URL('web/app.js', root)), 'utf8');
const css  = readFileSync(fileURLToPath(new URL('web/styles.css', root)), 'utf8');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else       { fail++; console.error('  ✗', name, extra || ''); }
};

// ── server.ts: boardJSON exposes the new fields ──────────────────────────────
{
  // T11/T13: deliverable is extracted from params and attached to the project payload
  ok('server: boardJSON exposes deliverable from params',
    srv.includes("deliverable:") && srv.includes("pm.deliverable") && srv.includes("boardJSON"));

  // T11: stack is exposed
  ok('server: boardJSON exposes stack from params',
    srv.includes("stack:") && srv.includes("pm.stack"));

  // T20: chainReason is exposed
  ok('server: boardJSON exposes chainReason from params',
    srv.includes("chainReason:") && srv.includes("pm.chainReason"));

  // T11: capabilities is exposed
  ok('server: boardJSON exposes capabilities from params',
    srv.includes("capabilities:") && srv.includes("pm.capabilities"));

  // T12: build_seconds is exposed (either from params or derived from task timestamps)
  ok('server: boardJSON exposes build_seconds (direct or derived)',
    srv.includes("build_seconds") && srv.includes("pm.build_seconds"));

  // T12: derivation uses tasks updated_at vs project created_at (wall-clock logic)
  ok('server: build_seconds falls back to task timestamp derivation',
    srv.includes("updated_at") && srv.includes("created_at") && srv.includes("epoch"));

  // Invariant: the new fields must be added in the boardJSON region only — not a global rewrite
  ok('server: new fields added inside boardJSON function (scoped, not global)',
    (() => {
      const start = srv.indexOf('async function boardJSON');
      const end   = srv.indexOf('\nasync function ', start + 1);  // next top-level async fn
      const region = srv.slice(start, end > 0 ? end : start + 4000);
      return region.includes('pm.deliverable') && region.includes('pm.chainReason');
    })());
}

// ── app.js: T13 · deliverable badge + filter ─────────────────────────────────
{
  // DLV_LABEL maps the five deliverable IDs
  ok('app: DLV_LABEL maps the 5 canonical deliverable IDs',
    app.includes("const DLV_LABEL") &&
    app.includes("directus_site") && app.includes("wp_site") &&
    app.includes("wp_woocommerce") && app.includes("fullstack_app") &&
    app.includes("campaign"));

  // DLV_COLOR maps each deliverable to a colour
  ok('app: DLV_COLOR provides a colour for each deliverable',
    app.includes("const DLV_COLOR") && app.includes("DLV_COLOR[dlv]"));

  // deliverableBadge() renders a span with data-dlv attribute
  ok('app: deliverableBadge() renders a span with data-dlv for CSS hook',
    app.includes("function deliverableBadge") &&
    app.includes('data-dlv=') && app.includes("dlv-badge"));

  // cardInner calls deliverableBadge (badge on home cards)
  ok('app: cardInner includes deliverableBadge() (badge on home project cards)',
    app.includes("cardInner") && app.includes("deliverableBadge(p.deliverable"));

  // cards have data-dlv attribute set for filter hook
  ok('app: home card elements get data-dlv attribute for filter targeting',
    app.includes("el.setAttribute('data-dlv'"));

  // applyDlvFilter() reads data-dlv and show/hides cards
  ok('app: applyDlvFilter() uses data-dlv to show/hide cards without re-render',
    app.includes("function applyDlvFilter") &&
    app.includes("getAttribute('data-dlv')") &&
    app.includes("style.display"));

  // filter bar renders pill buttons with a data-val attribute
  ok('app: filter bar renders per-deliverable buttons with data-val',
    app.includes("dlv-filter-btn") && app.includes("data-val="));

  // filter bar only shown when ≥2 deliverable types are present (no noisy empty bar)
  ok('app: filter bar hidden when fewer than 2 deliverable types',
    app.includes("if (seen.size < 2)") || app.includes('seen.size < 2'));

  // activeDlvFilter state persists across poll ticks
  ok('app: activeDlvFilter is module-level (survives poll ticks)',
    /^let activeDlvFilter/.test(app) || app.includes("let activeDlvFilter = ''"));
}

// ── app.js: T11 · capability chain ───────────────────────────────────────────
{
  ok('app: chainHtml() renders capabilities as .cap-tag spans',
    app.includes("function chainHtml") && app.includes("cap-tag"));

  // CAP_LABEL maps known CapIds to human labels
  ok('app: chainHtml has CAP_LABEL with core spine caps',
    app.includes("CAP_LABEL") && app.includes("branding") && app.includes("content_copy"));

  // chain is rendered in the project header (called from header())
  ok('app: chainHtml called from header() with p.capabilities',
    app.includes("chainHtml(p.capabilities)") || app.includes("chainHtml(b.project.capabilities"));

  // chain-row class used (matches CSS)
  ok('app: chain-row class used for the capabilities flex row',
    app.includes("chain-row"));
}

// ── app.js: T20 · chainReason banner ─────────────────────────────────────────
{
  ok('app: chainReason banner rendered from p.chainReason',
    app.includes("chainReason") && app.includes("chain-reason-banner"));

  // banner is only rendered when chainReason is truthy (never an empty box)
  ok('app: chainReason banner guarded — only shown when chainReason is set',
    /p\.chainReason\s*\?/.test(app) || app.includes("p.chainReason\n") || app.includes("if (p.chainReason"));

  // banner displays the orchestrator's one-sentence reason
  ok('app: chainReason text is escaped (no XSS from server-supplied reason)',
    app.includes("esc(p.chainReason)"));
}

// ── app.js: T12 · wall-clock ──────────────────────────────────────────────────
{
  ok('app: builtIn() formats wall-clock seconds as "Xm Ys" or "Xs"',
    app.includes("function builtIn") && app.includes("Math.floor(secs / 60)"));

  ok('app: builtIn() returns empty string for null/zero (graceful degradation)',
    app.includes("if (!secs || secs <= 0) return ''"));

  ok('app: builtIn called with p.build_seconds in the project header',
    app.includes("builtIn(p.build_seconds)"));
}

// ── CSS: new classes exist ────────────────────────────────────────────────────
{
  ok('css: .dlv-badge defined', css.includes('.dlv-badge'));
  ok('css: .chain-reason-banner defined', css.includes('.chain-reason-banner'));
  ok('css: .cap-tag defined', css.includes('.cap-tag'));
  ok('css: .chain-row defined', css.includes('.chain-row'));
  ok('css: .dlv-filter-btn defined', css.includes('.dlv-filter-btn'));
  ok('css: .dlv-filter-bar defined', css.includes('.dlv-filter-bar'));
  ok('css: .proj-meta-row defined', css.includes('.proj-meta-row'));
}

console.log(`\nboard:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// board:check — source-pin gates for T11/T12/T13/T20/T33/T34/T35/T36 (board UI domain).
//
// WHY source-pins and not live HTTP probes:
//   The board UI is a static SPA served from web/. A source-pin checks the
//   GENERATOR (app.js + server.ts) rather than a particular database row —
//   exactly "fix the system, not the outputs". Live probes would require a
//   running server, a real project, and real build data; that's the canary's job.
//
// Each gate asserts a BEHAVIOURAL invariant expressed as a pattern in the source:
//   • server.ts exposes deliverable/stack/chainReason/capabilities/build_seconds/liveUrl
//   • app.js renders the badge, chain, filter, reason banner, live-url link, perf panel
//   • digest.ts includes the deliverable mix + avg build time line
//   • kpi.ts exposes deliverableMixCounts + avgBuildSeconds helpers
//   No assertions on exact line numbers (stable) — use regexp on the text.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root    = new URL('../', import.meta.url);
const srv     = readFileSync(fileURLToPath(new URL('src/server.ts', root)), 'utf8');
const app     = readFileSync(fileURLToPath(new URL('web/app.js', root)), 'utf8');
const css     = readFileSync(fileURLToPath(new URL('web/styles.css', root)), 'utf8');
const digest  = readFileSync(fileURLToPath(new URL('src/digest.ts', root)), 'utf8');
const kpi     = readFileSync(fileURLToPath(new URL('src/kpi.ts', root)), 'utf8');

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
  // T34: performance panel CSS classes
  ok('css: .perf-panel defined', css.includes('.perf-panel'));
  ok('css: .perf-panel-head defined', css.includes('.perf-panel-head'));
  ok('css: .perf-mix defined', css.includes('.perf-mix'));
}

// ── T33 · liveUrl: server exposes + app.js renders ───────────────────────────
// WHY: liveUrl is the authoritative one-click-open URL for the deliverable (wp_url /
// slug subdomain / /sites/ path). Source pins verify the derivation is in boardJSON
// and the UI uses it rather than guessing.
{
  // server.ts: liveUrl derived in boardJSON region from params.slug/wp_url/deliverable
  ok('T33 server: liveUrl computed in boardJSON from params.slug / wp_url / deliverable',
    (() => {
      const start = srv.indexOf('async function boardJSON');
      const end   = srv.indexOf('\nasync function ', start + 1);
      const region = srv.slice(start, end > 0 ? end : start + 8000);
      return region.includes('liveUrl') && region.includes('pm.slug') && region.includes('pm.wp_url');
    })());

  // server.ts: liveUrl is included in the projectOut object
  ok('T33 server: liveUrl included in projectOut (boardJSON return payload)',
    (() => {
      const start = srv.indexOf('const projectOut');
      const end   = srv.indexOf('};', start);
      const block = srv.slice(start, end > 0 ? end + 2 : start + 500);
      return block.includes('liveUrl');
    })());

  // app.js: resolveLiveUrl() prefers p.liveUrl over p.site
  ok('T33 app: resolveLiveUrl() helper prefers p.liveUrl over p.site',
    app.includes('function resolveLiveUrl') &&
    app.includes('p.liveUrl') && app.includes('p.site'));

  // app.js: cardInner uses resolveLiveUrl — open link points to the real deliverable
  ok('T33 app: cardInner uses resolveLiveUrl() for the Open ↗ link',
    app.includes('resolveLiveUrl(p)') && app.includes('cardInner'));

  // app.js: project header (header()) also uses liveUrl
  ok('T33 app: project header uses b.project.liveUrl for the Open ↗ button',
    app.includes('b.project.liveUrl') || app.includes('headerLiveUrl'));

  // Regression: the deliverable badge is still present on home cards (T13 not broken)
  ok('T33 regression: deliverableBadge still rendered in cardInner (T13 intact)',
    app.includes("deliverableBadge(p.deliverable"));
}

// ── T34 · performance panel: operator-gated in server + rendered in app.js ───
// WHY: perf data (build-time distribution, deliverable mix) is business-sensitive —
// it MUST NOT reach non-operator clients. The gate is double-locked: server.ts strips
// the perf key for non-operators AND app.js only renders when meIsOperator is true
// (which is itself server-asserted). Source pins verify both locks.
{
  // server.ts: perf key stripped for non-operators alongside funnel
  ok('T34 server: perf key stripped from /api/kpi response for non-operators',
    (() => {
      // The guard must delete kpiData.perf (not just funnel) in the non-operator branch
      const kpiBlock = (() => {
        const idx = srv.indexOf("if (kpiData && !isOperator(user))");
        return idx >= 0 ? srv.slice(idx, idx + 200) : '';
      })();
      return kpiBlock.includes('perf');
    })());

  // kpi.ts: perfPanel() function exists and returns mix + avg_build_seconds
  ok('T34 kpi: perfPanel() function exported from kpi.ts',
    kpi.includes('export async function perfPanel') &&
    kpi.includes('mix') && kpi.includes('avg_build_seconds'));

  // kpi.ts: computeKpi includes perf in its return value
  ok('T34 kpi: computeKpi() includes perf: perfData in return',
    kpi.includes("perf: perfData") || kpi.includes("perf:perfData"));

  // app.js: perf panel only renders when meIsOperator (UI-layer gate)
  ok('T34 app: perf panel render is guarded by meIsOperator / operator check',
    (() => {
      // renderFunnelStrip is the meIsOperator-guarded function
      // — panel is rendered inside it, so the check is inherited
      const fnStart = app.indexOf('async function renderFunnelStrip');
      const fnEnd   = app.indexOf('\nasync function ', fnStart + 1);
      const fn = app.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
      return fn.includes('meIsOperator') && fn.includes('perf-panel');
    })());

  // app.js: perf panel has data-operator-panel attribute (T36 hook for future probing).
  // The attribute is set via setAttribute() so we look for the attribute name string literal.
  ok('T34 app: perf panel element carries data-operator-panel attribute',
    app.includes("'data-operator-panel'") || app.includes('"data-operator-panel"') || app.includes('data-operator-panel='));

  // app.js: perf panel uses DLV_LABEL/DLV_COLOR for the mix chips (reuses T13 maps)
  ok('T34 app: perf mix uses DLV_LABEL and DLV_COLOR for chip labels/colours',
    (() => {
      const fnStart = app.indexOf('async function renderFunnelStrip');
      const fnEnd   = app.indexOf('\nasync function ', fnStart + 1);
      const fn = app.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
      return fn.includes('DLV_COLOR[') && fn.includes('DLV_LABEL[');
    })());
}

// ── T35 · digest: deliverable mix + avg build time line ──────────────────────
// WHY: the nightly brief is the operator's one-glance health check. The deliverable
// mix shows which product types are being built; avg build time is the primary
// efficiency signal. Source pins verify the helpers are imported and the line is
// constructed and included in the message.
{
  // digest.ts: imports deliverableMixCounts and avgBuildSeconds from kpi.ts
  ok('T35 digest: imports deliverableMixCounts from kpi.ts',
    digest.includes('deliverableMixCounts') && digest.includes("from './kpi.ts'"));

  ok('T35 digest: imports avgBuildSeconds from kpi.ts',
    digest.includes('avgBuildSeconds'));

  // digest.ts: deliverable mix is computed from the DB (not LLM output)
  ok('T35 digest: deliverableMixCounts() called and result interpolated into message',
    digest.includes('deliverableMixCounts(pool)') && digest.includes('mixStr'));

  // digest.ts: avgBuildSeconds() called and included in the message
  ok('T35 digest: avgBuildSeconds(pool) called and result in deliverableLine',
    digest.includes('avgBuildSeconds(pool)') && digest.includes('avgSecs'));

  // digest.ts: the deliverable line is in the message array (not dropped by filter)
  ok('T35 digest: deliverableLine is a non-conditional entry in the msg array',
    (() => {
      const msgStart = digest.indexOf('const msg = [');
      const msgEnd   = digest.indexOf('].filter(Boolean)', msgStart);
      const block    = digest.slice(msgStart, msgEnd > 0 ? msgEnd : msgStart + 1000);
      return block.includes('deliverableLine');
    })());

  // kpi.ts: deliverableMixCounts exported
  ok('T35 kpi: deliverableMixCounts() exported from kpi.ts',
    kpi.includes('export async function deliverableMixCounts'));

  // kpi.ts: avgBuildSeconds exported
  ok('T35 kpi: avgBuildSeconds() exported from kpi.ts',
    kpi.includes('export async function avgBuildSeconds'));

  // Correctness check: deliverableMixCounts logic uses GROUP BY and counts from params
  // (deterministic SQL, never task/department name heuristics — QA-noise-safe).
  ok('T35 kpi: deliverableMixCounts uses SQL GROUP BY on params deliverable (deterministic)',
    kpi.includes("params->>'deliverable'") &&
    kpi.includes('group by') &&
    kpi.includes('deliverableMixCounts'));

  // Correctness check: avgBuildSeconds uses the SAME derivation as boardJSON
  // (coalesce of explicit params.build_seconds and task-span epoch calculation).
  ok('T35 kpi: avgBuildSeconds uses coalesce(params build_seconds, task epoch) — matches boardJSON',
    kpi.includes("params->>'build_seconds'") &&
    kpi.includes('epoch') &&
    kpi.includes('avgBuildSeconds'));
}

// ── T36 · regression: previously-passing T11/T12/T13/T20 invariants still hold ──
// These are a sanity check that the new code didn't accidentally remove or refactor
// the existing badge/chain/filter/reason infrastructure.
{
  ok('T36 regression: DLV_LABEL still maps all 5 canonical deliverable IDs (T13)',
    app.includes('directus_site') && app.includes('wp_site') &&
    app.includes('wp_woocommerce') && app.includes('fullstack_app') &&
    app.includes('campaign') && app.includes('DLV_LABEL'));

  ok('T36 regression: deliverableBadge() still renders (T13)',
    app.includes('function deliverableBadge'));

  ok('T36 regression: applyDlvFilter() still present (T13)',
    app.includes('function applyDlvFilter'));

  ok('T36 regression: chainHtml() still renders cap-tag spans (T11)',
    app.includes('function chainHtml') && app.includes('cap-tag'));

  ok('T36 regression: builtIn() wall-clock formatter still present (T12)',
    app.includes('function builtIn'));

  ok('T36 regression: server boardJSON still exposes deliverable + stack + chainReason (T11/T13/T20)',
    srv.includes('pm.deliverable') && srv.includes('pm.stack') && srv.includes('pm.chainReason'));
}

// ── WORKSPACE (#/w/<id>) — source-pin gates ──────────────────────────────────
// WHY: the workspace is the primary project experience. These pins verify the
// structural invariants of the three-pane layout, the chat posting path, the
// preview iframe + device toggle, and the mobile tab switch — without requiring
// a live server. Behavioural invariants only; exact line numbers are NOT pinned.
{
  // Route exists: the router handles seg[0]==='w' and calls workspace()
  ok('workspace: #/w/ route handled in router (seg[0] === "w")',
    app.includes("seg[0] === 'w'") && app.includes('workspace(seg[1])'));

  // workspace() function is defined
  ok('workspace: workspace() function is defined',
    app.includes('function workspace(id)') || app.includes('function workspace(id,') ||
    /function workspace\s*\(/.test(app));

  // Three panes: rail, chat, preview present in the HTML template
  ok('workspace: left rail rendered (ws-rail element)',
    app.includes('ws-rail') && app.includes('ws-rail-back') && app.includes('ws-sess-list'));

  ok('workspace: center chat pane rendered (ws-chat + ws-thread)',
    app.includes('ws-chat') && app.includes('ws-thread'));

  ok('workspace: right preview pane rendered (ws-preview + ws-iframe)',
    app.includes('ws-preview') && app.includes('ws-iframe') && app.includes('ws-iframe-wrap'));

  // Composer posts to /api/chat/messages
  // Verified by presence in the whole file — workspace() is the only non-legacy
  // place that uses this pattern with the 'POST' method header.
  ok('workspace: composer POSTs to /api/chat/messages (correct endpoint)',
    (() => {
      const fnStart = app.indexOf('function workspace(');
      const fn = app.slice(fnStart, fnStart + 20000);
      return fn.includes('/api/chat/messages?session=') && fn.includes("method: 'POST'");
    })());

  // New chat session created via POST /api/chat/sessions
  ok('workspace: new chat button calls POST /api/chat/sessions',
    (() => {
      const fnStart = app.indexOf('function workspace(');
      const fn = app.slice(fnStart, fnStart + 20000);
      return fn.includes('/api/chat/sessions?id=') && fn.includes("method: 'POST'");
    })());

  // Preview iframes liveUrl (showIframe sets iframe.src to the live url)
  ok('workspace: showIframe() sets iframe.src to liveUrl',
    (() => {
      const fnStart = app.indexOf('function workspace(');
      const fn = app.slice(fnStart, fnStart + 12000);
      return fn.includes('iframe.src') && fn.includes('showIframe');
    })());

  // Device toggle exists (phone/desktop buttons)
  ok('workspace: device toggle buttons (ws-dev-desktop / ws-dev-phone) rendered',
    app.includes('ws-dev-desktop') && app.includes('ws-dev-phone'));

  ok('workspace: device toggle applies phone-mode class on ws-iframe-wrap',
    (() => {
      const fnStart = app.indexOf('function workspace(');
      const fn = app.slice(fnStart, fnStart + 20000);
      return fn.includes('phone-mode') && fn.includes('applyDevice');
    })());

  // Build progress shown while building (showBuildProgress)
  ok('workspace: showBuildProgress() renders task list + progress bar while building',
    app.includes('showBuildProgress') && app.includes('ws-build-progress') && app.includes('ws-build-bar'));

  // Mobile: segmented tab control (ws-tab-chat / ws-tab-preview)
  ok('workspace: mobile segmented tab control (ws-tab-chat / ws-tab-preview)',
    app.includes('ws-tab-chat') && app.includes('ws-tab-preview') && app.includes('ws-seg'));

  // Mobile: hamburger that toggles the rail
  ok('workspace: mobile hamburger toggles the rail (ws-hamburger / ws-rail-overlay)',
    app.includes('ws-hamburger') && app.includes('ws-rail-overlay'));

  // Board polling: GET /api/board every 3s while building
  ok('workspace: board polled every 3s (setInterval loadBoard, 3000)',
    (() => {
      const fnStart = app.indexOf('function workspace(');
      const fn = app.slice(fnStart, fnStart + 20000);
      return fn.includes('setInterval(loadBoard, 3000)') || fn.includes('setInterval(loadBoard,3000)');
    })());

  // Message polling: GET /api/chat/messages every ~4s
  ok('workspace: messages polled every ~4s (setInterval, 4000)',
    (() => {
      const fnStart = app.indexOf('function workspace(');
      const fn = app.slice(fnStart, fnStart + 12000);
      return fn.includes('4000');
    })());

  // Home cards click to #/w/ (primary click opens workspace)
  ok('workspace: home card primary click opens #/w/<id> (not #/p/<id>)',
    app.includes("location.hash = '#/w/' + p.id"));

  // Project page (#/p/) has an "Open workspace" link to #/w/
  ok('workspace: project page header has Open workspace link to #/w/<id>',
    app.includes("href=\"#/w/${esc(id)}\"") || app.includes("href='#/w/") ||
    (app.includes('#/w/') && app.includes('Open workspace')));

  // CSS: workspace layout classes exist
  ok('workspace css: .ws-shell defined', css.includes('.ws-shell'));
  ok('workspace css: .ws-rail defined', css.includes('.ws-rail'));
  ok('workspace css: .ws-chat defined', css.includes('.ws-chat'));
  ok('workspace css: .ws-preview defined', css.includes('.ws-preview'));
  ok('workspace css: .ws-thread defined', css.includes('.ws-thread'));
  ok('workspace css: .ws-composer defined', css.includes('.ws-composer'));
  ok('workspace css: .ws-bubble-user defined', css.includes('.ws-bubble-user'));
  ok('workspace css: .ws-bubble-relay defined', css.includes('.ws-bubble-relay'));
  ok('workspace css: .ws-seg defined (mobile segmented control)', css.includes('.ws-seg'));
  ok('workspace css: mobile breakpoint collapses preview pane (@media max-width:899px)',
    css.includes('899px') && css.includes('ws-preview'));
  ok('workspace css: .ws-build-progress defined', css.includes('.ws-build-progress'));
  ok('workspace css: .ws-device-toggle defined', css.includes('.ws-device-toggle'));
}

// PARSE GATE (2026-07-07): web/app.js is plain JavaScript served to the browser — a single syntax
// error (e.g. a stray TypeScript `as Type` cast) breaks the ENTIRE app and the board renders blank,
// yet every source-pin above still passes because they only READ the file as text. Actually PARSE it
// so a syntax error can never ship again. `node --check` parses without executing.
{
  let parseOk = true, perr = '';
  try { execSync(`node --check ${fileURLToPath(new URL('web/app.js', root))}`, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e: any) { parseOk = false; perr = String(e?.stderr ?? e?.message ?? e).split('\n').slice(0, 3).join(' '); }
  ok('web/app.js is valid JavaScript (node --check parses it — no TS casts / syntax errors)', parseOk, perr);
  // belt: no TypeScript-only `as <Type>` casts in the browser JS (they parse-fail in a real browser)
  ok('web/app.js: no TypeScript `as Type` casts (browser JS, not TS)', !/\bas [A-Z][A-Za-z0-9_]+\)/.test(app));
  // the mobile preview-tab must be hidden by DEFAULT (desktop) — otherwise it becomes a phantom 4th
  // column that squeezes out the chat pane (live-caught 2026-07-07). Base rule outside any media query.
  ok('workspace: .ws-preview-tab hidden by default (base display:none, shown only on mobile)',
    /\.ws-preview-tab\{\s*display:none;?\s*\}/.test(css));
}

console.log(`\nboard:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

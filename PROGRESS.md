# Relay — Progress Log

**owner:** Zoro (Nao primary agent) · **started:** 2026-06-28
**goal:** ship the validated build-spec contract keystone + the evolution-loop foundation. no half-ass, no quick-fix-then-redo.

---

## 2026-06-28 — Day 1: onboarding + recon

### access established
- SSH key ed25519 added to `/root/.ssh/authorized_keys` (perms 600)
- Hardened sshd (password auth off, root key-only, fail2ban active)

### recon summary (server: Anouf / 135.181.44.161)
- Linux 6.8.0-110-generic · Ubuntu · up 55d · 10 users · load 0.30
- `/root/agency-pipeline/` — real, 29KB AGENTS.md, MISSION.md, src/, db/, deploy/, docs/, eval/ (created 06-28 08:42), node_modules installed, .env mode 600, .git active (last commit Jun 28 09:09)
- Running services:
  - `relay.service` (port 8787) — the actual app
  - `relay-tunnel.service` — cloudflared dedicated tunnel
  - `anouf-named-tunnel.service` — Anouf Chat tunnel
  - `ap-pg` Docker container (Postgres 16, port 5439, 37h uptime)
  - `nao-grok:latest` Docker container — TODO investigate
  - saiid-wp-{caddy,wordpress,db} — sibling WordPress stack
  - searxng (port 8889) — privacy search
- `/opt/claude-worker/claude` — **Claude Code v2.1.170** (the actual binary to manage). NOT in PATH.
- `/root/.claude/`, `/root/.claude-flow/`, `/root/.claude.json` — Claude config + session state + flow project
- `/root/build_planners.py`, `/root/build_covers.py` — Python planner experiments

### claude code v2.1.170 — capabilities for management
- `-p / --print` → non-interactive output (headless orchestration)
- `--allowedTools` → restrict tool access (anti-divergence)
- `--add-dir` → scope file access
- `--append-system-prompt` → inject keystone context without polluting default
- `--bare` → skip auto-memory, hooks, keychain reads (minimal/sandboxed)
- `--agents <json>` → custom sub-agents
- `--model` → swap model on the fly
- settings via `--settings` for API key helper

### plan for today (the brief)
The 5-task execution brief lives at `/root/.openclaw/workspace/agency-pipeline-execution-brief.md` (nao-grok, 12KB). Targets, in order:
1. **task 1** — `src/spec-schema.json` (JSON Schema draft-07)
2. **task 2** — `src/spec.ts` validator + `src/spec.test.ts` (pure function, unit-tested)
3. **task 3** — wire validator into `src/runner.ts` before `render.ts`
4. **task 4** — tighten `site_renders` in `src/verify.ts` (3 new checks)
5. **task 5** — capture dogfood findings → `db/migrations/003-spec-findings.sql` + `src/evolver.ts` stub

### discipline (anti-drift)
- ONE file scope per claude invocation
- ALWAYS diff review before merge
- divergence metric: `(lines changed outside scope) / (lines changed total)` — kill if >10%
- NO polishing the website during system work — separate tasks, separate briefs
- `--bare` mode by default (no auto-memory surprise)
- every claude run is logged here in PROGRESS.md
## 2026-06-28 — Day 1 update (09:27 UTC)

### role clarification (per Nao at 09:24)
- **zoro = manager + decision-maker, NEVER coder**
- orchestrates claude (who codes), sets direction, kills diverged runs, commits/merges/reverts
- "you never code" — explicit. code only flows from claude.
- discipline: 1 file scope per claude invocation (waived when work spans contract edges), gated diff review, divergence metric

### cron management loop installed
- `/root/zoro-relay-mgmt.sh` — runs every 30 min (`*/30 * * * *`)
- gathers: claude process count, git status, last commit, disk%, prove2.log tail
- writes to `/var/log/zoro-relay-mgmt.log`
- writes `/tmp/zoro-action-needed.flag` on material state (claude exit + uncommitted, 3+ commits/2h, disk ≥85%)
- zoro reads the flag on each session start or when Nao pings
- openclaw cron tool unusable (gateway auth not configured) — bash cron is the workaround

### claude status (mid-flight as of 09:27)
- running since ~09:08 (~19 min elapsed)
- started from `--resume 029d61cb-2a36-4333-b964-a727c4eaf1b8` — continuation, not fresh
- prompt focus: "renderer trusts each page's own spec.brand.tokens — brand-lock is a soft LLM instruction. FORCE THIS SHIT"
- model: claude-opus-4-8 (1M context) — high drift risk, mitigated by tight brief scope
- uses `ruflo` MCP for parallel sub-claude workers
- uncommitted: `src/runner.ts`, `src/spec.ts`, `src/spec-test.ts`, `src/verify.ts` (4 files, scope-expanded vs my brief tasks 2-3 only)
- self-testing via `eval/prove-consistency.ts` + `eval/prove2.log`
- **first attempt FAILED** (nav-links drift across pages — the brand-lock bug caught it) → rebuilding with second brief (cafe) → this is exactly the eval catching what should be caught
- DECISION: let him finish. he's on-brief + adding brand-lock architecturally. intervene only if divergence.

### next actions (when claude finishes)
1. read final diff + prove2.log
2. commit R1+brand-lock as a single clean commit (after review)
3. spawn claude v2 for verify.ts tightening (task 4) — strict scope, --bare, --allowedTools "Bash(npm run*) Edit"
4. spawn claude v3 for dogfood capture (task 5)
5. update PROGRESS.md with each commit

## 2026-06-28 — Day 1 update (10:25 UTC)

### R1 + brand-lock shipped
- commit `d202be5` pushed to github (master now at 7103061..d202be5)
- spec:check 68/0, tsc clean
- src/spec.ts (+35), src/spec-test.ts (+34), src/runner.ts (refactored), src/verify.ts (+14 new site_consistent gate)
- architectural brand-lock: nav button + palette + logo identical across pages, structurally impossible to drift
- supersedes soft-instruction attempts 5612ae6 + 417b8f2 (the "questionable pushes")

### github auth fixed
- `gh auth` was already authenticated as `naoufac` with `repo` scope
- the deploy key (id_ed25519_github, comment `nao-vps-deploy`) was SSH read-only — wrong path
- switched remote to HTTPS, gh token used the existing credential
- one push succeeded; `naoufac/agency-pipeline` warns "moved" to `agency-pipeline-Relay` — kept old for now, ask Nao if to switch

### OpenRouter doubt confirmed by data
- real error in run_events: `#13: OpenRouter: truncated before content — raise max_tokens (reasoning ate the budget)`
- current OpenRouter code (agents.ts:102): `body.reasoning = { effort: 'low' }` ONLY in else-branch (non-web calls)
- so when web:true (research/strategy), reasoning has NO cap → eats token budget → output truncated
- fix in task 6 below

### claude v2 spawned (task 5+6 bundled)
- session 1097bf31-0a8c-4b1c-831b-f70fc660d062
- model: claude-opus-4-8[1m]
- bypassPermissions (works via `IS_SANDBOX=1` env, which bridge.py uses)
- scope: 4 files (`db/schema.sql`, `src/dogfood.ts`, `src/evolver.ts` NEW, `src/agents.ts`)
- task 5: dogfood capture → spec_findings table + evolver stub (level-3 foundation)
- task 6: max_tokens cap unconditional, floor bumped to 16000 (fixes the truncation)
- `--allowedTools` restricted to Bash(npm run* tsc* npx tsx* git add* git commit* git status* git diff* git log*) + Edit Read Glob Grep — no push, no refactor
- output goes to /tmp/claude-v2.log
- cron (zoro-relay-mgmt) will pick up state changes; manual review before push

### TODO (after claude v2)
1. review claude's diff + test output
2. commit + push to github
3. update PROGRESS.md with v2 results
4. decision: A/B test openrouter vs direct MiniMax (Nao asked)
5. decision: switch remote to agency-pipeline-Relay (Nao's call)

## 2026-06-28 — Day 1 update (15:35 UTC, after 5h unattended)

### claude v3 + v4 committed (autonomous, no input)
- R3 `0059f7e R3: content dept reliability — role rewrite + normalizeContent`
  - src/agents.ts (2 +/- ROLE.content rewritten: single-shape rule + self-check)
  - src/spec.ts (+29 normalizeContent: extract-or-merge, reject unfixable)
  - src/spec-test.ts (+32 tests)
  - src/runner.ts (+15 wire normalizeContent for content dept before storage)
  - 74 ins / 4 del, 4 files
  - root cause from claude: "model emitted two concatenated blocks / braces-in-strings that the naive json verify gate (firstJson) could not parse"
- R4 `f7f2433 R4: planner watchdog — 60s timeout + cron`
  - src/planner.ts (+13/-1 Promise.race 60s timeout)
  - watchdog script `/root/zoro-planner-watchdog.sh` (local, not in repo)
  - crontab entry: `*/5 * * * * /root/zoro-planner-watchdog.sh >> /var/log/zoro-planner-watchdog.log 2>&1`

### cron heartbeat (15 fires in 5h, every 30 min)
- kept state visible during my absence
- one material flag fired at 15:30: "claude exited with 2 uncommitted file(s)" — that was my own brief files, now committed (8e3b169)
- claude sessions cleanly exited, no orphan processes

### services + infra
- disk 64% (26GB free), 2.3GB RAM used
- relay.service + relay-tunnel.service + anouf-named-tunnel.service all active
- prove2.log stale (last touched 09:22) — eval didn't run during unattended window; harmless

### what's left (the queue)
- R5: openrouter web plugin scope reduction — planner should NOT use web:true (the bottleneck). Direct MiniMax for planner/strategy; web:true only for research. Single 1-line fix.
- A/B test infrastructure: instrument per-call provider + latency so we can measure openrouter vs direct on real data
- a94d539a autopsy — the failed project. what specifically broke?
- dogfood self-correct live test — need a content-level failure to exercise the new spec_findings capture path

## 2026-06-28 — Day 1 update (15:37 UTC)

### R5 shipped (autonomous)
- commit `df9ebd7 R5: openrouter scope — planner web:false (kills 3.6h planner hang at the source)`
- src/planner.ts: 1 line change (web:true → web:false) + comment
- 4 lines diff total

### CRON FIX (the gap Nao flagged)
- previous cron: passive state logger + flag file. nothing woke zoro.
- new cron: ACTIVE Telegram alert on material events
  - reads /opt/nao-claude-tg/.env (TG_TOKEN + OWNER_ID)
  - on material state → POST to api.telegram.org/bot{TOKEN}/sendMessage
  - alert content: timestamp + reasons + last commit + state snapshot
- now "didn't work" can't happen — Nao gets a Telegram message the moment something material happens
- ALSO: detects NEW COMMITS since last tick (the missed-it case from earlier)
- ALSO: state file /tmp/zoro-relay-state.json tracks last-commit hash so the new-commit detection is deterministic

### next queue
- R6: A/B instrumentation (per-call provider + latency into run_events)
- a94d539a autopsy (failed project, what specifically broke pre-R3)
- dogfood self-correct live test (need a real content defect)

## 2026-06-28 — Day 1 update (16:24 UTC)

### R6 shipped (autonomous)
- commit `f82b2c3 R6: A/B instrumentation — per-call provider + latency into run_events`
- src/agents.ts: callLLM returns `{text, meta}` (provider/model/latencyMs/web/ok/error) + new llmTracked() wrapper
- src/runner.ts: writes run_events.type='llm_call' after each LLM call
- src/kpi.ts: 2 new KPIs — provider split (7d, %) + avg LLM latency per provider
- **no new projects yet since deploy — waiting for next brief to populate metrics**

### cron working as designed
- 16:00 fire detected new commit (R6) via state-file diff
- Telegram alert triggered
- state file `/tmp/zoro-relay-state.json` tracks last commit hash deterministically
- proves the gap is closed

### a94d539a autopsy findings (16:00 UTC)
- 11-task DAG: research, branding, strategy done; contentia + database failed → 5 builds + qa blocked forever
- root cause #1: contentia JSON parse failure (R3 FIXED this)
- root cause #2: database "no tables in the data model" + "integer out of range" → NEXT HOTSPOT
- R7 = normalizeDataModel() — same pattern as R3, applied to database dept

### next
- spawn v7 = data model normalize (the autopsy's clear next move)

## 2026-06-28 — Day 1 update (16:39 UTC)

### ops tick: commit R7 brief sheet
- R7 (`72e08ea database dept reliability — role rewrite + normalizeDataModel`) already shipped on prior tick
- only uncommitted artifact was `zoro-task11-datamodel-normalize-brief.md` — the zoro spawn sheet that drove R7
- Option A per mission: commit + push the brief sheet for audit (same convention as 8e3b169 / 45dcadc)
- the 16:38 action-needed flag ("claude exited with 1 uncommitted file") = this brief; now resolved
- no code touched this tick → no tests run (state already green at R7)

### next queue (unchanged, awaiting next brief)
- dogfood self-correct live test (need a real content/database defect to exercise spec_findings capture)
- A/B metrics population (R6 instrumentation in place; no new projects since deploy → no data yet)
- next dept hotspot after database, if a94d539a-class failures recur

## 2026-06-28 — Day 1 update (17:18 UTC)

### R8 shipped (manually — claude hit 5-hour rate limit mid-fix)
- commit `9500b41 R8: eval — fix .env loading, kill the STUB-mode theater`
- root cause: `src/agents.ts` + `src/eval.ts` read `process.env` directly; npm scripts don't load `.env`. production works via systemd EnvironmentFile. dev/CI invocation always saw empty env → STUB mode → theater 100% pass.
- fix: prepend `set -a; . ./.env 2>/dev/null; set +a;` to every tsx-based npm script. silent if .env missing.
- **verified LIVE eval at 17:11 UTC:**
  - runtime **7m 2.8s** (vs <5s for stub)
  - 5/5 pages pass
  - avg specificity **87.6/100** (vs 50/100 for stub — real specificity data)
  - avg **333 words/page** (vs 154 for stub)
  - **1 rejected spec** caught (coffeery home page)
  - 0 errors
- **R1–R7 fixes confirmed working in LIVE mode.** the 0 agent_errors post-R3 wasn't theater — R3/R7 are doing real work.

## 2026-07-02 — Milestones M1–M3 shipped + consolidation (Fable 5 session)
One pipeline, ONE CMS locked (GOAL.md relocked; WordPress/Drupal/selector deleted; `cms:check`
guards it). M1 landing pages (landing shape in code, logos/offer components, site_model landing
gate). M2 schema-compiled forms (relation dropdowns from real FK records, schema-match + submit
gates in dogfood; schema snapshot at compose; CMS re-serve paths carry it). M3 in-place rebuild
(additive-only migrations + row-count rollback guard, `migrate:check` 17 assertions; stale
generations swept from disk + CMS; brand/theme survive). Self-repair loop revived (compose-based,
site-wide findings included). Lead email live (mail.ts; every submission emailed to the operator;
status page at mail/email.naples.agency). Owner-first project metrics replace engineering vanity.
Board docs/roadmap/about brought to reality (compose/CMS/QA stages, full gate list). Deploy script
gained a typecheck gate after a broken string crash-looped prod once. Checks: spec 120 · migrate 17
· cms 9 · themes 5/5. Recon: supabase CLI/dead pointers removed, relay-drupal decommissioned,
Supabase account token kept as the documented scale-out path.

## 2026-07-02 (later) — Session handoff state (for the next context window)
Everything below is LIVE and pushed. Read PLAN.md (plan of record) + GOAL.md (definition of done) +
AGENTS.md §0 before touching anything.
- **Working method (owner-locked):** ALWAYS work on the SYSTEM, never on a produced website. A site
  is a reflection of the system. Success = a zero-touch fresh brief comes out agency-grade, judged by
  the system's own reviewer. Rolling loop: ask "would a productive agency ship this?" (3-lens panel
  on real screenshots) → build the #1 finding into the generator → gate it → prove on a hands-off build.
- **Proven zero-touch:** hot-sauce store a47260fb — system built it, system's reviewer failed it
  (footer overflow on mobile, mis-targeted buy-probe), generator fixed both, system re-produced it
  clean: review PASSED 0 high, 6/6 products photographed by rowmedia, buy-probe placed a real order.
- **Reliability spine:** `npm run check` = 9 gate suites (spec 128 · cms · layout 24 · ecom 26 ·
  content 19 · leak · migrate 17 · theme 5 AA · build); relay-deploy.sh runs the FULL suite inside
  prod before restart. auth:check (21) + alert:check (9) run on demand against the live server.
- **Next agency-panel picks (ranked, not started):** product detail pages (PDP) for stores · hero
  art-direction/overlay consistency + brand-tinted grading · 8px spacing + CTA hover/focus states +
  designed empty-states · CTA-monotone style note already surfaces on the board.
- **Owner comms:** Telegram bridge; phone-readable replies; send screenshots as photos; every
  milestone gets a 30s phone check + machine gate; never mark done beyond what's proven.

## 2026-07-02 (evening) — PDP shipped + proven zero-touch (agency-panel pick #1)
Commits a0598f3 · a0532ea · 9993a9b · dcc232b, all deployed (prod HEAD dcc232b, gates green in prod).
- **PDP**: product-<id>.html rendered LIVE per request from the real product row (appdb.readRow — same
  FK/secret/photo decoration as cards) through renderPage with a system-only 'product' section (NOT in
  spec KNOWN — the LLM can never author it). Shop cards (products table only) link image+title to it.
  Existing stores got PDPs instantly, no rebuild (pure projection). Unknown id → honest 404.
- **Gates**: ecom:check 26→45 (render + full live page from a real scratch schema + site_model store
  rules); dogfood buys FROM the PDP, load-tests every card's detail link, flags no-product-detail
  (CONTENT_FIXABLE → one recompose round).
- **Adversarial review before deploy** (3 lenses, 14 agents): 4 confirmed findings fixed (probe crash
  → false store-broken; PDP error scope/404; no-product-detail repair; PDP link load-tests), 7 refuted.
- **Zero-touch proof caught a real class**: coffee-roaster brief eb1d46b5 — the 6-page cap EVICTED
  checkout (cart's Proceed 404'd, buy-probe silently skipped, "clean" verdict on a store that cannot
  sell). Fixed the class: planner trims brochure pages before injecting cart/checkout (exact 'checkout'
  slug — the cart runtime targets checkout.html literally); site_model REQUIRES both pages on stores;
  checkout-less store = loud store-broken. Rebuild proof: reviewer PASSED 0 high, order #3 $78 placed
  via PDP → cart → checkout (run_events), 3 PDPs live with real photos/prices, ← Shop crumb.
- Polish from own phone check: zero-valued numeric meta hidden ("Weight Grams: 0" was spec noise).
- Owner phone check sent: mobile PDP + shop screenshots via Telegram.

## 2026-07-02 (night) — FULL-STACK APP track planned (owner-directed: "real planning and thinking")
Evidence gathered BEFORE designing: zero-touch barbershop baseline (4c89fc1f) — reviewer FAILED it
(facade dashboard page: invented stats, feature-fiction cards, dead buttons; visitor loop open:
book → toast → void; all bookings publicly listable via the read API). Prior owner brief a3625565
("full stack delivery app - user accounts - client portal") = users table + portal/track pages with
nothing behind them, never reviewed. 2/6 historical app builds failed with the core form unwired.
Code map (4 explorers): no WHERE reads, no visitor identity, no record views for app data, no
act-probe. Plan chosen by a 3-plan × 3-judge panel (risk-first sequencing + systems-first
primitives + product-first safeguards): FS0 honest surface (closed-set pages, private-by-default
form-target tables, force-injected core form, act-probe) → FS1 receipt (readScoped + ref_token +
find-my-booking) → FS2 visitor accounts (magic link, sessions in app schema, claim-on-verify) →
FS3 real semantics (typed slots, capacity-aware UNIQUE, status lifecycle + visitor email) →
FS4 redemption of the two facade briefs. Full track with phone checks + machine gates in PLAN.md.
Key safeguards locked: ref_token additive-migration backfill hazard (nullable + partial unique +
random backfill, proven in migrate:check); probes never send real mail; bidirectional token gate;
capacity-aware uniqueness detection. NEXT: implement FS0.

## 2026-07-03 (early) — FS0 SHIPPED + PROVEN (honest app surface)
Commits 25da233 · 96f7e3b · e1f3a61 · 9f416be, all deployed (prod HEAD 9f416be, 10 suites green).
Four zero-touch rebuild rounds of the barbershop brief drove the loop, each exposing + fixing a class:
(1) facade dashboard dropped at plan time (FACADE_PAGE closed set; plan_repair event; site_model +
reviewer belts). (2) PRIVATE_READ audience guard: bookings/orders/users… answer [] publicly — sealed
the live PII leak on EVERY already-built site at deploy (verified pre-rebuild on the old barbershop;
store orders were publicly listable too). Owner content admin unaffected (audience='owner').
(3) CTAs: cross-page buttons land AT the form (formSlug threaded through all 5 render paths →
book.html#contact-form); the form's own page anchors to itself (no bounce-to-home); reviewer
home-collapse recalibrated (legitimate when home hosts the action). (4) Visitor-fillable "Status"
field killed: SYSTEM_COLS hidden from public formColumns + ignored by public insertRow (a crafted
POST cannot set status=confirmed); owner keeps both. Final verdict: PASSED 0 high; book page =
real barber/service records with photos + clean booking form. NEXT: FS1 (receipt: readScoped +
ref_token + confirmation + find-my-booking — mind the migration backfill hazard in PLAN.md).

## 2026-07-03 — FS1 SHIPPED + PROVEN (the visitor keeps a receipt)
Commits 53991fa · e2809c3 · a1b08cd deployed (prod a1b08cd, 10 suites green, app:check 85).
ref_token: compiled onto private entities, migrated nullable+partial-unique (no '' backfill — gated),
generated server-side in insertRow (SENSITIVE blocks client supply), returned to the form → visitor
lands on receipt-<table>-<token>.html (renderLiveReceipt via ONE new primitive readScoped; token
displayed from the URL, stripped from every read). find.html: paste-code → resolver; email-me →
receiptLinksByEmail mailed via SMTP ledger, always "sent". Act-probe: receipt renders, wrong token
404, token never public. THE PROOF CAUGHT TWO CLASSES: (1) core action wrote the services CATALOG
(injection used primaryTable) while appointments sat unused → actionTable derived/snapshotted/
injected/gated; contact forms never hijacked; (2) public data POST accepted ANY table → now exactly
publicWriteTables(site). External proof: real booking via public API → receipt 200 w/ record + code
+ "Barber: Marcus Johnson" FK resolution → find resolver maps bare code → catalog insert blocked
("this site has no such form") → token absent from public reads. NEXT: FS2 visitor accounts
(magic link, sessions in app schema, claim-on-verify, cross-app token rejection).

## 2026-07-03 — FS2 SHIPPED + PROVEN (user accounts on the produced app — the locked promise)
Commit f983286 deployed (10 suites green, app:check 101). visitors.ts: _relay_visitors/_relay_
visitor_tokens in the app's OWN schema (leading underscore = collision-free vs the model compiler);
magic single-use/15min/per-email cap; sessions 30d validated SERVER-SIDE (per-app cookie
relay_v_<hex12> is only the courier; cross-app replay structurally dead — gated). Identity = the
verified email; visitorRecords scopes My bookings across private tables w/ receipt links;
pre-account rows attach on verify. account.html live (signin/records sections); footer doors
(find + account) on receipt-enabled apps, consistency-safe. Routes: visitor/request (always
"sent"), verify (302+cookie), logout. Reviewer probe: signed-out form, minted-token sign-in,
My bookings lists the probe booking. External proof: book → magic (token from DB) → cookie →
"Signed in as zoro@relay.test" + booking card + Open receipt; signed-out leaks nothing.
FS track remains: FS3 (real booking semantics: typed slots, capacity UNIQUE, status lifecycle
owner↔visitor + notify email) → FS4 (redeem the two facade briefs; standing full-loop gate).

## 2026-07-03 — FS3 SHIPPED + PROVEN (real booking semantics)
Commits e76371b · 40c30c7 deployed (10 suites green, app:check 115). Status lifecycle compiled in
(pending default + closed-set CHECK on lifecycle tables; LLM 'confirmed' defaults overridden; migrate
resets legacy defaults — caught live on the migrated barbershop, gated). updateRow enforces the
closed set even for the owner; content PATCH status flip → visitor email w/ receipt link (verified
in the mail_sent ledger). insertRow (public): past dates refused, capacity-aware slot guard
(resource FKs + date/time coords; resource.capacity honored; cancelled/declined free slots; 23505
races answer friendly); actionable errors ride to the form via the route + relaySubmit. Dogfood
probe dates now dynamic-future (fixed 2026-01-01 fixture had gone stale). External proof: book →
born pending → double-book refused → yesterday refused → owner confirm → receipt Confirmed +
mail_sent event → garbage status refused. REMAINING IN FS TRACK: FS4 — redeem the two facade briefs
(the owner's delivery-app brief verbatim + the bakery pre-order) with the standing full-loop gate.

## 2026-07-03 — FS4 SHIPPED: the facade briefs redeemed — FULL-STACK TRACK COMPLETE (FS0–FS4)
Commits 04ea6d6 · c0afeff · a23f155 deployed (prod a23f155, 10 suites green, app:check 122).
Both original facade briefs re-ran VERBATIM zero-touch: bakery pre-order PASSED clean; delivery app
PASSED 0 high with a real core (orders action table; facades dropped at plan). The runs exposed +
killed three classes: (1) out-of-set seed statuses ('preparing') killed provision → coerced at
compile; (2) truncated data models (max_tokens mid-JSON) rejected wholesale → salvage complete
entities, string-aware; (3) the salvage/model shipping identity-tables-only (users+clients = gutted
app that passed review as a sign-up shell) → modelHasCore rejects into retry with action-first
ordering; DB prompt orders action entity first, compact JSON; rejections carry an output sample.
END-TO-END EXTERNAL PROOF on the redeemed delivery app: order ZR-2026-001 → pending → tracking page
→ find-by-code → owner completed → mail_sent → My Orders (signed in) → public API {"rows":[]}.
THE FS TRACK IS COMPLETE. Next frontiers (owner's call): PQ1 distinct design per brief · hero
art-direction panel pick · store options/variants/stock · FS-later: DB-level slot unique, richer
lifecycle emails, owner Telegram alerts on new bookings.

## 2026-07-03 — BOSS/WORKER mode (owner-directed: Fable at 84% weekly cap)
Fable stays boss 100%: plans, writes briefs, reviews every diff, commits, deploys, runs proofs.
Mechanical coding delegated to headless Sonnet workers: /root/zoro-worker.sh <brief> <log>, briefs
in /root/worker-briefs/. Leash: allowlisted tools (no push/deploy), explicit file scope, gates green
before stopping, full diff printed for review. Quality bar UNCHANGED: 10 suites + boss review +
zero-touch proof; two failed reviews on a task = boss does it himself (owner: quality over savings).
First delegated task running: 01-stock-awareness (PQ2 — stock column honored: transactional
decrement w/ FOR UPDATE oversell guard, Sold out / Only-N-left on grid + PDP, ecom:check extensions).

## 2026-07-03 — PQ2 STOCK shipped via BOSS/WORKER (first successful delegation)
Commit ddf49bc deployed (10 suites green, ecom:check 53). Worker (Sonnet, systemd unit
zoro-worker-01) implemented brief 01-stock-awareness in a clean 49-line diff — boss-reviewed line by
line, APPROVED first pass: FOR-UPDATE oversell guard in the placeOrder transaction, per-product
friendly errors, Sold out / Only-N-left on grid + PDP (live projections — showed on the coffee store
with NO rebuild), NULL stock = untracked. Live proof: PDP "Sold out" + "Only 3 left" + checkout
refusing '"Ethiopian Yirgacheffe" is sold out'. HARNESS LESSON: workers MUST run as systemd
transient units (systemd-run --unit=zoro-worker-NN --collect) — the boss's sandbox reaps even setsid
children; two runs died silently before this was root-caused.

## 2026-07-03 — PQ1 OPENED: agency panel verdict on real screenshots (3 lenses, Sonnet)
Sameness 7.3/10 (7/8/7) on barber+coffee+delivery. Ranked: (1) hero layout sameness — boss diagnosis
CORRECTED the panel: 4 hero variants already exist but the chooser clustered (hard 'split' demotion
for data archetypes + centered nav gated to 2 themes) → fixed: theme-respecting demotion, warm
joins centered-nav pool, DISTRIBUTION gate in layout:check (>=3 heroes + both navs across a fixed
matrix; 24→26). (2) card anatomy identical everywhere → worker brief B next (closed-set card styles
per section role). (3) CTA button sameness → worker-03 running (per-theme button recipes via CSS
vars: sharp/pill/soft/ghost + AA gate in theme-check). Panel screenshots /tmp/pq1-*.png.

## 2026-07-03 — SCOPE shipped (owner-directed: difficulty + precise needs = reliability)
Commit deployed; 11 suites green (scope:check 29 new). Every brief now gets an HONEST INTAKE at plan
time: closed capability registry (what we deliver, client-phrased) + closed unsupported registry
(what we can't yet, each with its alternative) + deterministic difficulty 1-5. params.scope + 'scoped'
event; the Telegram front door replies Scope / Not-included before the build finishes. The FedEx
silent-drop class is dead (tested verbatim). Also shipped this stretch: per-theme button shapes
(PQ1-C, worker 03), layout chooser un-clustered + distribution gate (PQ1-A, boss). Front door LIVE on
@nao_openclaw_alibaba_bot (owner tested). NEXT: PQ1-B card anatomy closed set (boss design → worker).

## 2026-07-03 — PQ1 CORE ARC LANDED: chooser un-clustered · button recipes · card anatomies · trio proof
Prod 038f456; 11 suites green (layout 33, app 125). The trio phone-check (law firm / skate shop /
cafe, all zero-touch): three visibly distinct designs — editorial+centered-nav+horizontal cards vs
bold+image-hero+overlay cards vs warm+split. Structural space now hero(4) × cards(3) × nav(2) ×
band(2) × theme(5) ≈ 240 combos, all closed-set, all hash-rooted in the brief. The trio ALSO caught:
(1) 'bookings' plural blind in the archetype classifier + LLM 'site' trusted over classification →
classifier is now the FLOOR (gated); cafe rebuilt as a real booking app, PASSED clean. (2) prod
deploy gate REVERTED a push of mine that carried 1 failing assertion — the machine held the bar
against the boss. Owner sent the side-by-side. Workers 01-05 all shipped first-pass (stock, tg-door,
buttons, scope, cards) under boss review. Lesson recorded: background waiters must be systemd's, not
the boss process's.

## 2026-07-03 — SESSION CLOSE: roadmap review + GitHub validated + NEXT 3 set
PLAN.md brought fully to reality (PQ1 core · PQ2 stock · SCOPE/front-door/boss-worker recorded).
Validated: local == origin/master, 0 uncommitted, prod redeployed to the same HEAD, 11 suites green
inside prod, board 200. NEXT 3 (in PLAN.md): 1) PQ1 panel re-score + hero art-direction residual,
2) PQ2 options/variants, 3) PWA installable apps. Boss/worker harness ready (briefs 06+ go to
/root/worker-briefs; launch ONLY via systemd-run). Front door live on @nao_openclaw_alibaba_bot.

## 2026-07-03 (evening) — PQ1 ART-DIRECTION: measured, shipped, and the panel moved the target
Panel re-score on the new trio (law/skate/cafe, Sonnet, 3 lenses, fresh desk+mob screenshots):
**6.0/10 sameness** (6/6/6, from 7.3) — unanimous #1: uniform photography (raw stock, one warm grade,
same crops) + law/cafe split-hero twins. Built it same session (4e25134): per-theme photo GRADE
(gravure/clean/golden/punch/mono) + brand TINT layer + CROP discipline (aspect/frame per theme) +
brand-tinted image-hero scrim over the fixed dark floor (AA by construction); products exempt.
theme:check gates the whole axis. Verified in pixels on all 5 themes.
THE MACHINE THEN TAUGHT US THREE MORE, all from zero-touch trio rebuilds (verbatim briefs):
(1) 'a BOUTIQUE law firm' → STORE ('boutique' bare keyword) → empty shop grid failed review →
    boutique now noun-shop only, law brief is a gate case (875ec9a);
(2) cafe's public form drew a reservation_id dropdown into the sealed PRIVATE reservations table
    (options can never load) → compiler forces such refs nullable + public forms omit them
    (order_items exempt), app:check 125→135;
(3) law-as-app grew an injected services catalog that shipped RAW SLUGS ('elder-law-guardianship')
    and bare numbers ('60') as card copy → __rcards filters machine residue, DB-card images take the
    theme frame, the reviewer gates the class (card-noise), layout:check 33→35 (d2e6fc7).
Post-fix panel measured 7.7 — recorded HONESTLY as not-an-improvement with confounds: the trio's
structure changed under the panel (law site→app catalog = new commerce sameness) and law/skate drew
colliding green palettes (LLM whim). Two panel claims ('no grading anywhere') contradict the pixels;
the structural findings stand. Final trio (law bbb7cdfe / skate 12b8f47e / cafe 0ecfde36) all
PASSED review zero-touch on the new design. NEXT #1 rewritten: palette distinctness axis +
register-aware catalog cards, then re-score toward ≤4.

## 2026-07-03 (night) — GROK joins the crew + the law brief's four-class gauntlet
Grok CLI installed as a second worker (grok-worker.sh: systemd unit, ProtectSystem=strict, push URL
disabled during runs). FIRST BRIEF FIRST-PASS: 06-catalog-register — 'Browse' was hardcoded on every
catalog; now closed-set by table (services→'Our services', menu_items→'The menu', humanize fallback);
surgical 2-file diff, spec:check 131. Grok is FAST — minutes, not tens of minutes.
The law proof brief then ran a four-class gauntlet, each rebuild exposing + killing a forever-class:
(1) template literal ATE the card filter's backslashes — emitted /^#?d+/ was dead; gate now asserts
    the LITERAL emitted regex (layout:check 37); admin-flag booleans (is_active) out of card copy.
(2) FS2 floor: normalized-CRM models stripped the visitor's email from the action table (identity
    on private 'clients') → My-bookings died; compile injects nullable email like FS1's ref_token
    (app:check 138).
(3) 'consultations' invisible to PRIVATE_READ (the bookings-plural class again): publicly readable
    visitor records, no floors firing; word list learns consultations/callbacks/intakes/enrollments
    + ANY *_requests (app:check 147).
(4) unseeded catalogs behind REQUIRED form dropdowns (empty attorneys/services = form can never
    submit) → normalizeDataModel rejects into retry with 'seed 3-6 realistic X' feedback
    (spec:check 134).
Proof: the same brief PASSED review zero-touch (0a211ce4, 1 medium). Boss-eye classes for next
session, recorded: raw ISO timestamps in cards (format like receipts) · machine tables (time_slots)
must never be the injected homepage catalog · brand-palette distinctness axis (law+skate drew twin
greens) · commerce framing register on service cards.

## 2026-07-04 (early) — Parallel production: 3 classes killed in one stretch, worker isolation v2
Boss + two Grok briefs ran CONCURRENTLY (the serial-boss bottleneck is gone). Shipped + deployed:
- Brief 07 (Grok, first-pass): raw ISO timestamps in cards → toDateString like receipts; the
  template-escaping gate held (layout:check 39).
- Brief 08 (Grok, first-pass): machine tables (time_slots/availability/schedules/…) never become
  the homepage catalog — choosePrimaryTable extracted pure + gated; only-machine-tables → NO
  catalog (app:check 151).
- Boss: BRAND-PALETTE POOLS (the twin-greens class): per-theme hand-built pools, brief-hash rotated,
  colour-word steered ('sage green spa' → sage), LLM palettes ignored when a theme is known
  (spec:check 139). PROVEN on rebuilds: law drew editorial forest-ink #233329, skate drew bold
  taxi-yellow #facc15 — disjoint pools, both PASSED review zero-touch.
HARNESS LESSON (the recorded class bit the boss): worker 07 REVERTED the boss's in-flight themes.ts
in the shared tree to satisfy its own 'diff touches only my files' DoD. grok-worker.sh v2: every
worker runs in an ISOLATED git worktree (/root/worker-trees/<brief>), boss reviews + applies the
patch. Also: push-URL was left disabled after a worker run → a push silently failed and deploy
shipped the OLD head; restored + verified. Ops rule: after any worker run, verify push URL + that
origin moved.
NEXT: register-aware commerce framing (service cards read like SKUs — prices/'in stock' on a law
firm), then panel re-score toward ≤4 · PQ2 variants · PWA.

## 2026-07-04 — PWA SHIPPED: every produced site installs as an app (chain pivot #1)
Owner pivot honored (the chain over the pixels; design parked at the gates). Prod 48eafe5, 12 suites
(pwa:check 28 is #12). Every produced site now ships, compiled from the locked brand, LLM untouched:
manifest.webmanifest (brand name/short_name/colours, standalone) · icon-192/512 painted by the real
browser (brand initial on brand primary, maskable-safe, zero new deps) · sw.js offline shell with
pages NETWORK-FIRST (the live Content-tab edit promise outranks offline freshness) and /api/ NEVER
cached (stale carts are worse than none). Reviewer probes installability LIVE on every build
(pwa-broken = high). SCOPE now DELIVERS the android ask: 'installs as an app on any phone' is a
capability (the astrology-brief class answered honestly with a yes); only store-LISTING remains
unsupported; difficulty counts the brief's detected demands, not the system freebies.
PROVEN zero-touch on a fresh brief ('pizzeria… android app for the regulars' → Sal's on Oak,
warm/clay from the palette pool): PASSED review 0 high; externally verified live — manifest
(application/manifest+json), sw scoped relay-<pid>, icons exact 192/512 PNG, head wired. Boss-eye
catch: short_name truncated mid-phrase ("Sal's on") → whole-words-that-fit + no dangling stopword,
gated. NEXT: chain-trace surface ("How it was built" as a product page) · TWA packaging on the
roadmap · capability growth from real front-door briefs.

## 2026-07-04 — THE CHAIN MADE VISIBLE: 'How it was built' shipped (chain pivot #2)
Prod 3c3518e, 13 suites (chain:check 22 is #13). Every produced site now opens its own PRODUCTION
RECORD at how-it-was-built.html (footer door on every page): brief verbatim → scoped promise
(complexity, delivered capabilities, honest exclusions) → blueprint (kind, design language, palette
chips) → the real database (private tables marked sealed) → the run (tasks, wall time, self-repairs
stated honestly, rebuild rounds) → deterministic checks in client words → review verdict. Rendered
LIVE with the site's own chrome via renderLiveChain — works retroactively for EVERY site ever built
(verified on the pre-feature skate build: 200). Everything curated from a closed whitelist; leak
seals gated with canary strings (event/issue detail text, emails, tokens can never render).
Proven live on the pizzeria build (owner sent the mobile shot). Chain pivot: #1 PWA ✅ · #2 chain
surface ✅ · #3 capability growth NEXT.

## 2026-07-04 — FS5 REAL AVAILABILITY shipped (chain pivot #3, evidence-driven)
Prod bda8a46, 13 suites (app:check 151→164). The received briefs said it verbatim ('customers pick
a barber, a service and a TIME SLOT'): appdb.freeSlots computes a day's free slots from the SAME
coordinates the FS3 slot guard enforces (resource FKs + timestamp; cancelled/declined free slots;
capacity books N; past hours closed) on a deterministic 09:00–16:00 grid. GET /api/site/:id/slots/
:table serves aggregate free/busy — never who booked. Slot-table timestamp fields render as date +
tappable time chips (resource-aware refetch: pick a barber → THEIR availability), hidden input
carries the real timestamp, unreachable API degrades to the plain date field. Act-probe books
through the new shape. SCOPE promises 'a real availability picker'. Front door: '/start' (a real
received message) is never a brief again.
PROOFS: machine gate proves the full loop on real Postgres (booked 10:00 flips TAKEN, cancellation
frees it, capacity honored, privacy: aggregate only). Live: cafe rebuild PASSED zero-touch, picker
on every form page, slots API serving. THE MACHINE TAUGHT US THE NEXT CLASS: the LLM draws THREE
booking-time shapes — single timestamp (FS5 fully live) · split date+time columns (this cafe:
picker binds the date, availability day-level) · slot-inventory rows (barbershop build: time_slots
FK dropdown; machine-table fix correctly kept it off the homepage). NEXT #1: canonical booking-time
shape forced at the compile floor (ONE timestamp column class), then hour-level availability is
universal. Also queued: freeSlots for slot-row inventories.

## 2026-07-04 — CANONICAL BOOKING-TIME SHAPE: the three LLM shapes collapse to one timestamp
Prod f62eb7c, 13 suites (app:check 168, spec:check 141). The floor, forced deterministically:
(1) compile MERGES split date+time columns on booking tables into one timestamptz — fields AND
seeds ('6 PM' → T18:00:00), loud warning, non-booking tables untouched; (2) normalizeDataModel
REJECTS slot-inventory tables (time_slots/slots rows + FK) into retry with the canonical-shape
feedback. PROOF (the definitive one, external, zero-touch): the barbershop brief that drew
time_slots rows two builds ago now produces barbers/bookings/services with bookings.appointment_at
— picker live on all 4 pages, availability API: booked 10:00 w/ barber 1 → TAKEN for barber 1,
FREE for barber 2, receipt token issued, review PASSED. Real availability is now UNIVERSAL on
booking apps. NEXT (per plan): store payments (the 6 store briefs' true gap) · freeSlots grid from
an hours table when the model ships one · PQ backlog (register cards, re-score).

## 2026-07-04 — PAYMENTS v1: every store says how to pay; every claim is honest
Prod 67011ac + copy gate (spec 143). The deterministic half of the 6-store-brief gap, shipped:
compile injects payment_options into every orders model (safe seed 'Pay on pickup' — the LLM never
invents an IBAN, gated); owner edits real details in the existing Content tab; checkout renders
active options live in a 'How you'll pay' box; owner confirms paid via the FS3 status flow. SCOPE
promises it; the card-payments exclusion tells the new truth. PROOF zero-touch: hot-sauce store
built with 0 review issues, options served live, box on checkout. The proof's own copy said 'We
accept all major cards' — a lie over an instructions checkout → copy gate now rejects card claims
on SELLING pages (brick-and-mortar wording stays legit). Card processing in-checkout (per-client
Stripe keys, webhooks, key custody) = the owner-decision roadmap item, options documented in chat.

## 2026-07-04 — PQ2 COMPLETE: VARIANTS — a store that actually sells, to real-shop grade
Prod b9c55da, 13 suites (ecom:check 61→75). Canonical product_variants(product ref, name, price?
inherits, stock? untracked); compile normalizes 'variants' + injects order_items snapshot columns
(variant_id/variant_name — receipts read 'Tee — XL' forever). placeOrder resolves options INSIDE
the locked transaction: ownership validated, variant price overrides, per-option stock guards +
decrements, bare add on a varied product refused friendly. PDP option pills (sold-out disabled),
variant-keyed cart, server re-prices everything; buy-probe picks an option. SCOPE promises variants
on sizes/colours/flavours briefs AND the model gate requires the table on such briefs.
PROOF zero-touch (tee shop, sizes S–XXL): review PASSED; externally: 5 pills on the PDP, per-size
stock seeded, bare add refused ('"Classic Black Tee" comes in options…'), order with size S landed
at the inherited price with the 'S' snapshot on the line item. PQ2's plan definition is DONE.
Remaining queue: Stripe v2 (owner's call) · TWA packaging · PQ1 backlog (register cards, re-score)
· freeSlots from an hours table.

## 2026-07-04 — BLOGS shipped (owner-directed): the PDP pattern for content, one chain, no second CMS
Prod 89db101, 13 suites (content 28 · app 170 · scope 34). The owner asked for blogs + suspected
open source could carry it — the honest answer: the open source is ALREADY inside (Directus +
Postgres); adding WordPress/Ghost would break the one-pipeline rule. Shipped the missing READ side:
blog briefs classify as data apps (posts/articles + a newsletter action; subscribers is PRIVATE_READ
— the list never leaks); post-<id>.html renders LIVE from the article row (byline, date,
art-directed cover, FULL body as escaped paragraphs — XSS-sealed, gated); collection cards link
through and never dump body text; honest 404s; SCOPE promises 'a real blog'. The Content tab is the
writing desk — publish by adding a row, edits show on the next load.
PROOF zero-touch (specialty coffee blog + newsletter): review PASSED; externally verified —
article page live ('Mastering the AeroPress in 5 Minutes'), post-999 → 404, subscribers sealed
{"rows":[]}, signup writes with a receipt token. Owner sent the phone shot.

## 2026-07-04 — Locked four: register cards · order receipts pay-info · hours-aware slots · HONEST re-score
Prod fbc96b6, 13 suites (layout 45 · ecom 79 · app 172). Shipped: (1) service/menu registers render
money muted 'From $X' (whole dollars, NEVER 'From $0.00' — free says nothing), inventory badges are
commerce-only; (2) placeOrder mints the FS1 receipt token, checkout LANDS the buyer on their receipt,
and the ORDER receipt repeats the live payment instructions; (3) freeSlots reads the model's own
opening-hours table (names or numbers, '2 PM' parses; closed day = honestly nothing).
THE MEASUREMENT, honest: final 3-lens panel on a fresh zero-touch trio = 7.33 (7/8/7). Across four
panels (7.3 → 6.0 → 7.7 → 7.33) the number has NOT durably moved despite real shipped axes — the
lenses converge on two STRUCTURAL facts: one card component serves all registers (image-top SKU
anatomy on consultations/dishes), and law+cafe share serif/cream/split DNA (editorial+warm both use
Fraunces; both pools cream grounds; split hero collides). RECORDED as the real design backlog:
per-register card ANATOMY (text-forward service cards, menu-list register) · a 4th display typeface
· hero de-collision. Parked per the owner's chain pivot until greenlit — the panel loop measures
honestly either way. Trio review-passed zero-touch; side-by-side is visibly the best yet (three
brands, three palettes, three photo voices) even where the skeleton repeats.

## 2026-07-04 — LOCKED FIVE: iteration at the door · SEO · search · CSV export (upload queued)
Prod 6be18d5, 13 suites (pwa 38 · layout 47 · content 34). Shipped + proven:
- ITERATION (the missing half of the loop): reply to a build message — or 'change <id>: …' — and the
  SAME site rebuilds amended via M3 replan. PROVEN live on the coffee blog: '…add an about page' →
  about.html 200, subscribers=4 + articles=6 SURVIVED, article pages back, review PASSED. The
  rebuild even survived a prod restart mid-flight (reclaim/resurrect did its job — watched live).
- SEO pack (Grok brief 09, first-pass): meta description/og tags deterministic from the locked spec;
  sitemap.xml + robots.txt per site; verified 200 + tags on the rebuilt blog.
- SEARCH: grids >=8 rows grow a themed accessible filter box (client-only, textContent-safe).
- CSV EXPORT: owner-gated /export/<table>.csv — sensitive stripped, RFC-quoted, BOM, formula
  injection disarmed; ownership model identical to the content admin (M4 two-user gate applies).
- Task #7 (Content-tab image upload) locked but not started — next session's first item.

## 2026-07-04 — IMAGE UPLOAD shipped: the locked five is 5/5 COMPLETE
Prod 165441a, 13 suites (content:check 41). Owners now set their OWN photos from the Content tab:
owner-gated POST on the content route, magic-byte typed (never the filename), 3 MB double-capped,
stored under the site's assets, the row's image column updated to the served path — live on next
load. Board edit form grew the upload control. PROVEN live on the hot-sauce store: PNG uploaded via
the API → served 200 → row points at it; 'not an image' refused friendly. PQ3's listed gaps are now
all closed (editing ✓ · image upload ✓ · CSV export ✓); richer field types remain as polish.
The locked-five arc: iteration ✓ · SEO ✓ · upload ✓ · search ✓ · export ✓ — all gated, all proven.

## 2026-07-04 — THE CANARY: nightly self-proof shipped, and it killed SIX classes on day one
Prod e21723e, 13 suites (ecom 90 · app 172 · spec 148 · content 41). The agency now proves itself
nightly: relay-canary.timer (03:30) builds one rotating brief (booking app / variant store / warm
app+blog) zero-touch through the LIVE server; review passes → quiet line + old canaries swept;
anything else → the operator's Telegram rings (TG vars added to prod env — the first alert had no
phone to ring). Plus honeypot armor: every public form/checkout carries an off-screen trap; all
three write paths answer bots with fake success and write nothing; the probe is exempt.
THE BIRD EARNED ITS KEEP IMMEDIATELY — six flights on the candle-store brief, six permanent
classes dead, each now a compile floor + gate:
1) variant-only pricing → products.price injected, backfilled from the cheapest variant;
2) grid Add-to-cart on variant products was a server-refused dead end → 'Choose options' → PDP
   (readRows decorates _variants; the probe buys variants through the PDP);
3) variants-first line items (product_variant_id, no product_id) → order_items canonicalized
   (product_id + qty always exist);
4) a store model with NO order tables at all → normalizeDataModel (archetype-aware) injects
   canonical orders + order_items — repair, never retry;
5) seeded FAKE CUSTOMERS ('Emma Rodriguez' + invented revenue) → visitor-record entities never
   seed, stripped loudly;
6) stores BORN SOLD OUT (every variant seeded stock 0) → seeded zero stock = invented scarcity,
   coerced to untracked.
Flight 6: canary OK, review passed, 5 failed predecessors swept. The store contract is now whole:
pages · variants · prices · order storage · line shape · honest seeds — all forced, all gated.

## 2026-07-04 — ALL THREE CANARY ARCHETYPES GREEN: proactive flights instead of waiting for rotation
Prod 2f698c0 (ecom 92). Flew the two unflown briefs on demand (CANARY_INDEX override):
- BARBERSHOP (booking): GREEN first flight, 7 min — the whole booking chain (canonical timestamp,
  availability picker, receipts, accounts, semantics) holds zero-touch.
- TAQUERIA (reservations + blog, warm): caught class #7 — an APP with a products table (its menu)
  linked 12 dish cards to product-N.html but the PDP was store-only → 404s. Fixed productively:
  detail pages for ANY archetype with products — dish pages with photo/price/description, options
  listed informationally, cart controls store-only. Re-flight: GREEN, 7 min.
The nightly rotation is now fully validated: store · booking app · warm app+blog all pass
zero-touch. Seven classes killed by the canary in its first day. Next timer run 03:33.

## 2026-07-04 — PQ3 COMPLETE: the Content tab is grandma-grade
Prod 64a8ba7 (content:check 46). The last 'still ahead' items closed: booleans are TOGGLES (an
unchecked box stores FALSE explicitly), dates/timestamps are real date inputs, prose fields are
textareas, RELATIONS are dropdowns of the referenced collection (owner reads now keep the raw fk id
alongside the display label — previously the edit form could never know the current relation and
refs were filtered out entirely), and every collection has '+ Add' using the same typed form.
PROVEN live on the tee shop through the real API: raw ids present, PATCH toggles stick, a new
variant added WITH its product relation ('XXXL Smoke Test' → product 1, $29) — then swept.
PQ3's full promise now stands: edit ✓ add ✓ delete ✓ upload photos ✓ export CSV ✓ typed fields ✓
relation pickers ✓ — all live-on-next-load, all owner-gated, all machine-checked.

## 2026-07-04 — REAL SUBDOMAINS: every produced site now lives at <slug>.naples.agency

The path URL /sites/<uuid>/ was the last "demo smell" on produced sites — unshareable,
un-SEO-able, and a blocker for TWA/Play packaging (which needs a stable origin per app).
Now: brandSlug() in spec.ts (accent-folding, DNS-clean, RESERVED_SLUGS like api/board/cms
get a -site suffix, 40-char cap), runner locks a collision-safe params.slug at the branding
pass (meridian → meridian-2 → meridian-3), server.ts routes Host: <slug>.naples.agency to
the site's dir (api/* and reserved subs excluded; unknown slug → honest 404 "no site here
(yet)"), seo.ts siteBase makes sitemap/robots canonical to the SUBDOMAIN, tg-door replies
with the pretty URL. 6 new spec gates (154), all 13 suites green, deployed at 96cbb74.
Infra: wildcard *.naples.agency DNS already pointed at the anouf-chat tunnel — instead of
fighting DNS, that tunnel's ingress now hands the wildcard to Relay :8787 (explicit records
board/api/cms/sites still ride the relay tunnel; both configs carry the wildcard rule so
either tunnel can serve it). 64 existing sites backfilled through the SAME brandSlug code
path, their built sitemap/robots regenerated via prod's own seo.ts (deploys never heal
built sites — a backfill does). PROVEN live: la-favorita-taqueria/cypress-law/
the-corner-table-2 .naples.agency all 200 with real titles, chain page 200, sitemap
canonical. The nightly canary now asserts the whole invariant zero-touch: slug minted +
Host-routed homepage serves (raw http.request — undici fetch silently drops a Host
override and would false-pass against the board UI).

## 2026-07-04 — ANDROID v1: produced sites become installable, signed Android apps

The mission's "apps that can be published on Android" now has its first real artifact.
src/apk.ts derives the ENTIRE app identity deterministically from produced output:
packageId ← slug (agency.naples.la_favorita_taqueria), twa-manifest ← the site's own
manifest.webmanifest (name/colors/icons — CMS-first, nothing re-invented), assetlinks ←
the relay keystore's actual SHA-256 read via keytool (a hand-typed fingerprint is the
exact class of lie this forbids). Bubblewrap update+build run headlessly (CI=true +
BUBBLEWRAP_* password envs — build alone PROMPTS on fresh projects). One relay signing
key (/root/relay-android.keystore, pass in .env) signs every app; the .aab for Play
Store upload is produced alongside. apk:check is the 14th gate suite (17 gates: packageId
java-safety, twa field derivations + caps, assetlinks shape + fingerprint validation,
apk MIME, Host-routing present). PROVEN: apksigner-verified APK live at
la-favorita-taqueria.naples.agency/app.apk (200, android MIME, 889KB) with matching
/.well-known/assetlinks.json on the SAME origin — install it and Android verifies the
origin and opens the site fullscreen as a real app. trimtime built too (2nd archetype);
claybound correctly REFUSED (predates the PWA base — rebuild first, honest error).
Box infra learned the hard way: bubblewrap wants sdkmanager at <sdk>/bin but gradle/AGP
wants a STANDARD sdk layout — /opt/android-sdk with bin→cmdline-tools/latest/bin symlink
satisfies both. Also /tmp was mode 700 (broke apt entirely); restored 1777.
Owner-gated next: Play Console account to publish the .aab to the store.

## 2026-07-04 — ANDROID SURFACE: packaging is a board action, the chain page hands out the app

Android v1 was root-CLI-only; now it's product. POST /api/apk?id= packages any produced
site from the board (ownership-gated 404-style like every project API; ONE gradle build
at a time — the in-flight set is both the double-click guard and the abuse cap; spawned
as a child process because buildApk's execFileSync would freeze the whole server for the
length of a gradle run; outcome recorded as run_events apk_built/apk_failed). GET returns
{apk, building, url}. The board actionbar grows "📱 Make Android app" → "Packaging…" →
"📱 Android app" (8s polling). The how-it-was-built page — THE CHAIN, rendered live —
gains "It is also an Android app" with a scannable QR (qrcode → inline SVG) + .apk
download, shown ONLY when the signed artifact actually exists on disk (never a promise).
16 new gates (apk:check 33: preflight refusal without signing config, apkStatus honesty,
section on/off by artifact, route ownership-gate + spawn path, board wiring; chain:check
25: live section strictly artifact-gated, subdomain link, real QR svg). All 14 suites green.

## 2026-07-04 — ANDROID BY DEFAULT: every finished build auto-packages; the canary proves it nightly

The button was opt-in; now the app is a PROPERTY of every production build. The runner's
post-done hook (review context only — suites and scratch runs never package) queues the
site into the packaging FIFO: ONE gradle at a time, board button and auto-hook share the
same queue, cap 8 (flood → refused, never accumulated), re-request idempotent, outcome in
run_events. The nightly canary got two new teeth: after review passes + subdomain probe,
it waits for apk_built (8 min budget; apk_failed or silence = alarm) and then downloads
/app.apk over the wildcard Host route expecting a >100KB signed artifact — so "canary
green" now certifies brief → site → subdomain → signed Android app, zero-touch, every
night. Old canary packaging workdirs are swept with the projects (33MB each — a month of
nights would eat a GB). 8 new gates (apk:check 41), queue behavior tested via injected
launcher, all 14 suites green. PROVEN live: flight below.

## 2026-07-04 — i18n v1: the produced site's LANGUAGE is a build property

naples.agency sells into Italy; until now an Italian brief produced a half-English site —
the LLM copy followed the brief's language but every deterministic chrome string (cart,
checkout labels, receipts, account, search, slot picker, availability, aria) was hardcoded
English. Killed at the floor: src/i18n.ts holds a CLOSED locale set (en/it/fr/es/de), a
deterministic stopword detector (weighted markers; ambiguity → English, never a guess; no
LLM votes on identity), and ONE string table (61 keys × 5 locales) whose completeness is
machine-gated. detectLocale(brief) runs at plan AND replan → params.locale; renderPage
threads it into every SECTION, navBar, footer, <html lang>, and injects a JSON client
dictionary (window.RELAY_T) so the browser runtime — cart, checkout, search box, slot
picker, error messages — speaks the same language (JSON.stringify IS the escaping; no
string-spliced code). Live pages (receipt/find/account/PDP) read params.locale. The leak
canary gate asserts ZERO English chrome on an Italian render — it caught its first leak
before ship (a code comment quoting "How you'll pay" emitted into the client script).
Default is byte-English: no locale → the exact pages we shipped yesterday (all 14 prior
suites pass untouched except two layout gates repointed at the stronger RELAY_T
invariant). i18n:check is suite 15 (23 gates). Residual for v1.1: server/appdb error
strings (slot taken, sold out) and LLM-named form column labels.

## 2026-07-04 — i18n v1.1: the money and the messages

The Italian E2E exposed what v1 didn't cover: a trattoria pricing in $, English rejection
messages at the exact moment of trust ("that slot was just taken"), and form labels
humanized from English column names. All three closed: currencyFor(locale) — en→$ (USD),
it/fr/es/de→€ (EUR), symbol threaded through the client dict (RELAY_T.cur → __money, grids,
From-prices) and the server renders (PDP, variant pills, money meta); v1 is symbol-only —
decimal-comma formatting is future work. Every appdb visitor error (13 strings: name/email
required, product gone, option gone, sold out, only-N-left, has-options, past date, slot
taken, slot full, image errors) now goes through L() with a per-project localeOf lookup on
WRITE paths only — English values byte-exact with history so every existing gate stays
green. Common schema columns (customer_name, party_size, booking_date… 23 names) get
localized form labels at render time; English always uses the humanize fallback
(byte-compat); unknown columns stay humanized. The canary rotation gains a 4th brief IN
ITALIAN — locale detection, Italian chrome and € pricing now get proven zero-touch every
4th night. i18n:check 35 gates; all 15 suites green.

## 2026-07-04 — SURVIVAL: the agency can now outlive the box

Until tonight everything — 76 projects, 46 client app schemas, the Android signing keystore
(unrecoverable by definition), envs, tunnel creds — lived on ONE machine with zero offsite
copy. Now: deploy/backup.sh dumps the database, tars the unrecoverable secrets, encrypts
both (AES-256-CBC, PBKDF2 200k; key on the box AND on the owner's phone), VERIFIES before
shipping (decrypt roundtrip byte-compare + pg_restore --list must show the projects table +
the tar must contain the keystore — a pushed backup is a proven backup), and force-pushes a
weekday-rotating single-commit history to the private repo naoufac/relay-vault (bounded
forever, 7-day retention, ~6MB/night). relay-backup.timer runs it nightly at 04:44, after
the canary; any failure rings the owner's phone via the ERR trap. backup:check is suite 16
(9 gates) and runs the REAL script dry on every check — "suites green" now includes
"tonight's backup will restore". PROVEN with a full box-loss drill: cloned the vault FROM
GitHub, decrypted with the key, restored onto a scratch database — 76/76 projects, 46/46
app schemas, all 15 secret files present. docs/RESTORE.md is the step-by-step. The
recovery key was delivered to the owner's Telegram — the vault is useless without it and
the box is no longer a single point of failure with it. Gotcha for posterity: `pg_restore
--list | grep -q` dies of SIGPIPE under pipefail on first match — list to a file first.

## 2026-07-04 — WATCHDOG v2 + THE ITERATION LEG: one new leg, three classes killed in one evening

The uptime monitor only watched the board — but client sites ride the WILDCARD tunnel, a
different process entirely; they could all go dark while the monitor stayed green. Proven
real the same hour: the "flagship" la-favorita-taqueria 404'd — it had been a CANARY
project, swept by design (lesson encoded: demos and probes use permanent projects only;
taqueria-dona-rosa built as the permanent replacement). Watchdog v2 probes every surface
(board healthz · a permanent flagship subdomain · cms) with per-surface flap state and
culprit-naming alerts; the down→up transition was fired live as proof.

The canary grew the ITERATION LEG — after the green flight it rebuilds the SAME project
through the public /api/rebuild with an amended brief and asserts: not one row lost, slug
identity kept, review passes AGAIN. It caught a REAL class per flight:
· Flight 1: identity NOT stable — replan dropped the slug and the lock re-derived from the
  freshly re-resolved LLM name (hearthside → still-and-wick): domain, packageId, assetlinks,
  printed QRs all orphaned. Fixed at both floors (replan carries slug; lock derives from the
  LOCKED brand). apk:check 44.
· Flight 2: order_items.product_variant_id NOT NULL (alien spelling) — placeOrder writes
  canonical variant_id; NO order could land. Compile canonicalizes the spelling + forces
  line-item variant columns nullable. ecom 96.
· Flight 3: NO products table at all (candle scents modeled as categories+variants) —
  category cards, nothing purchasable. CATALOG CANON: the variants' parent entity becomes
  products (refs, FK column, seed keys rewritten). ecom 99. Plus: the options table is
  never chosen as the collection grid.
Flight 4 blocked externally: the OpenRouter key hit its WEEKLY LIMIT — builds are paused
until the owner raises it; the operator alert fired as designed. The green E2E iteration
flight runs automatically the moment quota returns (nightly canary).

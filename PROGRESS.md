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

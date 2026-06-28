# Relay — technology stack review (fresh eyes, 100 → 1000 users)

Not "optimise what's here" — question what should exist. Trigger: chromium breaks repeatedly.

## Current stack (grounded)
- **Runtime:** Node 22 + `tsx` (TypeScript run directly, no build step). Deps: `pg`, `nodemailer`, `ws`.
- **Web:** raw `node:http` (no framework) on `:8787`.
- **Scheduler:** ONE in-process `runLoop` per project, fire-and-forget *inside the web server*, `runnerId='runner-1'`. Postgres-as-queue (`FOR UPDATE SKIP LOCKED` + leases + unblock trigger).
- **DB:** one Postgres (docker `ap-pg`) on a **shared box**, one `pg.Pool(max:8)` in the server process.
- **Browser:** **chromium spawned per-call** in 3 paths — `site_renders` screenshots EVERY page build · QA vision screenshots · dogfood (hand-rolled CDP over `ws`).
- **Artifacts:** produced sites on **local disk** (`sites/`, 228 MB, gitignored, ephemeral).
- **LLM:** MiniMax (OpenAI-compatible). **Hosting:** shared box, cloudflared tunnel, systemd.

## The chromium decision (the trigger) — two hard calls

**1. Remove chromium from the verify hot path.** `site_renders` spawns chromium to screenshot every page and prove "it isn't blank." But pages are now **deterministically composed from vetted components** — structure, CSS, fonts, contrast are correct *by construction*, and we already statically assert structural HTML · no external assets · no dead buttons · valid inline JS, with `theme:check` parsing the CSS/JS. The screenshot is **redundant theatre**: it can only fail if our own vetted CSS blanks the page, which the deterministic renderer + `theme:check` already preclude. → **Drop the screenshot from `site_renders`; keep the static gates.** Chromium leaves every build. (Keep ONE best-effort thumbnail for the board, generated off the hot path, non-gating.) This is the biggest single fragility + throughput + cost win.

**2. The browser work that genuinely needs a browser (QA vision + dogfood interaction) → Playwright with ONE persistent browser.** The breakage isn't "chromium" per se — it's *spawn-per-call on a snap chromium with hand-rolled CDP*: startup races, navigation crashes, file-write sandboxing, the concurrency starvation I just band-aided by serialising. Playwright bundles its own Chromium (no snap), manages the browser lifecycle, auto-waits, isolates a context/page per review, and is the industry-standard robust tool — it deletes exactly these failure modes. Run **one long-lived browser**, a context per review, a small concurrency limit. (Hand-rolled CDP was a mistake — built to avoid a dependency; the dependency is the right answer.)
- *Higher-scale alternative:* a **managed browser/screenshot service** (browserless · Playwright-as-a-service · screenshotone/urlbox) — offloads the browser entirely. Right when local browser cost/ops outgrows one host; for 100–1000 users, self-hosted Playwright + 1 persistent browser on a sized box is enough and cheaper.

## 100 → 1000 users — the rest of the stack
- **Split the runner OUT of the web server into N stateless worker processes.** The architecture already supports it (Postgres queue + `SKIP LOCKED` + leases + the SPEC's `worker_slots` semaphore). Today "fire-and-forget `runLoop` in the API process" couples build load to the API and is the throughput ceiling (builds are minutes of LLM + render). → thin API + a worker pool claiming from Postgres; give each worker a unique `runnerId`. **Decision: do this when concurrent builds exceed ~a dozen.**
- **Postgres: keep it (right choice).** Add **pgbouncer** (a pool of 8 in one process won't survive N workers), move to **managed Postgres** (Supabase/Neon/RDS) off the shared box. Per-project `app_<id>` schemas are fine into low-thousands; watch catalog growth, revisit a dedicated "apps" DB if it bloats.
- **Artifacts → object storage (Cloudflare R2 / S3).** Required for stateless multi-worker + durability (a box loss today loses every produced site). Produced HTML is self-contained → trivial blobs.
- **Hosting → off the shared box** onto a dedicated host/container sized for builds + one browser (the chromium contention is a symptom of the shared, constrained box), behind the existing Cloudflare tunnel.
- **LLM → provider abstraction + a global concurrency/budget governor** (`worker_slots`); builds are LLM-bound, so LLM limits/cost/latency are the real 1000-user ceiling.
- **Keep as-is:** Postgres-as-queue (excellent), raw `http` server (lean), the deterministic renderer + schema compiler, the per-project isolated schema, `tsx` (fine at this scale; add `esbuild` only if cold-start matters).

## What shouldn't exist (kill, don't optimise)
1. Per-build chromium screenshot gate → **remove** (deterministic render made it redundant).
2. Hand-rolled CDP client → **replace with Playwright** + one persistent browser.
3. `runLoop` inside the web process → **split into workers**.
4. Local-disk artifacts → **object storage**.

## Recommended sequence
1. **Now (kills the pain, no rewrite):** remove the screenshot from `site_renders`; move QA + dogfood to Playwright + a single persistent browser. Eliminates the recurring breakage across every build and makes the reviewer robust.
2. **Next (scale to 1000):** artifacts → R2; runner → worker processes; managed Postgres + pgbouncer; dedicated host.
3. **Later:** managed browser service if local browser ops outgrow one box; LLM governor tuning.

---

## Status — applied vs. blocked (this review, "apply all")

**✅ APPLIED & DEPLOYED (commit `4cc1d3e`, `systemctl restart relay.service`, health=ok):**
1. **Screenshot removed from the verify hot path.** `site_renders` is now static (structural HTML · no external assets · no dead CTA · wired forms). Chromium left every build. Biggest fragility + throughput + cost win.
2. **One persistent Playwright browser** (`src/browser.ts`) behind dogfood + qa + theme:check. Killed spawn-per-call chromium + hand-rolled CDP-over-`ws` (dropped `ws`/`@types/ws`, added `playwright`). The "chromium didn't come up" / CDP startup-race class is gone. Verified: theme:check 5/5, demo PASS + clean exit, dogfood runs + accurately flags a broken site.
3. **Board thumbnail off the hot path** — `qa.ts` writes `preview.png` once per completion, non-gating.

**✅ CODE-READY, OPT-IN, DEFAULT UNCHANGED (committed, NOT flipped on prod):**
4. **Runner → worker split.** `src/worker.ts` (polls Postgres, unique `runnerId`, safe many-at-once via `SKIP LOCKED`+leases) + `deploy/systemd/relay-worker.service` + `npm run worker`. The web server's in-process build is gated behind `RELAY_BUILD!=='0'` so default behaviour is identical. **Flip when concurrent builds exceed ~a dozen:** set `Environment=RELAY_BUILD=0` on `relay.service`, `daemon-reload && restart relay`, then `systemctl enable --now relay-worker` (run N of them). *Honest note: not load-justified at single-operator scale — flipping it now would be optimising something that doesn't need to exist yet. Left as capacity-on-demand.*

**⛔ BLOCKED — needs YOUR decision / external accounts (cannot be applied unilaterally, and not load-justified yet):**
5. **Artifacts → object storage (R2/S3).** *Exact steps when you decide:* create a Cloudflare R2 bucket + API token; add `STORAGE=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` to `.env`; add `src/storage.ts` (a `put(key,bytes)/url(key)` seam — local-disk default, R2 adapter behind the env flag) and route the `sites/<id>/…` writes in `runner.ts`/`media.ts`/`cms.ts` through it. Required ONLY for stateless multi-worker on separate hosts + durability against box loss. *Deliberately NOT pre-built:* a local→local seam with no R2 behind it is churn — build it the day R2 (or a second host) lands.
6. **Managed Postgres + pgbouncer off the shared box.** *Steps:* provision Supabase/Neon/RDS; set `DATABASE_URL` to it (+ a pgbouncer/transaction-pool URL); migrate the board with `pg_dump`/`pg_restore` from `ap-pg`; raise `pg.Pool` ceilings only behind pgbouncer. Needed once N workers exhaust a single `Pool(max:8)`. Needs your cloud account.
7. **Dedicated build host.** Move builds + the one browser off the shared box (the chromium contention was partly the constrained shared box) onto a sized host behind the existing Cloudflare tunnel. Needs your host/provider choice. Do not touch the co-tenant services on the current box.

**Bottom line:** every code-level item in this review is applied or committed-and-opt-in. Items 5–7 are genuinely external (your R2 / Postgres / host accounts) AND not yet load-justified — documented to-the-step so they're a config change, not a project, the day load (or a durability requirement) earns them.

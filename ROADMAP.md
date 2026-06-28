# Relay — Roadmap & History

Where we've been, where we are, where we're going. See [`MISSION.md`](MISSION.md) for the principles and [`docs/SPEC.md`](docs/SPEC.md) for the architecture.

**Today:** one brief → an autonomous production line → a real, **multi-page** site with a **brief-rooted visual identity** (5 design languages), or — for an app/store brief — a **full-stack app running on its own live, isolated Postgres schema** (designed by a deterministic schema compiler, read back on the page), served at `/sites/:id/`. The model decides copy + section order + 2 brand colours + a typed **data model**; the system configures everything else — components, theme, and a flawless schema — so it's correct by construction. Every step passes a deterministic gate, and a **real browser then uses the site** (clicks every button, submits the form, checks the data) before it's called done. Live at **board.naples.agency**.

---

## History (what shipped, in order)

| Phase | What | Status | Marker |
|---|---|---|---|
| 0 · Engine | DAG board in Postgres, stateless restart-safe runner, unblock trigger, zero-trust verify | ✅ | first commits |
| 1 · Real product | Deliverable-first web app (Your sites → project workspace → live site iframe), `/sites/:id`, live board | ✅ | `a3ea137` |
| 2 · Honest quality | Quality gate (no external/broken assets, no placeholders), render check, **honest KPIs** (deadlock ≠ "running"), retry-with-feedback | ✅ | `5310d30` |
| 3 · Generic + multi-page | LLM planner (per-brief task DAG, not a template), **multi-page sites + shared nav** (one render-verified build per page), WCAG always-bound | ✅ | `v0.2-multipage` |
| 4 · Real media | **Pexels** photos searched per section, **downloaded + served locally** (gate-safe, never a broken external link) | ✅ | `media` |
| 5 · Deterministic render engine | The model emits a JSON **spec**; a deterministic renderer (`src/render.ts` + `src/components.ts`) builds the page from **vetted components** — nav, fonts, spacing and **WCAG contrast correct by construction**. Replaced the earlier vendored-Tailwind "excellence" experiment (`a4d36a6`), now **removed entirely**. | ✅ | `engine` |
| 6 · Editable CMS | Each rendered page is frozen as an editable snapshot in Postgres; an edit is a **pure string overlay** (no LLM → design can't drift); **republish** runs the IDENTICAL `site_renders` gate and atomically swaps the live file only on pass | ✅ | `cms` |
| 7 · Full-stack + database | A produced-site **form** → `POST /api/site/:id/submit` → Postgres `site_submissions` → readable in the **Data** tab | ✅ | `v1` |
| 8 · Visual QA | Each page screenshotted **mobile + desktop**, scored by a vision model (issues + score) → `qa_reviews`; auto-runs on completion | ✅ | `qa` |
| 9 · Rooted identity (themes) | The brief is classified into one of **5 design languages** (editorial/modern/warm/bold/minimal); the renderer expands it into font pairing + type scale + rhythm + shape — WCAG-safe by construction (`src/themes.ts`). Same copy → genuinely different studios. | ✅ | `theme` |
| 10 · Archetype + honest verify | A deterministic classifier (`src/archetype.ts`) routes the brief to **site / app / store** and the right departments; every department is bound to a **real** gate (no `min:280` theatre). | ✅ | `archetype` |
| 11 · Live per-project database | An app/store brief gets a **real, isolated Postgres schema** (`app_<hex>`, never `public`). The DB department designs a typed **data model**; a deterministic compiler (`src/schema.ts`) emits flawless DDL (serial PKs, FK constraints + indexes, `numeric` money, `timestamptz`); `app_db` provisions + verifies it; a `collection` section reads it back live. | ✅ | `appdb` |
| 12 · Interaction QA (dogfood) | A real headless browser **uses** every finished site: measures header alignment + overflow, checks every CTA goes somewhere, **types into + submits** the form (asserts it persisted), confirms collections show live rows → `dogfood_reviews`, shown per project. Auto-runs on completion. | ✅ | `dogfood` |
| 13 · Robust browser layer (stack review) | Killed spawn-per-call chromium + hand-rolled CDP-over-`ws` (the recurring "chromium didn't come up" breakage) → **ONE persistent Playwright browser** (`src/browser.ts`, Playwright's own Chromium, context-per-call, concurrency-gated) behind every browser path (dogfood/qa/theme:check). Removed the **redundant screenshot from the verify hot path** (`site_renders` is now static; pages are correct by construction) — bigger throughput/cost/fragility win. Runner split into an opt-in **worker process** (`src/worker.ts`, `RELAY_BUILD=0` flag) for horizontal build scale. | ✅ | `4cc1d3e` |

### Verification today (what "done" means — never the agent's word)
`site_renders` (**static**: valid structural HTML, no external/placeholder assets, **no dead CTA / unwired form** — no browser; pages are correct by construction) · `app_db` (the project's isolated schema actually provisions + has tables) · `wcag` (text/bg ≥ 4.5:1) · `json` (structured output parses) · `sql_applies` (DDL runs) · `min:N` (length floor, honest — not counted as rigor). Plus the post-completion **dogfood** interaction pass (real Playwright browser). Rigor is reported honestly.

---

## Where we're moving (forward roadmap)

### Next — User accounts
Each operator signs in and owns their own projects + produced sites. The system is built to be multi-user; today it runs single-operator while the engine matures.

### Scale-out 100 → 1000 users (see [`docs/STACK-REVIEW.md`](docs/STACK-REVIEW.md))
The fresh-eyes stack review. **Done:** robust browser layer + screenshot removed from the hot path (Phase 13); the worker-split is **code-ready and opt-in** (`src/worker.ts`, `RELAY_BUILD=0`) — flip it when concurrent builds exceed ~a dozen. **Blocked on an infra decision / your accounts** (not unilaterally applicable, and not load-justified yet): artifacts → object storage (R2/S3, `src/storage.ts` seam), managed Postgres + pgbouncer off the shared box, a dedicated build host. STACK-REVIEW carries the exact steps; we apply them when load (or a box-loss durability requirement) earns it, per "don't optimise what shouldn't exist yet."

### Deeper database (the technical-perfection track)
The schema compiler is live; next: **typed forms generated from the model** (a form that writes a real row, fields + validation derived from the entity), relation-aware collections (show a product's category name via its FK), an **auth** department (accounts on the project's own schema), and safe **migrations** when a rebuild changes the model (today a populated schema is preserved, not altered).

### Wider component library (in progress)
Shipped: **pricing · testimonials · FAQ · stats** (+ hero/features/split/gallery/cta/form/feed/collection). Next: team, menu, logos, and per-section variants — so more briefs map cleanly onto vetted parts; the puzzle grows, the renderer stays deterministic.

### Trustworthy review ✅
The interaction reviewer (`dogfood`) drives a real browser (Playwright): every link load-tested, every CTA labelled + targeted, the form typed + submitted + verified, layout measured — auto-run on completion, verdict shown on each project card. Now **accurate**: collections are judged against the data API (rows-in-DB-but-0-rendered = a real render bug, not "empty"), forms by DB persistence (truth), not message timing. A `theme:check` gate also parses every emitted inline `<script>` as JS, so a broken client script can never ship.

### Self-correcting loop ✅
The reviewer's verdict is now **load-bearing**. On a content-level high finding, `dogfood` re-opens the affected page build(s) with the findings injected as feedback (reusing retry-with-feedback), rebuilds, and re-reviews on completion — capped at one round, after which the verdict stands and the board flags it (so a *persistent* failure surfaces a system bug to a developer, not an infinite loop). Closes "autonomous + zero-trust + no human in the loop" for content defects. (`repairPlan` is a pure, unit-tested function; the full live exercise triggers on the next real content-level failure.)

### NEXT (architecture) — Validated build-spec contract
Robustness against malformed LLM specs is currently scattered as defensive patches in the renderer (CTA object→text, collection table fallback, …). Centralize it: one deterministic `validate/normalize` layer for the build spec (mirroring `planner.validate()`) that coerces/repairs/rejects at the boundary — making the `[object Object]`/wrong-table class structurally impossible, not patched.

### Stack router (when it earns its keep)
The archetype classifier is the first cut. An SSG (e.g. Eleventy) only where Markdown-owned layout (blog/docs) is genuinely better; the component renderer stays the default.

### Deferred (only when a brief truly needs it)
Astro · a real headless CMS (Directus/Payload/Strapi) · payments/store · app-shell.

---

## Principles (unchanged)
Autonomous (brief in → result out, no human in the loop) · zero-trust (a deterministic check decides "done") · real artifacts (a site you can open) · generic (any brief) · honest (the dashboard never lies).

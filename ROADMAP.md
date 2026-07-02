# Relay — Roadmap & History

Where we've been, where we are, where we're going. See [`MISSION.md`](MISSION.md) for the principles and [`docs/SPEC.md`](docs/SPEC.md) for the architecture.

**Today:** one brief → an autonomous production line → a real, **multi-page** site with a **brief-rooted visual identity** (5 design languages), or — for an app/store brief — a **full-stack app running on its own live, isolated Postgres schema** (designed by a deterministic schema compiler, read back on the page), served at `/sites/:id/`. The model decides copy + section order + 2 brand colours + a typed **data model**; the system configures everything else — components, theme, and a flawless schema — so it's correct by construction. Every step passes a deterministic gate, and a **real browser then uses the site** (clicks every button, submits the form, checks the data) before it's called done. Live at **board.naples.agency**.

---

## The one goal (current — see `GOAL.md`)
**A brief goes in; a real, verified, CMS-served website comes out — zero humans in between. ONE pipeline, ONE CMS: every site is built on Directus** (hardcoded, enforced by `npm run cms:check`), with content living in and served from the CMS. The earlier "5 CMS, one per project" goal and the parallel WordPress/WooCommerce build path are retired by owner decision (2026-07-02) — they produced two competing build systems and inconsistent output. This also replaces the old "Editable CMS" (an inline text editor, not a CMS). Status corrections to the history below are tracked in `docs/HONESTY-AUDIT.md` — a prior version over-marked items as shipped.

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
| 6 · Editable CMS — **RETIRED** | Was an inline **text editor**: a regex string-overlay on frozen rendered HTML, re-verified and atomically swapped. **Not a CMS.** Being replaced by CMS-native generation (see "The one goal" above). | ⛔ retired | `cms` |
| 7 · Full-stack + database | A produced-site **form** → `POST /api/site/:id/submit` → Postgres `site_submissions` → readable in the **Data** tab | ✅ | `v1` |
| 8 · Visual QA | Each page screenshotted **mobile + desktop**, scored by a vision model (issues + score) → `qa_reviews`; auto-runs on completion | ✅ | `qa` |
| 9 · Rooted identity (themes) | The brief is classified into one of **5 design languages** (editorial/modern/warm/bold/minimal); the renderer expands it into font pairing + type scale + rhythm + shape — WCAG-safe by construction (`src/themes.ts`). Same copy → genuinely different studios. | ✅ | `theme` |
| 10 · Archetype + honest verify | A deterministic classifier (`src/archetype.ts`) routes the brief to **site / app / store** and the right departments; every department is bound to a **real** gate (no `min:280` theatre). | ✅ | `archetype` |
| 11 · Live per-project database | An app/store brief gets a **real, isolated Postgres schema** (`app_<hex>`, never `public`). The DB department designs a typed **data model**; a deterministic compiler (`src/schema.ts`) emits flawless DDL (serial PKs, FK constraints + indexes, `numeric` money, `timestamptz`); `app_db` provisions + verifies it; a `collection` section reads it back live. | ✅ | `appdb` |
| 12 · Interaction QA (dogfood) | A real headless browser **uses** every finished site: measures header alignment + overflow, checks every CTA goes somewhere, **types into + submits** the form (asserts it persisted), confirms collections show live rows → `dogfood_reviews`, shown per project. Auto-runs on completion. | ✅ | `dogfood` |
| 13 · Robust browser layer (stack review) | Killed spawn-per-call chromium + hand-rolled CDP-over-`ws` (the recurring "chromium didn't come up" breakage) → **ONE persistent Playwright browser** (`src/browser.ts`, Playwright's own Chromium, context-per-call, concurrency-gated) behind every browser path (dogfood/qa/theme:check). Removed the **redundant screenshot from the verify hot path** (`site_renders` is now static; pages are correct by construction) — bigger throughput/cost/fragility win. Runner split into an opt-in **worker process** (`src/worker.ts`, `RELAY_BUILD=0` flag) for horizontal build scale. | ✅ | `4cc1d3e` |
| 14 · Web-grounded intelligence | Research/strategy departments call the model via OpenRouter with the server-side `web` plugin. **Proven:** 24 successful web-grounded runs persisted in `run_events` (`llm_call` events, `web:true ok:true`, 2026-06-28 → 2026-07-02). | ✅ | `web-grounding` |

### Verification today (what "done" means — never the agent's word)
`site_renders` (**static**: valid structural HTML, no external/placeholder assets, **no dead CTA / unwired form** — no browser; pages are correct by construction) · `app_db` (the project's isolated schema actually provisions + has tables) · `wcag` (text/bg ≥ 4.5:1) · `json` (structured output parses) · `sql_applies` (DDL runs) · `min:N` (length floor, honest — not counted as rigor). Plus the post-completion **dogfood** interaction pass (real Playwright browser). Rigor is reported honestly.

---

## Where we're moving (forward plan — owner priorities, 2026-07-02)

**The product ladder: high-converting landing page → multi-page site → full-stack app with database → user accounts. Every rung produced by the same pipeline, verified by the same deterministic gates, zero humans.**

### 1 · Conversion-grade landing pages (NOW)
Today's output is *correct*; the next bar is *converting*. One focused sales page per brief when
that's what the brief needs: proof-first section ordering (pain → promise → proof → offer → CTA),
sharper CRO copy patterns in the copywriter role, social-proof/urgency/offer components joining the
vetted library, and a `landing` shape in the planner (single page, no thin filler pages).
Done = a landing brief ships one coherent sales page that passes every existing gate.

### 2 · Full-stack depth (the database track)
The schema compiler + isolated per-project schemas are live (all app/store projects get one).
Next: **typed forms generated from the data model** (fields + validation derived from the entity),
relation-aware collections (a product shows its category via the FK), and **safe migrations** when
a rebuild changes the model (today a populated schema is preserved, not altered).

### 3 · User accounts
Operators sign in and own their projects + produced sites: auth (accounts on Relay's own schema),
per-user project scoping in the API + board, transactional email (re-add a mailer on the existing
naples.agency SMTP/DNS, which stays configured — the old unused module was deleted 2026-07-02).

### 4 · Architecture guard-rails (rolling)
Validated build-spec contract: one deterministic `validate/normalize` layer at the spec boundary
(mirroring `planner.validate()`), replacing scattered defensive patches in the renderer. Worker
split (`src/worker.ts`, `RELAY_BUILD=0`) stays code-ready, flipped on when concurrent builds earn it.

### Deferred (only when a brief truly needs it)
Payments/store checkout · SSG for Markdown-owned layouts · object storage for artifacts
(`docs/STACK-REVIEW.md` carries the exact scale-out steps; applied when load earns them).

---

## Principles (unchanged)
Autonomous (brief in → result out, no human in the loop) · zero-trust (a deterministic check decides "done") · real artifacts (a site you can open) · generic (any brief) · honest (the dashboard never lies).

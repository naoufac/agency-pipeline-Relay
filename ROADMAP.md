# Relay — Roadmap & History

Where we've been, where we are, where we're going. See [`MISSION.md`](MISSION.md) for the principles and [`docs/SPEC.md`](docs/SPEC.md) for the architecture.

**Today:** one brief → an autonomous production line → a real, **multi-page**, modern, render-verified website (or a **full-stack app with a database**) served at `/sites/:id/`. The model only decides copy + structure + 2 brand colours; **vetted components build the page**, so nav, fonts, spacing and contrast are correct by construction. Every step is checked by a deterministic gate (it never ships broken). Live at **board.naples.agency**.

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

### Verification today (what "done" means — never the agent's word)
`site_renders` (headless chromium screenshot must be non-blank, valid HTML, no external/placeholder assets) · `wcag` (declared text/bg pair ≥ 4.5:1) · `json` (structured IA/copy parses) · `min:N` (length floor). Rigor is reported honestly.

---

## Where we're moving (forward roadmap)

### Next — User accounts
Each operator signs in and owns their own projects + produced sites. The system is built to be multi-user; today it runs single-operator while the engine matures.

### Wider component library
More section types and layouts (pricing, testimonials, FAQ, team, menu, product grid…) so more briefs map cleanly onto vetted parts — the puzzle gets bigger, the renderer stays deterministic.

### Full-stack dynamic content
Beyond form capture: list/detail pages backed by the project's own database tables (read paths, not just writes) — so a "delivery app" or "directory" brief ships with live data, not just a presentation.

### Stack router (when it earns its keep)
Classify the brief to pick the right **structure set** per archetype (marketing vs blog/docs vs app). The component renderer is the default; an SSG (e.g. Eleventy) only where Markdown-owned layout is genuinely better.

### Deferred (only when a brief truly needs it)
Astro · a real headless CMS (Directus/Payload/Strapi) · payments/store · app-shell.

---

## Principles (unchanged)
Autonomous (brief in → result out, no human in the loop) · zero-trust (a deterministic check decides "done") · real artifacts (a site you can open) · generic (any brief) · honest (the dashboard never lies).

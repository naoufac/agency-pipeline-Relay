# CMS-native generation — architecture (the core goal)

See `GOAL.md`. Every generated site is built **on** a real headless CMS — one of **Drupal,
Payload, Craft, Sanity, Directus** — chosen once per project, all 5 integrated, exactly one per
project. This replaces `src/cms.ts` (a regex string-overlay text editor, not a CMS).

Grounded in current-web research (5 CMS profiled June 2026) + the synthesis in this session.

## 1. The contract — `CmsTarget` (`src/cms/types.ts`)
One interface all 5 implement. Every method is idempotent and confined to the project's namespace.

| method | purpose |
|---|---|
| `provision(ctx)` | stand up / re-attach a running CMS bound to this project — env/CLI/API only, zero UI |
| `modelContentTypes(inst, model, ctx)` | apply the normalized `SiteModel` as the CMS's native **code-first** schema (diff) |
| `pushContent(inst, model, ctx)` | write pages' copy + sections + catalog rows as real CMS documents (upsert by slug) |
| `buildAndServe(inst, model, ctx)` | **fetch content back OUT of the CMS** and render each page via Relay's existing `renderPage`; stamp a provenance marker |
| `readBack(inst, slug, ctx)` | fetch one page's canonical fields straight from the CMS read API — the gate's proof handle |
| `healthcheck(inst)` | cheap liveness probe; gates provisioning + polled before model/push |
| `teardown(inst, {purge})` | release the project's CMS footprint (stop process, drop schema/dataset) |

The LLM **never** authors schema: `modelContentTypes` consumes the already-normalized, validated
`SiteModel`, and the closed set of Relay section types maps to a fixed, hand-written content-type
template per CMS.

## 2. The selector (`src/cms/select.ts`) — IMPLEMENTED + PROVEN
Deterministic, brief-rooted, closed-set — mirrors `archetypeFor()`/`themeFor()`. Chosen **once** at
plan time, stored in `projects.params.cms` (the same jsonb where `theme`/`archetype` live — matching
the codebase convention, **not** a new column).

- **Tier 1 — explicit:** an LLM-named cms is honoured only if it's in the closed set of 5.
- **Tier 2 — archetype rotation:** otherwise rotate the archetype's candidate list by a stable FNV-1a
  hash of the brief, so the choice is a pure, reproducible function of the brief yet **every adapter
  gets real traffic** ("all 5 present"):
  - `site` → `[sanity, directus, craft]` (blog/magazine/news → `[drupal, directus, sanity]`)
  - `app` → `[payload, directus, drupal]`
  - `store` → `[directus, payload, drupal]`
- **Tier 3 — fallback:** `directus` (highest autonomous-fit, free, shares the existing Postgres).
- **Craft is never a silent default** for `app`/`store` (per-project licence, phone-home, domain
  binding) — explicit-opt-in / site-tail only.

> Rotation keys on the **brief** hash, not `projectId` (the project row doesn't exist yet at plan
> time). Reproducible per brief. Proof: `npm run cms:check` (determinism · explicit override ·
> all-5-reachable · craft-never-silent-default).

## 3. Shared infrastructure — one box, NOT a container per project
Per-project containers would blow RAM at 10+ projects and add 2–5 min boot latency. Instead:

- **One shared, long-lived instance per self-hosted CMS** (Directus, Payload, Drupal, Craft).
  Per-project isolation = a dedicated **Postgres schema per project** on the **existing** `ap-pg`
  (`cms_<name>_<32hex(projectId)>`), reusing the proven `appdb.ts` schemaName contract (validated
  identifier, never `public`, drop-confined).
- **Sanity** is cloud SaaS: one org token in env; one project+dataset per Relay project via the
  Management API. Its "instance" is just `{projectId, dataset, tokenRef}`.
- **Ports bound to `127.0.0.1` only** (Directus :8055, Payload :3001, Drupal :8080, Craft :8081),
  consumed internally by the Node build step — never publicly exposed (kills the "human logs into
  admin UI" risk).
- **Media:** the existing local-asset pipeline stays; CMS file fields store URLs into
  `/sites/<id>/assets`, so no S3 dependency is forced.
- **Lifecycle:** one systemd unit per CMS (mirroring `relay-worker.service`); `relay-deploy.sh`
  brings them up.

## 4. The zero-trust gate — `served_from_cms`
A new `verify.ts` rule that proves the page on `/sites` is a **projection of a CMS read**, not
standalone HTML. Per built page:
1. `projects.params.cms` + a live `CmsInstance` must exist — else **fail closed**.
2. `adapter.readBack(slug)` does a **real authenticated CMS read**; a dead CMS / empty dataset fails.
3. Every non-empty CMS field value must appear verbatim in the served HTML.
4. The page must carry a provenance marker `<!--relay:cms=<name> doc=<docId>-->` whose `docId`
   resolves to a real document via a **second independent CMS fetch**.
5. **Mutation proof (the un-fakeable core):** write a unique sentinel to the page's title **through
   the CMS write API**, re-run `buildAndServe`, assert the sentinel appears in the freshly served
   HTML, then revert. Static HTML can never satisfy this.

An agent cannot self-report it; static HTML cannot pass it.

## 5. Build order
1. **Directus** — lowest friction, closest to what Relay already does (schema-as-code, SDK content,
   shared Postgres). Hardens the interface + the gate first. **← build first.**
2. **Payload** — 100% code-first TS schema, Local API, shares Postgres; natural fit for `app`.
3. **Sanity** — code-first schemas, idempotent `createOrReplace`, trivial GROQ read-back; adds a SaaS
   dependency so it shouldn't define the interface.
4. **Drupal** — fully automatable (config-as-code, JSON:API, free) but the heaviest stack (PHP-FPM).
5. **Craft** — last by a clear margin; the only one with structural no-human blockers ($299/project,
   phone-home, domain binding). Present to satisfy "all 5", explicit-opt-in only.

## 6. Pipeline changes (when adapters land)
- `planner.ts`: select cms + persist `params.cms` (**done**); inject a `provision` task
  (`verify:cms_healthcheck`) as the first build-phase task, upstream of `compose`.
- `runner.ts`/`agents.ts`: add deterministic (no-LLM) departments `provision` and `model`; the
  `render` department becomes `adapter.buildAndServe` (fetch from CMS → same `renderPage` →
  stamp provenance). `render.ts` stays a pure `spec→HTML` function — only its **data source** changes.
- `verify.ts`: add `cms_healthcheck` + `served_from_cms`; "done" now requires `served_from_cms`.
- `dogfood.ts`: add a live-browser assertion that the served page shows CMS content.
- **Removal:** delete `src/cms.ts` (`instrument`/`applyOverlay`/`republishPage`/`syncBlocks`); the
  `/api/page*` edit routes become CMS writes + `buildAndServe` under the gate; drop
  `page_snapshots`/`page_blocks` after the edit path is cut over. `/sites` static serving is
  unchanged — `buildAndServe` writes the files; the CMS is the source, the static file the cached,
  gate-verified projection.

## 7. Top risks → mitigations
- **Instance sprawl / RAM** → one shared instance per CMS + schema-per-project; gate compose on
  `cms_healthcheck` with transient retry (reuse `runner.ts` backoff).
- **Gate gamed by coincidental strings** → the mutation-proof sentinel + provenance docId.
- **Schema-from-brief is hard & per-CMS** → consume the validated `SiteModel`; fixed hand-written
  content-type templates per CMS; no LLM authoring schema. (Craft can't → explicit-only.)
- **Two sources of truth drift** → `buildAndServe` reads ONLY from the CMS; the gate diffs
  file-vs-CMS, so drift fails "done". `params.site` becomes input-to-push only.
- **Secret sprawl across 5 backends** → store only token **references** in a `cms_instances` table;
  real secrets stay in env/systemd; all CMS ports bound to `127.0.0.1`.

## Status (honest)
- ✅ Interface (`src/cms/types.ts`) — compiles (project-wide tsc 0 diagnostics).
- ✅ Selector (`src/cms/select.ts`) — implemented + **proven** (`npm run cms:check`).
- ✅ Pipeline hook — `planner.ts` records `params.cms` on every new project (typechecked; live-DB
  confirmation lands with the first real CMS build).
- ✅ `src/cms.ts` **removed** — the string-overlay editor is gone: the runner writes the rendered
  page directly, the `/api/page*` editor routes + the board **Edit tab** are deleted, `cms.ts` is
  deleted. tsc 0 diagnostics; app.js parses; 0 editor refs left. (DB tables
  `page_snapshots`/`page_blocks` left inert for now; dropped in a migration when the CMS edit path
  lands, to avoid an irreversible drop on the shared prod DB mid-feature.)
- ✅ **Directus adapter — built + PROVEN** (`src/cms/directus.ts`). A real shared Directus runs on
  `ap-pg` (`deploy/relay-cms-up.sh`); `npm run prove:directus` builds a 2-page site ON it and the
  `served_from_cms` gate passes incl. the **mutation proof** (`[index#N · about#N · mutation-proof:PASS]`).
- ✅ **`served_from_cms` gate** (`src/cms/gate.ts`) — CMS-agnostic; sentinel write-through proof.
- ✅ **Registry, all 5 present** (`src/cms/registry.ts`, `npm run cms:status`): directus=proven;
  payload/drupal=pending (free, standable, adapters not written yet); sanity=blocked (needs a Sanity
  account + write token); craft=blocked (needs a purchased $299 licence + phone-home). The registry
  falls back to the proven Directus for an unbuilt choice — never fakes.
- ⏳ **Not done yet:** wire the adapter into the live generation runner (so produced sites build on
  their CMS by default — pending a scratch-DB end-to-end proof before prod); Payload + Drupal
  adapters/standups; `served_from_cms` inside `verify.ts`/`dogfood`. Sanity + Craft await operator
  credentials/licence.

# North Star — what Relay actually is

**Relay replaces a media agency.** The client's ask defines the deliverables. Building a
website is ONE tool in the kit, not the product. We stopped being a website vending machine.

## The one principle: substrate over bespoke

Give the LLM a foundation it already masters, then force the agency chain on top. A cold LLM
with little context hallucinates; an LLM editing a *known* WordPress install (header, theme,
nav, WooCommerce for ecom) does not — it knows exactly where to change what. So:

- **Websites run on a CMS the LLM knows cold.** WordPress by default; WooCommerce when it's
  ecom; PrestaShop for French ecom. Our hand-rolled Directus renderer stays as ONE lightweight
  option for simple/structured sites — it is no longer the religion.
- **Apps are real full-stack, no lies.** Real database, real API calls, programmed logic —
  "a button that fires an API call and returns data." The *deliverable* chooses the language
  (iOS app → Swift + backend + DB). "App" is a project TYPE the orchestrator selects when
  the client needs one — never a TWA button glued onto a website.
- **Campaign/marketing work** (email, images, video, mailing) uses the tools we already have.
- **Brand identity** (logo, palette, typography, guidelines only — no website) is its own
  deliverable. The chain ends at design_guidelines + brand_guidelines with no compose/render.

## The deliverable set (current, 2026-07-06)

The orchestrator (`src/orchestrator.ts`) maps every brief to one of these seven deliverables.
No others exist. Every deliverable has a deterministic regex floor detector and a registered
builder. See `docs/capability-matrix.md` for the full matrix.

| Deliverable | Stack | Builder | When |
|---|---|---|---|
| `directus_site` | directus | directus | Default: plain brochure site, portfolio, event site, anything without strong signals |
| `landing_page` | directus | directus | One-page conversion-focused brief ("landing page", "one-page", "page de vente") |
| `brand_identity` | campaign | campaign | Brand package only — logo, palette, guidelines, NO website |
| `wp_site` | wordpress | wordpress | Blog, news, magazine, multi-author editorial content |
| `wp_woocommerce` | woocommerce | wordpress | E-commerce: shop, cart, checkout, product catalog |
| `fullstack_app` | node-postgres | app | SaaS, dashboard, booking platform, marketplace, tracker |
| `campaign` | campaign | campaign | Email/social campaign assets — NO website |

## The brain: the orchestrator (this is the main job)

The first reasoning model reads the client's ask and decides three things:
1. **What** we are building — one of the seven deliverables above.
2. **Which stack/language** that deliverable dictates.
3. **Which chain** of capability blocks to run.

The chain = a **FORCED SPINE** + **DYNAMIC BRANCHES**.

- **Forced spine (always, the human/agency touch):** understand the client → research →
  branding → design guidelines → [build] → QA. This is the non-negotiable quality floor.
  It is forced precisely because a simple LLM cannot "just make a good site" — the
  research + brand + design context is what an agency brings and what stops the machine
  from hallucinating a generic dark-hero template.
- **Dynamic branches (per demand):** the build steps differ by deliverable and by what
  the client actually needs. Some capabilities are forced to ensure success; others are
  optional. The orchestrator chooses, wires dependencies, and composes.

The capability blocks are the orchestrator's **vocabulary**, composed with logic — not a
fixed march every project suffers.

## Routing guarantees (deterministic floor)

- The floor detector is pure regex — zero network, < 1ms, never flaky.
- The LLM may only **upgrade** from the `directus_site` floor (e.g. suggest `wp_site`
  for a news brief the regex under-scored). It can never downgrade a non-default result.
- Every routing decision is recorded in `params.chainReason` (human-readable, displayed
  on the board) so owners can audit why their project took the path it did.
- Proof: `src/orchestrated-e2e-check.ts` (T39) gates every deliverable with a
  representative brief, LLM stubbed to offline, 737 assertions.

## What dies

- The Android-app button on every produced site.
- The fixed 16-steps-for-everyone pipeline (the count/shape now emerges from the deliverable).
- The "one pipeline, one CMS (Directus only)" dogma. Directus is one option; WordPress /
  WooCommerce / PrestaShop join it.

## What we keep and reuse (do not reinvent)

Email, images, video, mailing, the Directus renderer (as an option), billing/credits,
analytics, and the whole quality machinery: the gate suites, deploy-with-revert, backups,
monitoring, live-proof discipline.

## Assets already on the box

- WordPress + MariaDB containers RUNNING (relay-wp, 127.0.0.1:8057) — the WP substrate
  is a short hop, not a green-field build.
- Directus instance RUNNING (127.0.0.1:8055) — the default renderer.
- Postgres (127.0.0.1:5439/agency) — per-project schema apply proven.

## First increment (shipped, lock-20)

1. **Orchestrator decision layer** — brief → {deliverable, stack, composed chain
   (forced spine + dynamic branches)}, persisted on the project; board shows *why* these steps.
2. **WordPress as a real substrate** — forced spine (research/brand/design tokens) → the LLM
   provisions + themes a WP site via WP-CLI/REST, WooCommerce when ecom → QA.
3. **Full-stack app** — real Postgres schema per project, REST API proven.
4. **Brand identity + landing page** — shape-forced deliverables with no compose/render
   (brand) or exactly-1-page (landing).
5. **Campaign** — asset-only chain with no site renderer.
6. **28-suite gate chain** — every deliverable type proven; 0 failures on master.

Everything else hangs off the orchestrator.

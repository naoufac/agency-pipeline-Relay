# North Star — what Relay actually is

**Relay replaces a media agency.** The client's ask defines the deliverables. Building a website is ONE tool in the kit, not the product. We stopped being a website vending machine.

## The one principle: substrate over bespoke

Give the LLM a foundation it already masters, then force the agency chain on top. A cold LLM with little context hallucinates; an LLM editing a *known* WordPress install (header, theme, nav, WooCommerce for ecom) does not — it knows exactly where to change what. So:

- **Websites run on a CMS the LLM knows cold.** WordPress by default; WooCommerce when it's ecom; PrestaShop for French ecom. Our hand-rolled Directus renderer stays as ONE lightweight option for simple/structured sites — it is no longer the religion.
- **Apps are real full-stack, no lies.** Real database, real API calls, programmed logic — "a button that fires an API call and returns data." The *deliverable* chooses the language (iOS app → Swift + backend + DB). "App" is a project TYPE the orchestrator selects when the client needs one — never a TWA button glued onto a website.
- **Campaign/marketing work** (email, images, video, mailing) uses the tools we already have.

## The brain: the orchestrator (this is the main job)

The first reasoning model reads the client's ask and decides three things:
1. **What** we are building (WP site / WooCommerce store / PrestaShop / full-stack app / simple Directus site / campaign) — possibly several.
2. **Which stack/language** that deliverable dictates.
3. **Which chain** of capability blocks to run.

The chain = a **FORCED SPINE** + **DYNAMIC BRANCHES**.

- **Forced spine (always, the human/agency touch):** understand the client → research → branding → design guidelines → [build] → QA. This is the non-negotiable quality floor. It is forced precisely because a simple LLM cannot "just make a good site" — the research + brand + design context is what an agency brings and what stops the machine from hallucinating a generic dark-hero template.
- **Dynamic branches (per demand):** the build steps differ by deliverable and by what the client actually needs. Some capabilities are forced to ensure success; others are optional. The orchestrator chooses, wires dependencies, and composes.

The "16 blocks" are the orchestrator's **vocabulary**, composed with logic — not a fixed march every project suffers.

## What dies
- The Android-app button on every produced site.
- The fixed 16-steps-for-everyone pipeline (the count/shape now emerges from the deliverable).
- The "one pipeline, one CMS (Directus only)" dogma. Directus is one option; WordPress/WooCommerce/PrestaShop join it.

## What we keep and reuse (do not reinvent)
Email, images, video, mailing, the Directus renderer (as an option), billing/credits, analytics, and the whole quality machinery: the gate suites, deploy-with-revert, backups, monitoring, live-proof discipline.

## Assets already on the box
- WordPress + MariaDB containers are RUNNING (relay-wp, up 7 days) — the WP substrate is a short hop, not a green-field build. (The old WP generator *code* was wrongly retired; the infra is intact.)

## First increment (proposed)
1. Build the **orchestrator decision layer**: brief → {deliverable type(s), stack, composed chain (forced spine + dynamic branches)}, persisted on the project so the board shows *why* these steps.
2. Wire **WordPress as the first real substrate**: forced spine (research/brand/design tokens) → the LLM provisions + themes a WP site via WP-CLI/REST, WooCommerce when ecom → QA. Prove ONE end-to-end WP site that reads like an agency made it.

Everything else hangs off the orchestrator.

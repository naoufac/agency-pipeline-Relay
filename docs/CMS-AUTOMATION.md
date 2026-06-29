# Relay CMS automation — the definition

## The one rule
- **Code decides the stack. The LLM only writes words.**
  - The use case → CMS choice is a **forced, deterministic lookup in code** (regex classifier + fixed table). The model never picks the CMS, never "thinks", never reinvents.
  - The LLM is a **copywriter only**: one fast call (`minimax-m2.7`, reasoning = `minimal`) that returns page copy / product data / translations as JSON. Nothing structural.
  - (No "flash"/reasoning-off model exists on the current proxy — `minimax-m2` returns garbage; `m2.7` at `minimal` is the leanest that works. ~60s/site today.)

## The 5 use cases → the 5 CMS (forced)
Each engine assigned to the use case it is genuinely best at:

| Use case | CMS (forced) | Why this engine | Status |
|---|---|---|---|
| **Ecom** (shop, products, checkout) | **Medusa** | real headless commerce — cart, products, orders, Stripe. The original 5 don't do commerce. | ⏳ to install |
| **General website** (marketing/brochure) | **WordPress** | the general-site standard ("like WP"), huge theme ecosystem, fastest to a good-looking site | ⏳ to install |
| **Full-stack** (app + real data) | **Directus** | real Postgres data model + REST/GraphQL + admin — a data app, not a brochure | ✅ installed |
| **Amazing / futuristic design** | **Sanity** + generated frontend | headless + a bespoke modern frontend = total design freedom. (Craft fits too but needs a $299/site licence → avoided.) | ⏳ to install |
| **Multilingual** | **Drupal** | best-in-class i18n in core (100+ languages, per-language content/URLs) | ✅ installed |

> This is the recommendation. It swaps the earlier raw list (Drupal/Payload/Craft/Sanity/Directus):
> Payload folds into Directus (same full-stack job), Craft → Sanity (licence), and **WordPress + Medusa
> are added** because nothing in the 5 covered general-site or ecom well. Say the word if you want a
> different pin per row.

## The deterministic classifier (no LLM)
`classifyUseCase(brief) -> ecom | general | fullstack | design | multilingual` — first match wins:
1. **ecom**: shop, store, e-commerce, products, checkout, cart, sell, catalog, subscriptions, dropship
2. **fullstack**: app, platform, dashboard, booking, reservations, portal, marketplace, directory, CRM, members, login, orders, inventory
3. **multilingual**: multilingual, bilingual, languages, i18n, translate, "in English and …", localized
4. **design**: portfolio, agency, studio, brand, fashion, art, futuristic, award, "design-led", showcase
5. **general** (fallback): everything else

(Order matters: ecom/fullstack/multilingual are specific; design vs general is the last split.)

## The automation steps (per brief)
1. **Classify** — `classifyUseCase(brief)` in code. Forced, reproducible. No LLM.
2. **Force CMS** — use case → CMS via the table above. Recorded on `project.cms`. No LLM.
3. **Provision** — the chosen engine runs as a shared install; the project gets an isolated space
   (sub-site / content namespace / unique URL) on it.
4. **Write copy** — ONE fast LLM call (m2.7, minimal reasoning) → JSON: pages + copy (and products /
   translations for ecom / multilingual). The model writes words only.
5. **Push** — create the content via the engine's native API/CLI: `drush` (Drupal), `wp-cli`
   (WordPress), Medusa admin API, Sanity client, Directus items.
6. **Serve** — the deliverable is the engine's **own** site + theme + admin at the project URL. The
   client logs into that CMS and edits; the live site updates (real CMS, like WordPress).
7. **Record** — `project.cms` + live URL + admin URL saved; the board links straight to the real site.

## Per-project isolation (v1)
Shared engine + per-project namespace + unique URL (e.g. the Drupal `relay-<id>/...` aliases already
working). A separate install per project is a later scaling choice, not v1.

## Where we are
- ✅ **Full-stack → Directus** and **Multilingual → Drupal** are installed; **Drupal generation works
  end-to-end today** (`npm run cms:drupal-gen "<brief>"` → real Drupal site).
- ⏳ **WordPress (general), Medusa (ecom), Sanity (design)** — to install + give the same generator.
- ⏳ The classifier + forced table + board-button wiring (so the brief box on the board runs this).

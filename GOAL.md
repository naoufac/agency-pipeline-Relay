# Relay — The One Goal (locked 2026-06-28)

**Every website Relay generates is built on a REAL headless CMS.**

Five are integrated. Exactly **one is chosen per project** — the CMS is picked up front,
the way you pick a model, and *all* building flows through it:

1. Drupal
2. Payload
3. Craft CMS
4. Sanity
5. Directus

## Non-negotiable rules
- **All 5 present** in the system; **1 choice per project**.
- The chosen CMS is the **core** of the generated site: content lives in it, the site is
  built/served from it. **Not** static HTML with a regex text editor bolted on.
- The old "Editable CMS" — `src/cms.ts`, a regex string-overlay on frozen HTML — is
  **removed**, not extended. It was never a CMS.
- We work **only on Relay**.
- **Done = a deterministic external check passes**: the live site is genuinely served from
  its chosen CMS and content reads back through the CMS. Never an agent's word, never a
  self-report, never a marketing label.

## What this replaces
The roadmap previously marked an "Editable CMS" as ✓ Shipped. It was an inline text editor
(string substitution on frozen rendered HTML). That label is retired. See
`docs/HONESTY-AUDIT.md` for the full evidence-based correction of every roadmap claim.

# THE PLAN — from here to the automated agency (locked 2026-07-02)

**The vision (unchanged, locked):** Relay is an agency that runs itself. A brief goes in; a real,
verified product comes out — from a high-converting landing page to a full-stack app with a
database and user accounts. Zero humans between brief and live. One pipeline, one CMS.

This file is the plan of record. It is written for the **owner**, not for engineers.
Every milestone has three parts:
- **You get** — what exists when it's done, in plain words.
- **Phone check** — a 30-second test the owner runs from a phone. If it fails, it's not done.
- **Machine gate** — the deterministic check the system enforces. No agent's word, ever.

Milestones ship **in order**. A milestone is not started until the previous one's gate is green.
No side quests, no parallel systems, no "while we're at it."

---

## M1 · Landing pages that sell
**You get:** a brief like "landing page for a fitness coach" produces ONE focused sales page —
pain → promise → proof → offer → one big call-to-action. No filler pages, no brochure sprawl.
New proof/offer/urgency components join the vetted library; the copywriter role gets
conversion patterns.
**Phone check:** submit a landing brief on the board → open the finished site → it reads top to
bottom as one coherent pitch ending in a working sign-up/contact action. Count the pages: exactly 1.
**Machine gate:** the planner detects landing intent (closed-set, like archetypes — never LLM
whim) and emits exactly 1 page; the page carries ≥2 conversion sections; every existing gate
(render, consistency, served-from-CMS, interaction QA) passes.

## M2 · Forms that match the database
**You get:** an app/store brief generates forms derived from its data model — right fields, right
validation, dropdowns showing real related records (a product's category is a real category).
What visitors submit appears instantly in the live list and in the CMS.
**Phone check:** submit "restaurant reservation app" → open the site → the form has Name / Date /
Party size (matching the app's actual database) → submit on your phone → your row appears in the
list on the page.
**Machine gate:** form fields are compiled from the schema (never hand-emitted by the LLM);
interaction QA submits a real row and asserts it lands in the typed table AND renders in the
collection.

## M3 · Rebuild without losing data
**You get:** re-running a brief with changes updates the app safely. New fields appear; existing
rows survive. Iterating stops being scary.
**Phone check:** take a finished app with test data → re-run the brief adding "also collect phone
number" → after rebuild the form has the new field and the old submissions are still there.
**Machine gate:** rebuilds run generated migrations (ALTER, add-with-default — never DROP of
populated tables); an automated test writes a row, rebuilds with a changed model, and asserts the
row survives.

## M4 · Sign in and own your sites
**You get:** a Sign-in button on the board. You (and later clients) enter an email, get a magic
link, and see only your own projects. Every site has an owner.
**Phone check:** sign in on your phone with your email → the link arrives in your inbox → you see
only your projects; a second test account sees none of them.
**Machine gate:** every API query is scoped by the signed-in owner; an automated two-user test
proves user B cannot list or open user A's projects; magic-link email sends via the existing
naples.agency SMTP.

## M5 · The agency talks back
**You get:** when a visitor submits a form on a produced site, the site's owner gets an instant
email with the lead. When a build gets permanently stuck, YOU get a Telegram alert (today it just
sits silently on the dashboard). Nobody has to go looking.
**Phone check:** submit a form on any produced site → the owner email arrives within a minute.
**Machine gate:** a sent-mail record is written and verified per notification; the stuck-project
alert fires on the `project_stuck` event (dead-letter test proves it).

## ⛔ M6 (market/pricing) — DROPPED 2026-07-02
The owner was right: rushing to monetization while the product cannot produce one working full-stack
site, shows one boring design everywhere, and has broken buttons is exactly the old backsliding.
No selling until the output is agency-grade. It is also FREE — no Stripe. Replaced by:

---

# PRODUCTION QUALITY — the real work (honest reset, 2026-07-02)

M1–M5 built real PLUMBING (pipeline, schema-forms, data-preserving rebuilds, sign-in/ownership,
lead + stuck alerts) and those hold. But produced OUTPUT is not agency-grade. Three structural
failures, each verified on real sites, each its own milestone. Nothing here is "done" until it
passes on REAL produced output — a demanding creative director's bar, not a mechanical gate.

## PQ0 · Buttons that go somewhere real ✅ (2026-07-02)
Fixed the resolver that collapsed every CTA to the home page (and made home-page buttons reload).
Now CTAs route to the relevant page / action page / on-page conversion anchor, never circular.
Gate: dogfood flags circular and all-same-target buttons. Proven on the delivery app that had shipped
all-index buttons.

## PQ1 · Distinct design per brief
**You get:** two different businesses no longer look like the same page recolored. Real compositional
variety — multiple hero treatments, nav styles, section rhythms/layouts chosen from the brief.
**Phone check:** build a law firm and a skate shop → open both → they look like different studios made
them, not the same template in different colours.
**Machine gate:** an automated check that several briefs yield structurally different layouts
(different hero type, section order, nav) — plus a visual critique pass.

## PQ2 · Ecommerce that actually sells — CORE SHIPPED 2026-07-02, widening
**Shipped + proven live:** shop grid from the real products table with Add-to-cart · cart page
(quantities, remove, total) · checkout that writes a REAL order in one transaction, priced
SERVER-side from database prices (client prices are display-only), unit prices snapshotted on line
items · the browser reviewer BUYS on every store build (order + line items must land) · lead email
per order. Gates: ecom:check (20) + the buy probe in every review.
Live proof: ceramics store 0384560a — a 3-item order through the public site, total $141 computed
server-side, line items verified in the database.
**Phone check (yours):** open the store → add to cart → checkout → confirmation with a real order number.
**Still ahead:** product detail pages, options/variants, stock awareness.

## PQ · Agency-panel fixes (rolling — driven by "would a productive agency ship this?")
A 3-lens agency panel (creative director · ecom lead · account director) judges Relay's real output;
the #1 finding gets built + gated. Shipped 2026-07-02:
- **Real photos on every DB-backed card** (was the unanimous blocker): product/collection/feed cards
  render from the database, which the image pipeline never touched — so every catalog was text-on-
  white. Now each content row gets a real, cached, on-topic photo at build (rowmedia.ts; deterministic,
  retried against burst rate-limits). Proven: ceramics store, 6/6 products photographed.
- **Grey hero void killed**: a failed hero photo is now an intentional dark branded panel, never grey.
Gates: ecom:check + spec:check extended. Next panel picks: hero art-direction/overlay consistency,
product detail pages, global spacing/interaction/empty-state polish.

## PQ3 · A CMS a client can actually use — CORE SHIPPED 2026-07-02, widening
**Shipped + proven live:** every site has a Content tab — the owner sees their REAL collections
(Products / Menu / Categories / Posts…), and edits, adds, or deletes records; changes are live on the
site immediately (the site reads those tables live). Owner-only (auth:check proves B + anonymous get
404). **Architecture note:** Directus runs in a SEPARATE database and cannot reach the per-project
app_<hex> content schema without a risky re-architecture that would endanger M2/M3/PQ2 — so Relay
owns the content-editing surface over its own database, while Directus keeps serving the presentation
pages (served_from_cms untouched). This delivers the phone check; it is honestly NOT "editing in the
Directus admin".
Live proof: edited a product's price on ceramics store 0384560a; the live catalog + shop tracked it.
**Phone check (yours):** open a store's Content tab → edit a product's price → open the shop → it changed.
**Machine gate:** content:check (19) — edit/add/delete on a real scratch schema, unsafe input refused,
system tables hidden; auth:check proves owner-only.
**Still ahead:** image upload, richer field types (dates, booleans as toggles, relation pickers).

## PQ4 · Free self-serve (only after PQ1–PQ3)
Anyone signs up and builds, free. Accounts + ownership already shipped (M4); this just opens the door
once the product is worth it.

---

## Standing rules (locked — same as GOAL.md)
1. **One pipeline, one CMS (Directus).** `npm run cms:check` fails the build on any second system.
2. **Work only on Relay, never on a produced site.** Fix the generator, rebuild the output.
3. **Delete before you add.** Dead weight is removed, not built around.
4. **Done = the phone check passes AND the machine gate is green.** Never a report, never a promise.
5. **No milestone starts before the previous gate is green.** No parallel half-built systems.

## Owner note (2026-07-02) — pulled forward / queued
- **Lead email alerts shipped early** (was M5's core): every produced-site submission is emailed to
  the operator; SMTP + SPF/DKIM/DMARC live; status published at mail.naples.agency. M5 keeps the
  stuck-build Telegram alert; M4 adds account email on the same rails.
- **Queued after M6 — mission-rooted differentiation** (owner's agency principle: every choice
  follows the client's mission, like a Shopify build where theme/apps/categories serve the store's
  purpose): deeper visual variety, mission-driven capability choices, richer brand systems.

## What is explicitly NOT in this plan (deferred until a milestone needs it)
Multi-operator teams · analytics dashboards · custom client domains · object storage / scale-out
(steps recorded in `docs/STACK-REVIEW.md`) · any new CMS, framework, or service.

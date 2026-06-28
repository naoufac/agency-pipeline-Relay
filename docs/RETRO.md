# Retro — where the build loop went slow, and the fix

An honest inspection of *how we worked* (not the product). Written after ~3M tokens, because the
trajectory itself shows the inefficiency and the cure.

## Where it went slow / in circles

1. **The button loop (the clearest circle).** "Buttons" were fixed **three** separate times:
   `href="#"` (dead) → all CTAs to one global page (the "last page" fallback) → `[object Object]`
   labels from object-valued CTAs. Each round was a full cycle: implement → deploy → **the operator
   manually finds the next button bug** → report → fix → rebuild. One feature, ~3 round-trips.

2. **Live builds used as the unit test.** Almost every change was "verified" by deploying and
   submitting a **real LLM brief** (~3–4 min build) then **polling 5–15×**. That live-build-poll cycle
   was the dominant token + wall-clock sink — and usually unnecessary: the deterministic checks
   (`tsc`, `npm run demo`, `npm run theme:check`, small scratch tests) already proved correctness.

3. **Issues escaped to the operator** because the automated reviewer was shallow (checked only
   `href != "#"`), then crashed on navigation, then false-alarmed on async content. So the human
   became the bug-finder — which *is* the round-trip loop.

4. **Chasing a single build's finding.** This very session ended with ~8 tool calls trying to decide
   whether one reviewer finding on one site was real (it wasn't, clearly: data + API + markup all
   correct). The pattern in miniature.

## The fix (already mostly implemented)

- **Shift verification left + make the reviewer trustworthy.** `dogfood` now: audits **every link on
  every page** (label sanity + dead href) and **load-tests every internal target**; is **robust** to
  mid-check navigation; **polls** for async collection/form results (no timing false-positives); and
  its **verdict is visible on every project card** ("✓ reviewed" / "⚠ review found N issues"). The
  system finds issues before the operator → the find→report→fix loop ends.
- **Stop live-building to test.** Prove correctness deterministically (typecheck · demo · theme:check
  · scratch unit tests · `dogfood` on ONE representative site). Do a live LLM build **rarely** — a
  final demo, not a per-change check.
- **Fix the class + add the gate that catches it.** Buttons looped because instances were patched;
  the comprehensive reviewer now catches the whole class. Same rule for the next surprise.
- **Less polling.** Use the completion notification; don't tight-loop a build.
- **Don't re-chase the reviewer.** Trust its verdict, fix the cause once, re-run once.

## Known next item (don't lose it)

The reviewer still needs an **accuracy pass**: on one build it reported an empty `products`
collection + a non-persisting form while the data, API and page markup were all correct — most likely
a quirk of the reviewer's own headless browser fetch, not a site bug. Confirm with one real-browser
check, then either fix the reviewer's fetch path or add a tolerance. Until then, treat single
medium/`empty-collection` findings as *suspect*, not gospel.

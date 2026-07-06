# Fresh-Eye Audit — 2026-07-06

Four independent auditors (code, product-as-stranger, ops/DR, process forensics), read-only, given artifacts not my narrative. Scores: code 5, product ~5, ops 3, process 6.5. Then I verified every critical myself before acting — which mattered, because the two headline "criticals" were wrong.

## Acted on immediately (verified + fixed + deployed)

**1. Two "CRITICAL live breaches" — FALSE POSITIVES.**
Auditors reported public Postgres superuser on :5439 and open origin on :8787, "confirmed by connecting from the public IP." Both tests were run from ON the box — connecting to the machine's own public IP short-circuits locally and bypasses external filtering. A genuine 6-node external probe (Brazil, Serbia, USA, Israel, Ukraine) showed **both ports time out from the internet**. INPUT policy DROP + a DOCKER-USER rule were already blocking them. Acting on the false alarm would have meant recreating the prod DB container in a panic — averted.
Real gap underneath: the load-bearing DOCKER-USER DROP for :5439 wasn't persisted (Docker flushes that chain on daemon restart). **Fixed:** new `relay-firewall.service` (`PartOf=docker.service`) re-applies it idempotently on reboot and docker restart. Verified present + single rule.

**2. Live CSS-hash regression — REAL, now fixed.**
The external-CSS change (my ARC C) made every page link `ds-<hash8>.css`. When the CSS changed, the hash rotated, but pages already on disk (all interior pages, and the 5 re-finalize-refused sites entirely) kept the OLD hash — which 404'd, rendering those pages **unstyled**. Confirmed live on 6/6 sampled sites. **Fixed at the class:** the server now serves the current design-system CSS for ANY `ds-<hash>.css` that isn't on disk (the CSS is backward-compatible, so old pages get styled with zero re-render). Verified: all sampled home + interior pages now 200, including the 5 gate-refused sites.

**3. Offsite backup — confirmed working.**
Auditor said the vault push still fails nightly. The failing run was BEFORE this session's HOME=/root fix; I re-ran via the exact service path the timer uses — it shipped (remote advanced to 61a4103). Tonight's timer will succeed.

## Real findings still open (triaged, not yet done)

High value, low risk:
- **Post-deploy asset canary:** fetch every asset referenced by every page of a sample of live sites, fail on any non-200. Would have caught #2 before a human did. (Top follow-up.)
- **Shop window (relay-site) inconsistencies:** TTFB ~1s (it renders live per request while client sites are static ~0.25s); it invents 3 conflicting price stories; sells services as "in stock" store products; the board's "reviewed — works" badge is stale (asserted green while pages were unstyled). The badge must be earned against the live deployed site walking interior pages.
- **Pricing has no single source of truth** — copy, seeded products, and roadmap were generated independently and disagree. Needs one canonical offer projected into every surface.

Structural (pay down before adding features):
- **renderPage ctx is hand-copied across ~14 call sites with 15 optional fields** — this exact "caller forgot a field" class caused 4 same-day live bugs. Fix: one `buildRenderCtx(project, page)` factory; make required fields non-optional.
- **The render-output gate lives in triplicate** (verify.ts, theme-check.ts, eval.ts) with a comment ordering them to "stay in lockstep" — already drifted. Extract one shared function.
- **The suite over-indexes on source-text pins** (assert code is spelled a certain way, not that behavior works). None of the day's 6 real defect classes were caught by the 1000+ assertions — all caught by live builds, screenshots, adversarial review, or tsc-at-deploy. Convert security/owner-gating pins to real request-level tests.

Ops hygiene (real, mostly lower urgency given ports are firewalled):
- `sites/` artifacts (839M) are in NO backup — recovery assumes untested regeneration. Add to the vault.
- Secrets in plaintext env + a Telegram token hardcoded in a systemd drop-in (0644); DB password is literally `postgres` (firewalled, but rotate as defense-in-depth).
- All monitoring runs on the box it watches — no external dead-man's switch. Add one heartbeat (healthchecks.io) so a broken alarm can't hide a broken backup/box.
- `tsx` in prod with Restart=always and no MemoryMax — crash-loop risk on a box also running Postgres+Directus+nightly LLM builds.

## Process lessons (now saved to memory, will shape future sessions)

- Marker/substring gates pass while rendered CSS is dead — **read real screenshots before UI sign-off.**
- Features break at ownership seams — **gate through the real final writer, with real-world content**, and persist derived state once.
- **Verify worker claims in my own tree** (bootstrap .env, push before spawning, re-gate, diff deliverables vs the brief).
- **Never chain commit/push/deploy after a gate in one line** — read the gate result as its own step.
- **Verify network exposure from off-box** — on-box tests to the own public IP false-positive (the meta-lesson from this very audit).
- Half the day's substantive commits were same-day rework of same-day work — when rework exceeds ~25%, stop adding arcs and convert the escaping class into a structural fix + behavioral gate.

## Honest bottom line
The verification culture is genuinely strong (nothing broken shipped un-caught for long), but the first-line gate keeps missing whole classes that only live proofs catch — and I introduced a real live regression (unstyled interior pages) that sat until this audit. The system is more secure than the audit's headline claimed, and now has one fewer live bug and one fewer reboot-exposure than before it started.

# Relay — Changelog

A running record of shipped advancements. Every entry is backed by a **deterministic check**, not self-report.

## 2026-06-27

### Deterministic render engine + cleanup ✅
The LLM no longer writes HTML — it picks copy, 2 brand colours, and a section list; a deterministic engine builds the page.
- **What:** the `build` agent now emits a JSON **spec** (brand tokens + an ordered list of sections — hero/features/split/gallery/cta/form). `src/render.ts` `renderPage` turns that spec into the full self-contained page from hand-built **vetted components** (`src/components.ts`), so nav/spacing/fonts and **WCAG contrast** are correct **by construction** (the palette is derived deterministically from the 2 brand colours; the nav is a CSS-only hamburger that can't overflow). The model only chooses copy + colours + which sections. `src/media.ts` fills the `<img data-q>` slots with real **Pexels** photos served locally. The build still terminates in the unchanged `site_renders` gate.
- **One engine, four layers:** this single render contract serves the **website**, the **editable CMS** (`src/cms.ts` instruments + re-overlays edits onto the page deterministically), the **full-stack + database** path (a `form` section posts to Postgres `site_submissions` → surfaced in the **Data** tab), and **visual QA**.
- **Removed entirely:** the old Tailwind/excellence layer is **gone** — deleted `src/excellence.ts`, the ~120 MB `tools/tailwindcss` binary, `tools/setup.sh`, the `package.json` `postinstall`, and the `relay.service` `ExecStartPre`. `cms.shipHtml` is simplified to just strip the edit ids (`stripEditAttrs`). The whole "fresh clone ships un-styled because the binary is missing" failure mode no longer exists.
- **Visible in-product:** the live `/#/docs` **System** page now shows this render-engine architecture.

### Roadmap 09 — Visual self-QA ✅ + mobile nav fix
Relay now *looks at its own work* and reports problems.
- **What:** after every build (and on demand via the QA tab), Relay screenshots each page at **phone (390px) + desktop (1280px)**, sends each to a **vision model (Gemini 2.5-flash)** that reports concrete, visible problems (broken/overflowing nav, truncation, low contrast, placeholder text, weak hierarchy) and a 1–10 score. Stored per page/viewport in `qa_reviews`, surfaced in a new **QA tab** (screenshot + score + issues) with a "Re-run review" button. `src/vision.ts` + `src/qa.ts`; `/api/qa` + `/api/qa/run`; auto-runs from `runLoop` on completion.
- **Mobile nav (deterministic):** the build agent was emitting desktop-only navs that overflowed on phones. The excellence layer now injects a real **hamburger** (tags the link list + a toggle button) + an `overflow-x` / `flex-wrap` safety net — so a produced nav can never overflow/cut off on a phone, regardless of what the model emits. Verified: clean "brand · ☰ · CTA" on a 390px screen.
- **Proof:** the QA loop immediately flagged the real mobile-nav issue (and caught leftover `EDIT-` placeholder copy from testing) — score went from 2/10 (broken nav) upward after the fix.
- **Gotcha fixed:** Gemini 2.5-flash is a *thinking* model; a low `maxOutputTokens` was consumed by reasoning and returned empty — set `thinkingBudget: 0`.
- **Hardened (adversarial review found 11 bugs, 2 critical — all fixed + tested):** (1) `navMobilify` spliced the nav with `String.replace`, whose `$`-patterns corrupted any nav copy containing `$` (prices) — now an index splice (10 unit tests incl. `$$`, `$'`, `$&`). (2) chromium ran **synchronously** in `verify.ts`/`qa.ts`, freezing the HTTP event loop during every render (a self-DoS, and why concurrent builds were slow) — now async `execFile` (verified: 69 `/healthz` during a QA run, max 46ms). (3) `qa_reviews` delete-then-insert with no key → duplicate/torn rows under concurrent reviews — now `unique(project,slug,viewport)` + atomic upsert + a per-project in-flight guard. (4) nav detection now iterates candidates + requires a link-`<ul>` (nested `<header>`, logo-first header, and cart/social `<ul>`s no longer defeat or hijack the hamburger). (5) unparseable vision response no longer stored as a fake `0`; `/api/qa/run` now checks the build is done + has its own rate limit.


### Roadmap 08 — Editable CMS ✅
Edit a page's content and re-publish it through the same verified path.
- **What:** every build now freezes each page's editable HTML (post-media, pre-excellence, with stable `data-edit` ids) in Postgres (`page_snapshots` + `page_blocks`). A new **Edit** tab (`#/p/:id/edit`, mobile-first) lets you change any page's copy block-by-block. **Publish** re-renders just that page by deterministically overlaying the edits onto the frozen snapshot (no LLM — the design cannot drift), runs the IDENTICAL `site_renders` gate against a `<slug>.html.tmp`, and atomically renames it over the live file **only on pass**. `src/cms.ts` holds the core; the build & republish share one finalize path so they can't diverge.
- **Design choice:** the panel disqualified "re-run the build LLM" (temp 0.7 → silent redesign on a one-word edit) and "patch the on-disk file" (`applyExcellence` double-inlines CSS). Frozen-snapshot + string-overlay + atomic `.tmp` swap is the only approach that keeps edits deterministic AND zero-trust.
- **Verified end-to-end:** edited a hero headline → published → live file contains the new text, **only 2 lines changed** (design byte-identical), still passes the gate; a second edit **persisted** the first (dirty-flag fix); a deliberately breaking edit (`[Placeholder]`) was **rejected** with the live page untouched. Mobile editor verified at 390px.
- **v1 scope:** text editing. Photo-swap and inline-styled (read-only) headings are the next increment.
- **Hardened (adversarial review + ~60 tests):** a 4-attacker panel found **8 real bugs**, all fixed + regression-tested. `stripEditAttrs` is now the exact inverse of `instrument` (a literal `data-edit="…"` in page copy survives); **quote-aware** tag parsing so a `>` inside an attribute can't mangle structure on edit; **atomic** publish claim (no TOCTOU double-publish, proven by a live race test); crash-stranded `publishing` state is reclaimed on boot + every 2 min; a mid-publish edit is no longer swallowed (exact-value fold); agent-authored `data-edit` ids can't collide; the unverified `.tmp` candidate is never served; `a<b` text is editable again. Publishing got its own generous rate limit so editing isn't throttled.


### Roadmap 07 — Email platform ✅
Production email from `noreply@naples.agency`.
- **What:** authenticated SMTP (`nodemailer`, `src/mailer.ts`) through the domain's cPanel mail server, which is in the domain SPF, signs DKIM (default selector), and has DMARC — so mail is inbox-aligned. Wired in as `sendMail`/`verifyMailer` + `npm run mail:test`. (Outbound :25 is blocked on this box, so a self-hosted MTA was never viable — this is the correct production route.)
- **Verified:** `verifyMailer()` → true (SMTP connect+auth over verified STARTTLS); SPF + DKIM + DMARC records present; two live test emails landed in a real Gmail **primary** inbox.

### Roadmap 06 — Real media ✅
Real licensed photography in the sites Relay builds.
- **What:** the build agent names the photo each section needs via `<img data-q="...">`; `src/media.ts` `processMedia` fetches it from **Pexels**, downloads into `sites/<id>/assets/`, and rewrites to a **local** `src` — gate-safe, never a broken link. Existing photos only, no AI generation.
- **Hardening (surfaced by verification):** the build now strips external `<script>`/`<link>` (Tailwind CDN, Google-Fonts preconnect) so pages are self-contained and pass the render gate first-try (so the agent's images survive); content/copy/build agents now invent realistic specifics and never leave `[Placeholder]` copy.
- **Verified:** live builds download real jpgs and embed them locally; pages render with rich photography (full-bleed hero + photo cards) and pass `site_renders` first-pass (0 external, 0 placeholders, 0 retries on the final build).
- **Known caveat (tracked):** photo coverage is reliable on content/feature pages, but the **home-page hero** is still LLM-variable — some builds render it as a gradient instead of a photo despite the mandate. Tightening (a deterministic hero-image guarantee) is the next refinement.

### Infrastructure (this session)
- **Ingress decoupled:** Relay runs on its own dedicated, supervised cloudflared tunnel (`relay-tunnel.service`), separate from the shared tenant tunnel. Crash-tested (kill → 2s respawn).
- **Durability:** `relay.service` + tunnel under systemd `Restart=always`; Postgres `unless-stopped`; daily agency-DB `pg_dump` backups (every 6h, 14 kept); 5-min uptime monitor → Telegram alerts; `/api/run` rate-limited (spend guard).
- **Docs in-product:** live `#/review` (verdicts) and `#/docs` (visual system map) pages, so the work is visible, not buried in files.

# Agency System KPI Report — 2026-07-06

Overall: **6.5 / 10** — world-class factory, zero real customers yet.
Method: 5 parallel evaluators, deterministic read-only checks only (gate suites, systemd/journal, SQL counts, live curl probes). No self-reporting trusted.

## Scores

| KPI | Score | One-line verdict |
|---|---|---|
| Engineering quality gate | 10/10 | `npm run check` exit 0 — 1020 assertions, 0 failures across all suites |
| Production ops & reliability | 7/10 | Monitoring/backups real, but offsite vault push broken + stale watchdog |
| Business funnel & throughput | 3/10 | 82 projects / 69 live sites in 9 days — but 0 real leads, 0 real bookings, 0 revenue |
| Live output quality | 7/10 | 5/5 real sites 200, TTFB <310ms, JSON-LD present — but 203KB inline CSS, images unoptimized |
| Lifecycle coverage (12 stages) | 7/10 | 8 stages DONE+certified; payments/analytics/custom-domains are the gaps |

## 1. Engineering quality gate — 10/10
- Full gate chain (build + 21 suites) exit code 0.
- 1006 counted assertions passed / 0 failed (spec 166, app 207, ecom 99, design 62, lifecycle 56, apk 52, layout 50, content 46, i18n 43, pwa 38, scope 34, chain 25, chat 24, llm 22, migrate 21, jsonld 21, figma 18, backup 18, leak 4) + cms 9 + theme 5 renders AA-pass.
- Note: PROGRESS.md says "23 suites"; the check script chains 22 steps (build + 21). Reconcile the count.

## 2. Production ops — 7/10
Green: zero error-level journal entries in 24h; board/healthz/site probes all 200 ≤0.37s; 5-min uptime cron with Telegram alerts; nightly canary e2e passing (last two: 9 min, 18 min); layered backups (6h pg_dump + nightly encrypted vault with restore-verify).
Broken/risky:
- **Offsite vault push FAILING since Jul 5** — `could not read Username for https://github.com` under systemd; last successful offsite copy ~36h old. Alarm did fire.
- **Deployed watchdog is stale v1** — treats 4xx as "up"; cms health currently 403 yet state says "up" (false green). Repo v2 fixes this but isn't deployed to /usr/local/bin.
- Relay needed SIGKILL on stop (timeout) at 04:29 — no graceful SIGTERM drain.
- All monitoring lives on the same box — box death is silent. No external uptime check.
- Queue: 157 done / 27 failed / 7 rework, no failure-rate alert threshold.

## 3. Business funnel — 3/10
- Throughput proof: 82 projects (all done), 957/957 tasks, 69 sites live, peak 34 projects/day. Latest canary: 16/16 steps, 23m57s build, 94% right-first-try.
- Leads: 13 rows in site_submissions — every one is a QA probe, test fixture, or the operator. **Real external leads: 0.**
- Bookings/orders across 51 app schemas: all seed data (identical timestamps, fake Stripe ids `pi_3abc123`) or internal proofs. **Real customer bookings: 0.**
- Users: 8 accounts = operator + 7 test emails. One owner for all 82 projects. Chat: 0 sessions.
- The `npm run kpi` CLI measures per-build quality only — no funnel dashboard exists.
- Path to 10: real inbound leads, external signups owning projects, bookings with genuine payment ids, repeat weekly volume. The machinery already supports it.

## 4. Live output quality — 7/10
Sampled openchair, continuum, taqueria-dona-rosa, cypress-law, fieldwork (real, non-canary):
- 8/8 probed URLs HTTP 200; TTFB 0.17–0.31s; viewport meta, single h1, meta description, og: tags, 2 JSON-LD blocks on 5/5.
Generator-class defects (one fix lifts every future build):
- ~203 KB inline CSS per page (65% of HTML weight) served `no-cache` — re-downloaded every view; zero external stylesheets.
- Images: 0/9 real alt text, no width/height (CLS), no srcset/webp/avif, hero uses `loading="lazy"` (LCP penalty).
- JSON-LD types generic (Organization/WebSite) — no Restaurant/LegalService per archetype. No canonical link.

## 5. Lifecycle coverage — 7/10
DONE+certified (8): lead capture, intake/brief, design tokens/presets, build/produce, preview+revisions, booking lifecycle, client chat, SEO structured data.
Partial/gated/missing (4):
- Payments/invoicing: checkout = manual payment instructions; Stripe v2 owner-gated; zero invoicing code. **Biggest business gap.**
- Client analytics: zero visitor/traffic instrumentation on produced sites — agencies report results to clients.
- Domains: wildcard *.naples.agency only; apex flip owner-gated; no client-owned (BYO) domain path.
- Play Store owner-gated (APKs signed+served, direct download only).

## Figma (done today)
- Token installed: /root/secrets/relay-figma.env + systemd drop-in relay.service.d/figma.conf; verified inside the relay process env; board 200 after restart.
- Token proven against Figma API through our importer: fake file key → `figma-file-not-found` (an invalid token would return `figma-unauthorized`). Scope `file_content:read` covers the `GET /v1/files/:key` call the importer makes.
- Remaining to certify the stage: one real Figma file URL from you → import → applied design on a live site.

## Top fix candidates (in order)
1. Offsite backup push auth (reliability, broken now).
2. Deploy watchdog v2 + investigate cms 403 (false-green now).
3. Generator: external/cacheable CSS + image alt/dimensions/srcset + archetype JSON-LD types (lifts all future sites, gateable).
4. Funnel: real distribution (apex flip is owner-gated — your call) + a funnel KPI view.

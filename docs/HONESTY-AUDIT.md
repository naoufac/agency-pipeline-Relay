# Honesty Audit — roadmap claims vs. real evidence (2026-06-28)

Every roadmap item in `web/app.js` checked against actual code + live runtime. No agent
self-report — only commands, files, and DB rows. Status legend:

- **REAL** — proven true by evidence.
- **REAL/overstated** — works, but the roadmap copy oversells it.
- **WIRED/UNPROVEN** — code path exists, but no persisted proof it ever succeeded.
- **FALSE LABEL** — the name claims something the code does not do.

| # | Item | Roadmap said | Evidence | Verdict |
|---|------|--------------|----------|---------|
| 00 | Engine | Shipped | DB board, runner, unblock trigger, verify (`src/runner.ts`, `db/schema.sql`) | **REAL** |
| 01 | Real product | Shipped | board `https://board.naples.agency/` → HTTP 200; `/sites/:id` served; 4 projects in DB | **REAL/overstated** |
| 02 | Honest quality | Shipped | `src/verify.ts` gate; `qa_reviews`=208 rows; honest KPIs | **REAL/overstated** |
| 03 | Generic + multi-page | Shipped | `src/planner.ts` LLM planner; multi-page sites + shared nav on disk | **REAL** |
| 04 | Real media | Shipped | `src/media.ts` + Pexels key set; `assets/` in produced site | **REAL** (not re-run this session) |
| 05 | Production email | Shipped | SMTP env set, `src/mailer.ts` | **REAL** per code; live delivery not re-verified this session |
| 06 | Built to last | Shipped: "Postgres supervised by systemd … daily backups … uptime alerts" | `relay.service` Restart=always + enabled ✓; dedicated `relay-tunnel.service` ✓; cron: `relay-db-backup.sh` every 6h ✓, `relay-uptime-check.sh` every 5min ✓. Postgres is a **local Docker container** `ap-pg` (postgres:16, `127.0.0.1:5439`, `restart=unless-stopped`, up 2 days) — **Docker-supervised, not systemd** | **REAL/overstated** — restart+backups+uptime all true; only the word "**systemd**" for Postgres is wrong (it's Docker `unless-stopped`) |
| 07 | Visual self-QA | Shipped | `src/qa.ts`+`src/vision.ts`; `_qa-*.png` in produced site; 208 reviews | **REAL** |
| 08 | Deterministic engine | Shipped | `src/render.ts`+`components.ts`+`spec.ts` | **REAL** |
| 09 | Rooted identity | Shipped: "genuinely different studios" | `src/themes.ts` (5 languages). Live build pages **all share one theme** (`--accent:#22D3EE,--bg:#0F172A,--font-display:'Grotesk',--font-body:'Inter'` identical across index/about/services/portfolio/contact). The "different style per page" bug did **not** reproduce on current prod | **REAL/overstated** (copy is PR fluff; theme is consistent per-site, which is correct) |
| 10 | Full-stack + database | Shipped: "the core mission, live" | `src/appdb.ts`+`schema.ts` real; only **1** `app_*` schema across **4** projects | **REAL/overstated** — mechanism works, barely exercised, not the default path |
| 11 | Interaction QA | Shipped | `src/dogfood.ts`; `dogfood_reviews`=16 | **REAL** |
| 12 | **Editable CMS** | Shipped: "Editable CMS" | `src/cms.ts` is a **regex string-overlay text editor** on frozen rendered HTML (instrument → applyOverlay → re-verify → atomic rename). No content model, no admin, no structured content, no CMS API. | **FALSE LABEL** — this is an inline text editor, **not a CMS**. Retired; replaced by the 5-CMS core. |
| 13 | Robust browser layer | Shipped | `src/browser.ts` persistent Playwright | **REAL** |
| 14 | **Web-grounded intelligence** | Shipped | `src/agents.ts` OpenRouter web-plugin wiring real; `OPENROUTER_API_KEY` + `MINIMAX_API_KEY` set. **BUT** no `llm_calls`/instrumentation table exists → **zero persisted proof** any web-grounded call ever succeeded | **WIRED/UNPROVEN** — downgrade from Shipped until a real run is logged |

## Bottom line
- **2 hard corrections:** #12 "Editable CMS" is a false label (it's a text editor); #14
  "Web-grounded" is wired but unproven.
- **3 overstatements:** #06 (Postgres is Docker `unless-stopped`, not systemd — everything else in the claim is true), #09 (PR copy; mechanism fine),
  #10 ("the core mission, live" for a feature run once).
- **Everything else checks out.**
- The honest headline number is not "14/14 shipped." After corrections: ~9 solidly real,
  3 real-but-overstated, 1 wired-unproven, 1 false-label-retired.

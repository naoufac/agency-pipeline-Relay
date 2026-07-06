# Relay — system logic & performance (2026-07-06)

## System logic (how a brief becomes a deliverable)

1. **Orchestrator** (`src/orchestrator.ts`) reads the brief and decides three things, deterministically first (regex floor) with the LLM only able to *upgrade* within a compatible set — never downgrade:
   - **deliverable**: directus_site · wp_site · wp_woocommerce · fullstack_app · campaign
   - **stack**: directus · wordpress · woocommerce · node-postgres · campaign
   - **chain**: a forced spine + dynamic branches. Speaks EN/FR/IT.
2. **Forced spine** (always, the agency touch): understand → research → branding → design guidelines → build → QA. It's forced because a cold LLM can't "just make a good site" — research+brand+design is the context that stops hallucination.
3. **Dynamic branches** fire only when the project needs them: `database`/`policies`/`integrations` on a real booking/data signal; `ecom_catalog` for a store; `wp_provision` for WordPress; `app_api` for an app; `campaign_assets` for a campaign. A blog gets no booking calendar; an email campaign gets no database.
4. **Runner** (`src/runner.ts`) executes the DAG task-by-task with zero-trust verify gates (a task can't be marked done until a deterministic check passes — SQL actually applies, contrast actually ≥4.5, HTML actually renders, WP page actually exists).
5. **Substrate builders**: Directus renderer (bespoke, default), **WordPress** via WP-CLI on the live container, real **full-stack app API** over a per-project Postgres schema. Selected by `params.builder`.

Everything is feature-flagged and additive: a plain website brief still produces the exact old pipeline, so the whole existing test suite stays valid.

## Performance — the LLM layer (the thing that was timing out)

**Root cause found by benchmarking live:** the primary path was the **direct MiniMax API** (`api.minimax.io`) on **MiniMax-M3**. Measured:

- direct M3: **63s** per call · direct M2.5/M2: **67-74s** and often truncate to empty (reasoning-only plan).
- Those 60-75s calls hit the compose step's timeout repeatedly → builds stalled. That's the "turning turning" you saw.

**The same MiniMax models on OpenRouter: 1-2s** on small prompts. So the fix was the provider layer, not the model:

- **OpenRouter is now primary for every call**, on your ladder: **minimax-m2.7 (favorite) → m2.5 (secondary)** → cheap/free deep fallback. Direct MiniMax is a deep failover only.
- **Reasoning headroom** added so mandatory reasoning can't truncate the JSON (m2.7 spends up to ~3.3k reasoning tokens).
- reasoning **effort: minimal**; compose timeout 180s → 90s.

**Measured after the fix (real full prompts, end-to-end):**

- branding ~16s · content ~32s · research ~36s (web-grounded, Exa) · compose ~78s → **builds now complete reliably** (were failing before).

## The one tradeoff you should decide

2.7 and 2.5 **force reasoning on** (OpenRouter rejects `reasoning: disabled` for them) — that's why real calls are 16-80s, not 1-2s. You said "most of the time we don't need reasoning."

The only MiniMax model that lets us **turn reasoning fully off** is **M3** — and on OpenRouter, M3-with-reasoning-off was the **fastest and cleanest** in the benchmark (sub-second, valid JSON, 0 reasoning tokens). The timeouts you hated were the *direct API*, not M3 itself.

So: if you want true speed, flip one env var — `OPENROUTER_MODELS=minimax/minimax-m3` with reasoning off — and calls drop from ~30-80s to a few seconds. Say the word and I'll switch it and re-measure a full build. Otherwise we stay on your 2.7→2.5 (reliable, reasoning-on).

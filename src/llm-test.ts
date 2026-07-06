// llm:check — provider resilience. The 2026-07-04 outage: OpenRouter's weekly key limit
// killed every build while a configured MiniMax-direct key sat unused, and the runner burned
// each task's defect budget on a days-long condition. These gates pin the two fixes with a
// STUBBED fetch (no network, no tokens): quota-class errors fail over; transient errors do
// NOT (they retry upstream); the runner parks instead of failing.
process.env.OPENROUTER_API_KEY = 'test-or-key';
process.env.MINIMAX_API_KEY = 'test-mm-key';
process.env.MINIMAX_BASE_URL = 'http://minimax.test/v1';
process.env.OPENROUTER_BASE_URL = 'http://openrouter.test/v1';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra); }
};

const { callLLM, isQuotaExhausted, isBadKey } = await import('./agents.ts');

// ---- the classifier: quota-class vs transient — the whole design hinges on this line ----
ok('quota: the exact 2026-07-04 message classifies as exhausted',
  isQuotaExhausted('OpenRouter 403: {"error":{"message":"Key limit exceeded (weekly limit). Manage it using https://...","code":403}}'));
ok('quota: spent credits classify as exhausted', isQuotaExhausted('MiniMax 402: insufficient balance') && isQuotaExhausted('OpenRouter 402: Payment Required — add credits'));
ok('quota: a plain 5xx is NOT quota (it retries as transient)', !isQuotaExhausted('OpenRouter 500: bad gateway') && !isQuotaExhausted('OpenRouter 502: upstream error'));
ok('quota: timeouts are NOT quota', !isQuotaExhausted('The operation was aborted due to timeout') && !isQuotaExhausted('fetch failed'));
ok('quota: a 429 rate limit without account words is NOT quota (transient handles bursts)', !isQuotaExhausted('OpenRouter 429: slow down'));
ok('quota: MiniMax bills via 500 — "token plan" classifies as exhausted (observed live)', isQuotaExhausted('MiniMax 500: {"type":"error","error":{"type":"server_error","message":"your current token plan not enough"}}'));
// a REVOKED/INVALID key is permanent config, NOT transient quota — it must FAIL fast, never park forever
ok('bad key: 401 unauthorized is a config error, not quota (would loop forever if parked)', isBadKey('OpenRouter 401: Unauthorized') && !isQuotaExhausted('OpenRouter 401: Unauthorized'));
ok('bad key: 401 invalid api key is not quota', isBadKey('MiniMax 401: invalid api key') && !isQuotaExhausted('MiniMax 401: invalid api key'));
ok('bad key: the failover composite carrying a 401 unauthorized is NOT parked', !isQuotaExhausted('failover after [OpenRouter 401: Unauthorized]: MiniMax 401: Unauthorized'));
ok('quota still parks the real thing: weekly limit / credits (402/429 billing words)', isQuotaExhausted('OpenRouter 403: Key limit exceeded (weekly limit)') && isQuotaExhausted('MiniMax 402: insufficient balance'));

// ---- provider ORDER (owner 2026-07-06, benchmarked): OpenRouter PRIMARY on the MiniMax 2.7 -> 2.5
// ---- ladder (1-2s); minimax-direct is a deep failover (the direct API is 60-75s). Stubbed fetch. ----
const realFetch = globalThis.fetch;
try {
  let calls: { url: string; body: any }[] = [];
  const record = (url: any, init: any) => calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });

  // 1 · normal call: OpenRouter (m2.7 primary) answers → minimax-direct never touched. think stripped.
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: '<think>pondering</think>dal primario' } }] }), { status: 200 });
  };
  const r0 = await callLLM('sys', 'user', 100);
  ok('PRIMARY is OpenRouter minimax-m2.7 (fast) — one call, think stripped, direct untouched',
    r0.meta.ok === true && r0.meta.provider === 'openrouter' && /minimax-m2\.7/.test(String(r0.meta.model)) && r0.text === 'dal primario' && calls.length === 1 && calls[0].url.includes('openrouter'), JSON.stringify(r0.meta));

  // 1b · reasoning HEADROOM: a MiniMax model is a reasoner, so the wire budget = caller + THINK_HEADROOM
  //      (so mandatory reasoning can't truncate the JSON answer). One call, no doubling retry on OR.
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'risposta vera' } }] }), { status: 200 });
  };
  const rh = await callLLM('sys', 'user', 1000);
  ok('reasoning-headroom: OpenRouter wire budget > caller budget for a MiniMax reasoner',
    rh.meta.ok === true && rh.text === 'risposta vera' && calls.length === 1 && Number(calls[0].body.max_tokens) > 1000, JSON.stringify(calls.map(c => c.body.max_tokens)));

  // 2 · PRIMARY LADDER: m2.7 errors → m2.5 (the secondary) carries the SAME request. Both are primaries,
  //     both on OpenRouter — the free deep-fallback is NOT burned for a primary hiccup.
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    const body = JSON.parse(String(init?.body || '{}'));
    if (/minimax-m2\.7/.test(String(body.model))) return new Response('bad gateway', { status: 502 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'dal secondario 2.5' } }] }), { status: 200 });
  };
  const r = await callLLM('sys', 'user', 100);
  ok('ladder: m2.7 hiccup → m2.5 secondary answers (favorite→secondary, no free rung burned)',
    r.meta.ok === true && r.meta.provider === 'openrouter' && r.text === 'dal secondario 2.5' && calls.length === 2 && /minimax-m2\.7/.test(String(calls[0].body.model)) && /minimax-m2\.5/.test(String(calls[1].body.model)), calls.map(c => c.body.model).join(' | '));

  // 2b · both MiniMax primaries down → the ladder falls through to the cheap/free deep-fallback rung
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    const body = JSON.parse(String(init?.body || '{}'));
    if (/minimax-m2/.test(String(body.model))) return new Response('{"error":{"message":"upstream 500"}}', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'dal gradino economico' } }] }), { status: 200 });
  };
  const rl = await callLLM('sys', 'user', 100);
  ok('ladder: both MiniMax primaries down → cheap/free deep-fallback rung answers',
    rl.meta.ok === true && rl.text === 'dal gradino economico' && calls.length >= 3 && /minimax-m2\.7/.test(String(calls[0].body.model)) && /minimax-m2\.5/.test(String(calls[1].body.model)), JSON.stringify({ n: calls.length, models: calls.map(c => c.body.model) }));

  // 3 · DEEP FAILOVER: the ENTIRE OpenRouter ladder is down → the slow direct MiniMax API carries it.
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    if (String(url).includes('openrouter')) return new Response('bad gateway', { status: 502 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '<think>x</think>dal diretto' } }] }), { status: 200 });
  };
  const r2 = await callLLM('sys', 'user', 100);
  ok('deep failover: whole OpenRouter ladder down → minimax-direct answers (never a hard fail)',
    r2.meta.ok === true && r2.meta.provider === 'minimax-direct' && r2.text === 'dal diretto' && calls[calls.length - 1].url.includes('minimax'), JSON.stringify({ meta: r2.meta, n: calls.length }));

  // 4 · WEB-grounded calls go OR-FIRST with the Exa plugin (unchanged), on the m2.7 primary.
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'grounded' } }] }), { status: 200 });
  };
  const rw = await callLLM('sys', 'user', 100, { web: true });
  ok('web calls ride OpenRouter first with the Exa plugin', rw.meta.provider === 'openrouter' && calls.length === 1 && calls[0].url.includes('openrouter') && JSON.stringify(calls[0].body.plugins || '').includes('web'), JSON.stringify(calls[0]?.body?.plugins));

  // 5 · everything dead: honest failure after the FULL OpenRouter ladder AND the direct failover.
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    return new Response('{"error":{"message":"upstream down"}}', { status: 502 });
  };
  const r3 = await callLLM('sys', 'user', 100);
  ok('all providers dead: honest error after the full OR ladder + the direct failover',
    r3.meta.ok === false && /all providers failed/.test(String(r3.meta.error)) && calls.length >= 3, JSON.stringify({ n: calls.length, err: String(r3.meta.error).slice(0, 80) }));
} finally {
  (globalThis as any).fetch = realFetch;
}

// ---- the runner parks on quota instead of failing (source pins) ----
import { readFileSync } from 'node:fs';
const runner = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8');
ok('runner: quota-stall branch exists BEFORE the transient branch', runner.indexOf('quota_stall') > 0 && runner.indexOf('quota_stall') < runner.indexOf('isTransient(e?.message)'));
ok('runner: stalled tasks refund the attempt (a days-long condition never burns the defect budget)', /isQuotaExhausted[\s\S]{0,900}attempts=greatest\(attempts-1,0\)/.test(runner));
ok('runner: the operator is alerted ONCE per project, not per retry', /stalls === 0[\s\S]{0,200}telegramAlert/.test(runner));
ok('runner: a repark CEILING makes an eternal stall eventually FAIL (never loops forever)', runner.includes('RELAY_MAX_QUOTA_REPARKS') && /reparks < Number/.test(runner) && runner.includes('quota stall exceeded'));

// ---- reasoning policy (owner 2026-07-06: M3 reasoning OFF for speed; the 2.x models force minimal) ----
const agentsSrc = readFileSync(new URL('./agents.ts', import.meta.url), 'utf8');
ok('reasoning: M3/o-series DISABLE reasoning (enabled:false) when LLM_REASONING=off',
  /canDisable\s*=\s*\/minimax-m3\|o\[13\]-\/i/.test(agentsSrc) && agentsSrc.includes('{ enabled: false }'));
ok('reasoning: MiniMax 2.x fall back to effort:minimal (reasoning is mandatory for them)', agentsSrc.includes("{ effort: 'minimal' }"));
ok('reasoning: THINK_HEADROOM only when reasoning actually runs (none when fully off)',
  /needHeadroom = isReasoner && !\(reasoning && reasoning\.enabled === false\)/.test(agentsSrc));

// ---- T14 source-pin: brand log is truthful — only warns when the FINAL locked brand is absent ----
const specSrc = readFileSync(new URL('./spec.ts', import.meta.url), 'utf8');
ok('T14 brand-log: noBrandWarn flag exists in SpecCtx type', /noBrandWarn\?\s*:\s*boolean/.test(specSrc));
ok('T14 brand-log: normalizeSpec suppresses repair when noBrandWarn=true', /!ctx\.noBrandWarn/.test(specSrc) && specSrc.includes('brand.name missing'));
ok('T14 brand-log: normalizeSite passes noBrandWarn:true to normalizeSpec (compose path)',
  /normalizeSpec\(\s*\{[^}]*composed\.sections[^}]*\}[^)]*noBrandWarn\s*:\s*true/.test(specSrc.replace(/\s+/g, ' ')));

// ---- T15 source-pin: per-department cheap tier is env-driven + does not change default behavior ----
ok('T15 tiering: OPENROUTER_MODELS_CHEAP env var is consumed', agentsSrc.includes('OPENROUTER_MODELS_CHEAP'));
ok('T15 tiering: CHEAP_DEPTS set contains policies, design, qa (the short-output departments)',
  /CHEAP_DEPTS\s*=\s*new Set\([^)]*policies[^)]*\)/.test(agentsSrc));
ok('T15 tiering: callLLM accepts a models override parameter', /callLLM[^)]*opts.*models\?\s*:\s*string\[\]/.test(agentsSrc.replace(/\s+/g, ' ')));
ok('T15 tiering: default (env unset) = OR_CHEAP_MODELS is empty = unchanged behavior',
  agentsSrc.includes("OR_CHEAP_MODELS_RAW = process.env.OPENROUTER_MODELS_CHEAP || ''") && agentsSrc.includes("OR_CHEAP_MODELS = OR_CHEAP_MODELS_RAW.split"));
ok('T15 tiering: runAgentTracked routes cheap depts to cheap models when env is set',
  /cheapModels.*CHEAP_DEPTS\.has\(department\)/.test(agentsSrc.replace(/\s+/g, ' ')));

// ---- T15 behavioral: cheap-tier routing actually uses the override models list ----
const realFetch2 = globalThis.fetch;
try {
  let calls15: { url: string; body: any }[] = [];
  process.env.OPENROUTER_MODELS_CHEAP = 'mistralai/mistral-small-24b-instruct-2501';
  // re-import agents.ts with the new env var — we inline the test here using callLLM's models param
  (globalThis as any).fetch = async (url: any, init: any) => {
    calls15.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'cheap answer' } }] }), { status: 200 });
  };
  // direct callLLM with models override: must call the cheap model, not the primary ladder
  const { callLLM: callLLMFresh } = await import('./agents.ts');
  calls15 = [];
  const rCheap = await callLLMFresh('sys', 'user', 100, { models: ['mistralai/mistral-small-24b-instruct-2501'] });
  ok('T15 behavioral: callLLM with models override calls the cheap model (not the primary ladder)',
    rCheap.meta.ok === true && calls15.length === 1 && /mistral-small/.test(String(calls15[0].body.model)), JSON.stringify({ model: calls15[0]?.body?.model }));
} finally {
  globalThis.fetch = realFetch2;
  delete process.env.OPENROUTER_MODELS_CHEAP;
}

// ---- T16 source-pin: build_seconds persisted on project completion ----
const runnerSrc = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8');
ok('T16 latency: persistBuildMetrics helper exported from runner.ts',
  /export\s+async\s+function\s+persistBuildMetrics/.test(runnerSrc));
ok('T16 latency: build_seconds written to params (jsonb_set)',
  /jsonb_set.*build_seconds.*to_jsonb/.test(runnerSrc.replace(/\s+/g, ' ')));
ok('T16 latency: buildStart timestamp captured at runLoop entry',
  /buildStart\s*=\s*Date\.now\(\)/.test(runnerSrc));
ok('T16 latency: persistBuildMetrics called on clean project completion (done path)',
  /if \(done\)\s+await persistBuildMetrics\(pool, projectId/.test(runnerSrc.replace(/\s+/g, ' ')));
ok('T16 latency: persistBuildMetrics is idempotent (conditional on build_seconds not yet set)',
  /build_seconds.*is null/.test(runnerSrc));

console.log(`\nllm:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

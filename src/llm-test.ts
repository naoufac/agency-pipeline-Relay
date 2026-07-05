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

// ---- provider ORDER (owner 2026-07-05): MiniMax-direct PRIMARY, OpenRouter free-model fallback,
// ---- web-grounded calls OR-first. Stubbed fetch — no network, no tokens. ----
const realFetch = globalThis.fetch;
try {
  let calls: { url: string; body: any }[] = [];
  const record = (url: any, init: any) => calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
  // 1 · normal call: MiniMax answers → OR never touched
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: '<think>pondering</think>dal primario' } }] }), { status: 200 });
  };
  const r0 = await callLLM('sys', 'user', 100);
  ok('PRIMARY is MiniMax-direct (12.5B tokens/month) — one call, think stripped', r0.meta.ok === true && r0.meta.provider === 'minimax-direct' && r0.text === 'dal primario' && calls.length === 1 && calls[0].url.includes('minimax'), JSON.stringify(r0.meta));

  // 2 · MiniMax quota-dead → the SAME request rides the FREE OpenRouter model
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    if (String(url).includes('minimax')) return new Response('{"type":"error","error":{"type":"server_error","message":"your current token plan not enough"}}', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'dal fallback gratuito' } }] }), { status: 200 });
  };
  const r = await callLLM('sys', 'user', 100);
  ok('failover: MiniMax quota-dead → OpenRouter FREE model carries the request', r.meta.ok === true && r.meta.provider === 'openrouter' && /:free$|flash|llama/i.test(String(r.meta.model)) && r.text === 'dal fallback gratuito', JSON.stringify(r.meta));
  ok('failover order: minimax first, openrouter second, fallback model in the wire body', calls.length === 2 && calls[0].url.includes('minimax') && calls[1].url.includes('openrouter') && /:free$|flash|llama/i.test(String(calls[1].body.model)), calls.map(c => c.url).join(' | '));

  // 3 · transient MiniMax 500 (no billing words) does NOT fail over — upstream retries handle it
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    if (String(url).includes('minimax')) return new Response('bad gateway', { status: 502 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'never' } }] }), { status: 200 });
  };
  const r2 = await callLLM('sys', 'user', 100);
  ok('no failover on transient: a 502 fails the call (retry upstream), fallback NOT burned', r2.meta.ok === false && calls.length === 1, JSON.stringify({ meta: r2.meta, n: calls.length }));

  // 4 · WEB-grounded calls go OR-FIRST (the Exa plugin is OR-only)
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'grounded' } }] }), { status: 200 });
  };
  const rw = await callLLM('sys', 'user', 100, { web: true });
  ok('web calls ride OpenRouter first with the Exa plugin', rw.meta.provider === 'openrouter' && calls.length === 1 && calls[0].url.includes('openrouter') && JSON.stringify(calls[0].body.plugins || '').includes('web'), JSON.stringify(calls[0]?.body?.plugins));

  // 5 · both providers dead: honest compound error
  calls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    record(url, init);
    if (String(url).includes('minimax')) return new Response('{"error":{"message":"your current token plan not enough"}}', { status: 500 });
    return new Response('{"error":{"message":"Key limit exceeded (weekly limit)","code":403}}', { status: 403 });
  };
  const r3 = await callLLM('sys', 'user', 100);
  ok('both providers dead: honest compound error, ok:false', r3.meta.ok === false && String(r3.meta.error).includes('failover after') && calls.length === 2, String(r3.meta.error));
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

console.log(`\nllm:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

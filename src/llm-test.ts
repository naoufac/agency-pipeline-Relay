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

const { callLLM, isQuotaExhausted } = await import('./agents.ts');

// ---- the classifier: quota-class vs transient — the whole design hinges on this line ----
ok('quota: the exact 2026-07-04 message classifies as exhausted',
  isQuotaExhausted('OpenRouter 403: {"error":{"message":"Key limit exceeded (weekly limit). Manage it using https://...","code":403}}'));
ok('quota: spent credits classify as exhausted', isQuotaExhausted('MiniMax 402: insufficient balance') && isQuotaExhausted('OpenRouter 402: Payment Required — add credits'));
ok('quota: a plain 5xx is NOT quota (it retries as transient)', !isQuotaExhausted('OpenRouter 500: bad gateway') && !isQuotaExhausted('OpenRouter 502: upstream error'));
ok('quota: timeouts are NOT quota', !isQuotaExhausted('The operation was aborted due to timeout') && !isQuotaExhausted('fetch failed'));
ok('quota: a 429 rate limit without account words is NOT quota (transient handles bursts)', !isQuotaExhausted('OpenRouter 429: slow down'));
ok('quota: MiniMax bills via 500 — "token plan" classifies as exhausted (observed live)', isQuotaExhausted('MiniMax 500: {"type":"error","error":{"type":"server_error","message":"your current token plan not enough"}}'));

// ---- failover: same request, second provider, real answer ----
const realFetch = globalThis.fetch;
try {
  let calls: string[] = [];
  const orDead = async (url: any) => {
    calls.push(String(url));
    if (String(url).includes('openrouter')) return new Response('{"error":{"message":"Key limit exceeded (weekly limit)","code":403}}', { status: 403 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ciao dal fallback' } }] }), { status: 200 });
  };
  (globalThis as any).fetch = orDead;
  const r = await callLLM('sys', 'user', 100);
  ok('failover: OpenRouter quota-dead → the SAME request rides MiniMax-direct', r.meta.ok === true && r.meta.provider === 'minimax-direct' && r.text === 'ciao dal fallback', JSON.stringify(r.meta));
  ok('failover: exactly two calls — primary once, fallback once', calls.length === 2 && calls[0].includes('openrouter') && calls[1].includes('minimax'), calls.join(' | '));

  calls = [];
  (globalThis as any).fetch = async (url: any) => {
    calls.push(String(url));
    if (String(url).includes('openrouter')) return new Response('upstream exploded', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'never' } }] }), { status: 200 });
  };
  const r2 = await callLLM('sys', 'user', 100);
  ok('no failover on transient: a 500 fails the call (retry upstream), fallback NOT burned', r2.meta.ok === false && calls.length === 1, JSON.stringify({ meta: r2.meta, calls }));

  calls = [];
  (globalThis as any).fetch = async (url: any) => {
    calls.push(String(url));
    if (String(url).includes('openrouter')) return new Response('{"error":{"message":"Key limit exceeded (weekly limit)","code":403}}', { status: 403 });
    return new Response('{"error":"insufficient balance"}', { status: 402 });
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
ok('runner: stalled tasks refund the attempt (a days-long condition never burns the defect budget)', /isQuotaExhausted[\s\S]{0,400}attempts=greatest\(attempts-1,0\)/.test(runner));
ok('runner: the operator is alerted ONCE per project, not per retry', /stalls === 0[\s\S]{0,200}telegramAlert/.test(runner));

console.log(`\nllm:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

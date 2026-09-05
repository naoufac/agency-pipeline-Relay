import { proveApp } from './cms/app.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveBuilder } from './cms/registry.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

{
  const b = resolveBuilder('app');
  ok('resolveBuilder(app) is the real app builder', b.id === 'app' && typeof b.finalize === 'function');
  const src = readFileSync(fileURLToPath(new URL('./cms/app.ts', import.meta.url)), 'utf8');
  ok('app builder is not a stub', !src.includes('Worker C') && src.includes('proveApp'));
  ok('app builder does not import render.ts', !src.includes('../render.ts') && !src.includes("from '../render"));
  ok('app builder proves UI calls /api/app', src.includes('/api/app') && src.includes('handleAppApi'));
}

{
  const runner = readFileSync(fileURLToPath(new URL('./runner.ts', import.meta.url)), 'utf8');
  ok('fullstack_app is not SITEISH (no site review / CMS costume)',
    /const SITEISH = \[[^\]]+\]/.test(runner) && !/SITEISH = \[[^\]]*fullstack_app/.test(runner));
}

{
  const prev = process.env.RELAY_APP_API;
  delete process.env.RELAY_APP_API;
  const r = await proveApp({ query: async () => ({ rows: [] }) }, '00000000-0000-0000-0000-000000000000');
  ok('flag off fails closed', r.ok === false && /RELAY_APP_API unset/.test(r.log), r.log);
  if (prev === undefined) delete process.env.RELAY_APP_API; else process.env.RELAY_APP_API = prev;
}

console.log(`\napp-builder:check — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

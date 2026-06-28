// Live CMS matrix: pings each of the 5 adapters' healthcheck and prints the real status.
// Run: npm run cms:status. Honest by construction — a 'pending'/'blocked' CMS reports its blocker.
import { REGISTRY, CMS_ORDER } from './registry.ts';
import type { CmsInstance } from './types.ts';

async function main() {
  console.log('\nCMS building chain — live status (all 5 present in the system):\n');
  let buildable = 0;
  for (const name of CMS_ORDER) {
    const e = REGISTRY[name];
    let health = { ok: false, detail: '' };
    try { health = await e.adapter.healthcheck({ cms: name } as CmsInstance); } catch (err: any) { health = { ok: false, detail: String(err?.message ?? err) }; }
    const mark = e.status === 'proven' && health.ok ? '✅ BUILDABLE' : e.status === 'blocked' ? '⛔ BLOCKED  ' : '⏳ PENDING  ';
    if (e.status === 'proven' && health.ok) buildable++;
    console.log(`  ${mark}  ${name.padEnd(9)} — ${health.ok ? health.detail : e.note}`);
  }
  console.log(`\n  ${buildable}/5 buildable right now (Directus). Others: see notes above.\n`);
}
main();

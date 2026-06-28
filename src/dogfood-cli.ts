// npm run dogfood -- <projectId> [baseUrl]   — drive a real browser through a produced site.
import { makePool } from './db.ts';
import { dogfood } from './dogfood.ts';
import { closeBrowser } from './browser.ts';

const id = process.argv[2];
if (!id) { console.error('usage: npm run dogfood -- <projectId> [baseUrl]'); process.exit(2); }
const baseUrl = process.argv[3] || process.env.BASE_URL || 'http://localhost:8787';
const pool = makePool();
(async () => {
  const { issues, checked } = await dogfood(pool, id, baseUrl);
  console.log(`dogfood ${id}\nchecked: ${checked.pages} pages × 2 viewports · ${checked.buttons} buttons · ${checked.forms} form(s) · ${checked.collections} collection(s)`);
  if (!issues.length) console.log('✓ no interaction issues — every button goes somewhere, the form submits + persists, header aligned, collections show live data');
  else { console.log(`\n✗ ${issues.length} issue(s):`); for (const i of issues) console.log(`  [${i.severity}] ${i.page}/${i.viewport} · ${i.kind}: ${i.detail}`); }
  await closeBrowser();
  await pool.end();
  process.exit(issues.some(i => i.severity === 'high') ? 1 : 0);
})().catch(e => { console.error('dogfood error:', e?.message ?? e); process.exit(2); });

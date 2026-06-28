// END-TO-END PROOF: a real site built ON the live Directus, verified by the served_from_cms gate.
// Run: npm run prove:directus  (exit 0 = the page is genuinely served from the CMS, sentinel proven).
// This is NOT a render unit test — it stands up content in a real running Directus, renders FROM a
// CMS read, and proves a CMS write surfaces in the served HTML.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { directus } from './directus.ts';
import { servedFromCms } from './gate.ts';
import type { SiteModel, BuildCtx } from './types.ts';

const model: SiteModel = {
  brand: { name: 'Lumen Studio', tokens: { bg: '#0f172a', primary: '#22d3ee' } },
  pages: [
    { slug: 'index', title: 'Home', sections: [
      { type: 'hero', eyebrow: 'Design studio', headline: 'We build calm, useful software', lead: 'A small team shipping considered products.' },
      { type: 'features', title: 'What we do', items: [ { title: 'Product', body: 'End to end.' }, { title: 'Brand', body: 'Identity that lasts.' }, { title: 'Build', body: 'We ship.' } ] },
      { type: 'cta', headline: 'Start a project', body: 'Tell us what you need.', cta: 'Get in touch', link: 'contact.html' },
    ] },
    { slug: 'about', title: 'About', sections: [
      { type: 'hero', eyebrow: 'About', headline: 'Made by people who care', lead: 'Since 2019.' },
      { type: 'features', title: 'Principles', items: [ { title: 'Honest', body: 'No fluff.' }, { title: 'Calm', body: 'No noise.' } ] },
    ] },
  ],
};

async function main() {
  const projectId = 'cmsproof-' + Math.random().toString(16).slice(2, 10);
  const sitesDir = mkdtempSync(path.join(os.tmpdir(), 'relay-cms-'));
  const ctx: BuildCtx = { projectId, brief: 'a small design studio', archetype: 'site', theme: 'modern', sitesDir };
  const step = (m: string) => console.log('  •', m);
  console.log(`\nPROVE Directus — project ${projectId}\n  sitesDir ${sitesDir}`);
  try {
    const inst = await directus.provision(ctx); step('provisioned ' + inst.baseUrl);
    const h = await directus.healthcheck(inst); if (!h.ok) throw new Error('healthcheck: ' + h.detail); step('health: ' + h.detail);
    const m = await directus.modelContentTypes(inst, model, ctx); step('modeled: ' + m.types.join(','));
    const pushed = await directus.pushContent(inst, model, ctx); step('pushed: ' + JSON.stringify(pushed.ids));
    const built = await directus.buildAndServe(inst, model, ctx); step('served: ' + Object.keys(built.pages).join(','));
    const gate = await servedFromCms(directus, inst, model, ctx);
    await directus.teardown(inst, { purge: true }); step('torn down (purged test rows)');
    if (gate.ok) { console.log('\n✅ PASS — ' + gate.log + '\n'); process.exit(0); }
    console.log('\n❌ FAIL — ' + gate.log + '\n'); process.exit(1);
  } catch (e: any) { console.error('\n❌ PROVE ERROR:', e?.message ?? e, '\n'); process.exit(1); }
}
main();

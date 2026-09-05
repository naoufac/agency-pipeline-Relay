import { proveCampaign, proveCampaignPack } from './cms/campaign.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveBuilder } from './cms/registry.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

{
  const b = resolveBuilder('campaign');
  ok('resolveBuilder(campaign) is the real campaign builder', b.id === 'campaign' && typeof b.finalize === 'function');
  const src = readFileSync(fileURLToPath(new URL('./cms/campaign.ts', import.meta.url)), 'utf8');
  ok('campaign builder is not a stub', !src.includes('not yet implemented') && src.includes('proveCampaign'));
  ok('campaign builder does not import render.ts', !src.includes('../render.ts') && !src.includes("from '../render"));
}

{
  const good = JSON.stringify({
    email: { subject: 'Saturday class is open', body: 'Book a wheel this weekend. Clay and firing included.' },
    social: [{ channel: 'instagram', copy: 'Throw a bowl Saturday. Six wheels. Naples.' }],
  });
  const r = proveCampaignPack(good);
  ok('valid pack dry-runs', r.ok === true, r.log);
  ok('counts emails + social', r.emails === 1 && r.social === 1, JSON.stringify(r));
}

ok('website payload is rejected', proveCampaignPack(JSON.stringify({
  email: { subject: 'Hi', body: 'x' },
  social: [{ copy: 'y' }],
  hero: 'Welcome',
  pages: [{ slug: 'index' }],
})).ok === false);

ok('missing email fails', proveCampaignPack(JSON.stringify({
  social: [{ copy: 'hello' }],
})).ok === false);

ok('prose is not a pack', proveCampaignPack('A lovely newsletter about clay.').ok === false);

{
  const prev = process.env.RELAY_APP_API;
  const r = await proveCampaign({ query: async () => ({ rows: [] }) }, '00000000-0000-0000-0000-000000000000');
  ok('empty content fails closed', r.ok === false && /not a JSON object|missing/.test(r.log), r.log);
  if (prev !== undefined) process.env.RELAY_APP_API = prev;
}

{
  const runner = readFileSync(fileURLToPath(new URL('./runner.ts', import.meta.url)), 'utf8');
  ok('campaign is finalized (not a silent stub)', runner.includes("[...SITEISH, 'fullstack_app', 'campaign']"));
  ok('campaign is not SITEISH', !/SITEISH = \[[^\]]*campaign/.test(runner));
}

console.log(`\ncampaign:check — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

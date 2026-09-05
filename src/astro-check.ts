import { compileAstroSite } from './cms/astro.ts';
import { navDefect, pageLogo, pagePalette, pageNav } from './verify.ts';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'relay-astro-'));
try {
  const model = {
    brief: 'Create an Astro CMS website for a local therapist. Book at https://hair.as.me/schedule',
    brand: { name: 'Calm Room', tokens: { primary: '#1351FB', bg: '#f9fcff', text: '#11201A' } },
    pages: [
      { slug: 'index', title: 'Home', sections: [
        { type: 'hero', headline: 'Therapy that lets you breathe', lead: 'Sessions in the room, not on a call centre script.', cta: 'Book a session', link: 'https://hair.as.me/schedule' },
        { type: 'features', title: 'How we work', items: [
          { title: 'One hour', body: 'A real hour. No stacking.' },
          { title: 'In person', body: 'The room is the work.' },
        ]},
      ]},
      { slug: 'about', title: 'About', sections: [
        { type: 'split', title: 'About Calm Room', body: 'A practice that does not sell a funnel.' },
      ]},
    ],
  };
  const r = compileAstroSite(model, dir);
  ok('compile ok', r.ok === true, r.log);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  ok('astro marker present', html.includes('<!--relay:astro-->'));
  ok('NOT the Directus renderer', !html.includes('<!--relay:rendered-->'));
  ok('real .astro source written', r.files.some((f) => f.endsWith('index.astro')));
  ok('layout.astro written', r.files.some((f) => f.includes('Layout.astro')));
  ok('booking CTA is the research URL', html.includes('https://hair.as.me/schedule'));
  ok('navDefect clean', navDefect(html) === null, String(navDefect(html)));
  ok('one logo text', pageLogo(html) === 'Calm Room', pageLogo(html));
  ok('palette locked', pagePalette(html) === '#1351FB/#f9fcff', pagePalette(html));
  ok('nav shared shape', pageNav(html).includes('Home') && pageNav(html).includes('About'), pageNav(html));
  ok('about.html exists', readdirSync(dir).includes('about.html'));
  const about = readFileSync(join(dir, 'about.html'), 'utf8');
  ok('same brand on about', about.includes('Calm Room') && about.includes('<!--relay:astro-->'));
  ok('same palette on about', pagePalette(about) === pagePalette(html));
  ok('same nav on about', pageNav(about) === pageNav(html));

  const bad = compileAstroSite({ pages: [] }, dir);
  ok('empty model fails', bad.ok === false);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nastro:check — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

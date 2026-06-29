// CLI: Relay generates a real, isolated, branded WordPress site — or safely adds a page to one.
//   npm run cms:wp-gen "<brief>"
//   npm run cms:wp-gen add <slug> "<what page to add>"
import { generateWordpressSite, addWordpressPage } from './wordpress.ts';

const a = process.argv.slice(2);
if (a[0] === 'add') {
  const slug = a[1]; const req = a.slice(2).join(' ');
  if (!slug || !req) { console.error('usage: cms:wp-gen add <slug> "<request>"'); process.exit(2); }
  console.log(`\nSafe edit: adding a page to "${slug}" — branding/nav untouched...\n`);
  addWordpressPage(slug, req).then((r) => { console.log('✅ page added (inherits theme + nav):', r.url, '\n'); process.exit(0); })
    .catch((e) => { console.error('FAIL:', e?.message ?? e); process.exit(1); });
} else {
  const brief = a.join(' ').trim();
  if (!brief) { console.error('usage: cms:wp-gen "<brief>"'); process.exit(2); }
  console.log(`\nRelay → WordPress: generating a real branded site for:\n  "${brief}"\n`);
  generateWordpressSite(brief).then((s) => {
    console.log('✅ REAL branded WordPress site:\n');
    console.log('  brand: ' + s.siteName);
    console.log('  LIVE:  ' + s.url);
    console.log('  ADMIN: ' + s.adminUrl + '  (your own WP admin for this site)');
    console.log('  slug:  ' + s.slug + '   (edit safely: npm run cms:wp-gen add ' + s.slug + ' "add a careers page")\n');
    process.exit(0);
  }).catch((e) => { console.error('FAIL:', e?.message ?? e); process.exit(1); });
}

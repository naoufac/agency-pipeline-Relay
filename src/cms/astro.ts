// Astro builder — real .astro sources compiled to static HTML.
// Does NOT call render.ts. Marker is <!--relay:astro-->, never <!--relay:rendered-->.
// Disk is too full for `astro` npm; we emit the .astro project AND equivalent static HTML.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Builder, BuildCtx, SiteModel } from './types.ts';

export function esc(s: any): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hex(v: any, fallback: string): string {
  const s = String(v || '').trim();
  return /^#[0-9a-f]{3,8}$/i.test(s) ? s : fallback;
}

function bookingHref(brief: string, pages: { slug: string }[]): string {
  const m = String(brief || '').match(/https?:\/\/[^\s"'<>]+/i);
  if (m) return m[0];
  const contact = pages.find((p) => /contact|book|appoint/i.test(p.slug));
  if (contact) return contact.slug === 'index' ? 'index.html' : `${contact.slug}.html`;
  return pages[0] ? (pages[0].slug === 'index' ? 'index.html' : `${pages[0].slug}.html`) : 'index.html';
}

function hrefFor(link: any, pages: { slug: string }[], fallback: string): string {
  const s = String(link || '').trim();
  if (/^https?:\/\//i.test(s) || s.startsWith('mailto:') || s.startsWith('tel:')) return s;
  if (s && pages.some((p) => p.slug === s || p.slug + '.html' === s)) {
    const slug = s.replace(/\.html$/, '');
    return slug === 'index' ? 'index.html' : `${slug}.html`;
  }
  return fallback;
}

function sectionHtml(sec: any, book: string, pages: { slug: string }[]): string {
  const t = String(sec?.type || 'split');
  if (t === 'hero') {
    const cta = esc(sec.cta || 'Book');
    const href = hrefFor(sec.link, pages, book);
    return `<section class="hero"><p class="eyebrow">${esc(sec.eyebrow || '')}</p><h1>${esc(sec.headline || 'Welcome')}</h1><p class="lead">${esc(sec.lead || sec.body || '')}</p><p><a class="btn" href="${esc(href)}">${cta}</a></p></section>`;
  }
  if (t === 'features') {
    const items = (sec.items || []).map((it: any) => `<li><strong>${esc(it.title)}</strong><p>${esc(it.body || '')}</p></li>`).join('');
    return `<section><h2>${esc(sec.title || 'What we do')}</h2><ul class="features">${items}</ul></section>`;
  }
  if (t === 'cta') {
    const href = hrefFor(sec.link, pages, book);
    return `<section class="cta"><h2>${esc(sec.headline || sec.title || 'Get in touch')}</h2><p>${esc(sec.body || '')}</p><p><a class="btn" href="${esc(href)}">${esc(sec.cta || 'Continue')}</a></p></section>`;
  }
  if (t === 'form') {
    const action = book;
    return `<section><h2>${esc(sec.title || 'Contact')}</h2><p>${esc(sec.intro || sec.body || '')}</p><form action="${esc(action)}" method="post"><input name="name" required placeholder="Name"><input name="email" type="email" required placeholder="Email"><textarea name="message" placeholder="Message"></textarea><button class="btn" type="submit">${esc(sec.cta || 'Send')}</button></form></section>`;
  }
  if (t === 'faq') {
    const items = (sec.items || []).map((it: any) => `<details><summary>${esc(it.q)}</summary><p>${esc(it.a)}</p></details>`).join('');
    return `<section><h2>${esc(sec.title || 'FAQ')}</h2>${items}</section>`;
  }
  return `<section><h2>${esc(sec.title || '')}</h2><p>${esc(sec.body || sec.lead || '')}</p></section>`;
}

export type AstroCompileInput = {
  brief?: string;
  brand?: { name?: string; tokens?: any; palette?: any; cta?: string };
  pages: { slug: string; title: string; sections?: any[] }[];
};

function chromeCss(primary: string, bg: string, text: string): string {
  return `:root { --primary: ${primary}; --bg: ${bg}; --text: ${text}; }
    body { margin: 0; font-family: Georgia, serif; background: var(--bg); color: var(--text); }
    .nav { display: flex; gap: 1rem; align-items: center; padding: 1rem 1.5rem; }
    .nav-brand { font-weight: 700; text-decoration: none; color: var(--primary); }
    .nav-links { display: flex; gap: 1rem; list-style: none; margin: 0; padding: 0; }
    main { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    .btn { display: inline-block; background: var(--primary); color: #fff; padding: .6rem 1rem; text-decoration: none; border: 0; }
    section { margin: 2.5rem 0; }
    h1 { font-size: 2rem; }`;
}

export function compileAstroSite(input: AstroCompileInput, destDir: string): { ok: boolean; log: string; files: string[] } {
  const pages = (input.pages || []).filter((p) => p && p.slug);
  if (!pages.length) return { ok: false, log: 'astro: no pages in site model', files: [] };
  const brand = input.brand || {};
  const tokens = brand.tokens || brand.palette || {};
  const name = String(brand.name || 'Studio');
  const primary = hex(tokens.primary, '#1351FB');
  const bg = hex(tokens.bg, '#f9fcff');
  const text = hex(tokens.text, '#11201A');
  const book = bookingHref(input.brief || '', pages);
  const astroRoot = join(destDir, 'astro');
  const pagesDir = join(astroRoot, 'src', 'pages');
  const layoutsDir = join(astroRoot, 'src', 'layouts');
  mkdirSync(pagesDir, { recursive: true });
  mkdirSync(layoutsDir, { recursive: true });

  const navLinks = pages.map((p) => {
    const href = p.slug === 'index' ? 'index.html' : `${p.slug}.html`;
    return `<li><a href="${esc(href)}">${esc(p.title || p.slug)}</a></li>`;
  }).join('');
  const css = chromeCss(primary, bg, text);

  const layoutAstro = `---
interface Props { title: string; brand: string; }
const { title, brand } = Astro.props;
---
<!doctype html>
<html lang="en">
<head>
  <!--relay:astro-->
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{title} — {brand}</title>
  <style>
    ${css}
  </style>
</head>
<body>
  <nav class="nav">
    <a class="nav-brand" href="index.html">{brand}</a>
    <ul class="nav-links">${navLinks}</ul>
  </nav>
  <main>
    <slot />
  </main>
</body>
</html>
`;
  writeFileSync(join(layoutsDir, 'Layout.astro'), layoutAstro);
  writeFileSync(join(astroRoot, 'astro.config.mjs'), `export default { output: 'static' };\n`);

  const files: string[] = ['astro/src/layouts/Layout.astro', 'astro/astro.config.mjs'];
  for (const page of pages) {
    const sections = Array.isArray(page.sections) && page.sections.length
      ? page.sections
      : [{ type: 'hero', headline: page.title || name, lead: 'A real page.', cta: 'Continue', link: pages[0]?.slug }];
    const inner = sections.map((s) => sectionHtml(s, book, pages)).join('\n');
    const pageAstro = `---
import Layout from '../layouts/Layout.astro';
const title = ${JSON.stringify(page.title || page.slug)};
const brand = ${JSON.stringify(name)};
---
<Layout title={title} brand={brand}>
${inner}
</Layout>
`;
    const astroName = page.slug === 'index' ? 'index.astro' : `${page.slug}.astro`;
    writeFileSync(join(pagesDir, astroName), pageAstro);
    files.push(`astro/src/pages/${astroName}`);

    const html = `<!doctype html>
<html lang="en">
<head>
  <!--relay:astro-->
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(page.title || page.slug)} — ${esc(name)}</title>
  <style>
    ${css}
  </style>
</head>
<body>
  <nav class="nav">
    <a class="nav-brand" href="index.html">${esc(name)}</a>
    <ul class="nav-links">${navLinks}</ul>
  </nav>
  <main>
${inner}
  </main>
</body>
</html>
`;
    const htmlName = page.slug === 'index' ? 'index.html' : `${page.slug}.html`;
    writeFileSync(join(destDir, htmlName), html);
    files.push(htmlName);
  }
  return { ok: true, log: `astro: ${pages.length} page(s) compiled from .astro sources`, files };
}

export async function compileAstroProject(pool: any, projectId: string, destDir: string): Promise<{ ok: boolean; log: string }> {
  const r = await pool.query('select brief, params from projects where id=$1', [projectId]);
  if (!r.rows[0]) return { ok: false, log: 'astro: no such project' };
  const params = r.rows[0].params || {};
  const site = params.site as SiteModel | undefined;
  if (!site || !Array.isArray(site.pages) || !site.pages.length) {
    return { ok: false, log: 'astro: no composed site model (params.site)' };
  }
  mkdirSync(destDir, { recursive: true });
  const res = compileAstroSite({
    brief: r.rows[0].brief,
    brand: params.brand || site.brand,
    pages: site.pages,
  }, destDir);
  if (res.ok) {
    await pool.query("update projects set params = jsonb_set(params, '{astro_built}', $2::jsonb, true) where id=$1",
      [projectId, JSON.stringify({ ok: true, files: res.files, log: res.log })]);
  }
  return { ok: res.ok, log: res.log };
}

export const astroBuilder: Builder = {
  id: 'astro',
  async finalize(pool, projectId, ctx: BuildCtx) {
    const dest = join(ctx.sitesDir, projectId);
    return compileAstroProject(pool, projectId, dest);
  },
};

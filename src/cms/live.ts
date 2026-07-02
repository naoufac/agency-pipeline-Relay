// LIVE CMS serving — render a CMS-backed page FRESH from the CMS on every request, through the same
// deterministic renderPage. This is what makes a produced site a real CMS site: edit the content in
// the CMS and the live page changes on the next load, with NO rebuild. Returns null for non-CMS
// projects (the caller then serves the static file as before).
import pg from 'pg';
import { renderPage } from '../render.ts';
import { processMedia } from '../media.ts';
import { brandFor } from './util.ts';
import { SITES } from '../verify.ts';

const env = () => ({ url: process.env.DIRECTUS_URL || 'http://127.0.0.1:8055', token: process.env.DIRECTUS_TOKEN || '' });

export async function renderLiveFromCms(pool: pg.Pool, projectId: string, slug: string): Promise<string | null> {
  const pr = (await pool.query('select params from projects where id=$1', [projectId])).rows[0];
  if (!pr) return null;
  const params = pr.params || {};
  if (!params.cms_built || !params.site || !Array.isArray(params.site.pages) || !params.site.pages.length) return null;

  const { url, token } = env();
  const q = `${url}/items/pages?filter[project_id][_eq]=${encodeURIComponent(projectId)}&filter[slug][_eq]=${encodeURIComponent(slug)}&fields=id,title,slug,sections&limit=1`;
  let row: any;
  try {
    const res = await fetch(q, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    row = (await res.json())?.data?.[0];
  } catch { return null; }
  if (!row || !Array.isArray(row.sections)) return null;

  const navPages = params.site.pages.map((p: any) => ({ slug: p.slug, title: p.title }));
  const spec = { brand: params.brand || params.site.brand || brandFor(params.site), sections: row.sections };
  // M2: pass the schema snapshot — without it a typed form silently degrades to the contact fallback
  const sf = params.schema_forms || {};
  let html = renderPage(spec, { pages: navPages, slug, title: row.title, projectId, theme: params.theme || 'modern', layout: params.layout, forms: sf.forms, primaryTable: sf.primaryTable });
  try { html = await processMedia(html, new URL(projectId + '/', SITES)); } catch { /* image-light or no key */ }
  return `<!--relay:cms=directus LIVE doc=${row.id} (rendered from CMS on request)-->\n` + html;
}

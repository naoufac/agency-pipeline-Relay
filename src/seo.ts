// SEO — deterministic, compiled from the locked spec. The LLM never writes tags.
import { esc } from './components.ts';

// meta description: the hero's lead, else the first section body/intro — plain text, <=160 chars
export function metaDescription(spec: any): string {
  const secs: any[] = (spec && Array.isArray(spec.sections)) ? spec.sections : [];
  const hero = secs.find((s) => s && s.type === 'hero');
  const raw = String(hero?.lead || hero?.headline || secs.map((s) => s?.intro || s?.body || '').find(Boolean) || '').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 160);
}

const BASE = () => String(process.env.RELAY_PUBLIC_BASE || '').replace(/\/$/, '');

// with a locked slug the site's canonical home is its OWN subdomain; else the /sites/ path
const siteBase = (projectId: string, slug?: string) => slug ? `https://${slug}.naples.agency` : `${BASE()}/sites/${projectId}`;

// sitemapXml: write a sitemap with <lastmod> for every URL.
// INVARIANT: buildDate must be injected by the caller (runner.ts) at the build boundary so the
// pure builder stays testable and deterministic — no clock reads inside the render/SEO code paths.
// buildDate is an ISO-8601 string (e.g. "2026-07-06T00:00:00.000Z"); only the date portion is
// emitted (sitemaps spec allows date-only lastmod). Absent/invalid buildDate → lastmod omitted.
export function sitemapXml(projectId: string, pages: { slug: string }[], siteSlug?: string, buildDate?: string): string {
  const base = siteBase(projectId, siteSlug);
  // validate: only a real ISO date string reaches the output; anything else is silently dropped
  const lastmod = buildDate && /^\d{4}-\d{2}-\d{2}/.test(buildDate) ? buildDate.slice(0, 10) : null;
  const urls = [...pages.map((p) => `${p.slug}.html`), 'how-it-was-built.html']
    .map((f) => `  <url><loc>${esc(`${base}/${f}`)}</loc>${lastmod ? `<lastmod>${esc(lastmod)}</lastmod>` : ''}</url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(projectId: string, siteSlug?: string): string {
  return `User-agent: *\nAllow: /\nSitemap: ${siteBase(projectId, siteSlug)}/sitemap.xml\n`;
}

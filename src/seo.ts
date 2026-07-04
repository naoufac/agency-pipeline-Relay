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

export function sitemapXml(projectId: string, pages: { slug: string }[]): string {
  const base = BASE();
  const urls = [...pages.map((p) => `${p.slug}.html`), 'how-it-was-built.html']
    .map((f) => `  <url><loc>${esc(`${base}/sites/${projectId}/${f}`)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(projectId: string): string {
  return `User-agent: *\nAllow: /\nSitemap: ${BASE()}/sites/${projectId}/sitemap.xml\n`;
}

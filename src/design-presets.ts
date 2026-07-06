// design-presets.ts — curated, professional design identities an owner applies in ONE click. Most
// owners don't have a Figma export; presets give everyone the "a real design, not the default theme"
// outcome. Each is a Design (the same object the Figma/token path produces), so it flows through the
// SAME validated, contrast-guaranteed renderer + web-font loader. Fonts are real Google Fonts.
// Palettes are hand-tuned for legibility — design:check asserts every one clears WCAG.
import type { Design } from './design.ts';

export const DESIGN_PRESETS: Record<string, Design & { label: string }> = {
  midnight: {
    label: 'Midnight', source: 'preset',
    palette: { bg: '#0e1117', primary: '#79a8ff', accent: '#c4a7ff', text: '#eef1f6', surface: '#171c26' },
    fonts: { display: 'Space Grotesk', body: 'Inter' }, radius: '10px',
  },
  editorial: {
    label: 'Editorial', source: 'preset',
    palette: { bg: '#faf6ef', primary: '#a2432a', accent: '#7a6a35', text: '#2a2420', surface: '#f1e9dc' },
    fonts: { display: 'Fraunces', body: 'Inter' }, radius: '3px',
  },
  saas: {
    label: 'Clean SaaS', source: 'preset',
    palette: { bg: '#ffffff', primary: '#4f46e5', accent: '#0284c7', text: '#0f172a', surface: '#f1f5f9' },
    fonts: { display: 'Inter', body: 'Inter' }, radius: '12px',
  },
  bold: {
    label: 'Bold Studio', source: 'preset',
    palette: { bg: '#101010', primary: '#ff5c33', accent: '#ffd23f', text: '#f5f5f5', surface: '#1b1b1b' },
    fonts: { display: 'Archivo', body: 'Inter' }, radius: '2px',
  },
  wellness: {
    label: 'Calm Wellness', source: 'preset',
    palette: { bg: '#f5f8f4', primary: '#356b53', accent: '#9c6a50', text: '#253029', surface: '#e8efe6' },
    fonts: { display: 'Cormorant Garamond', body: 'Inter' }, radius: '16px',
  },
  mono: {
    label: 'Mono Minimal', source: 'preset',
    palette: { bg: '#ffffff', primary: '#141414', accent: '#6b6b6b', text: '#141414', surface: '#f4f4f4' },
    fonts: { display: 'Space Mono', body: 'Inter' }, radius: '0px',
  },
};

export const isPreset = (id: any): id is keyof typeof DESIGN_PRESETS => typeof id === 'string' && Object.prototype.hasOwnProperty.call(DESIGN_PRESETS, id);

// compact list for the Design tab: id/label/swatches/font for the chip, plus the full Design so the
// dashboard can render a true in-app preview (no cross-origin iframe to the live site).
export function presetSummaries(): Array<{ id: string; label: string; swatches: string[]; font: string; design: Design }> {
  return Object.entries(DESIGN_PRESETS).map(([id, d]) => {
    const { label: _l, ...design } = d;
    return {
      id, label: d.label,
      swatches: [d.palette?.bg, d.palette?.primary, d.palette?.accent, d.palette?.text].filter(Boolean) as string[],
      font: d.fonts?.display || '', design,
    };
  });
}

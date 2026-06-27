// A working agent is JUST AN API CALL: context in -> text/artifact out.
// Live provider: MiniMax (OpenAI-compatible /chat/completions). If MINIMAX_API_KEY is
// unset, falls back to deterministic STUBS so the engine still runs end-to-end offline.
//   MINIMAX_API_KEY   – required for live calls
//   MINIMAX_BASE_URL  – default https://api.minimax.io/v1   (or https://api.minimaxi.com/v1)
//   MINIMAX_MODEL     – default MiniMax-M2  (set to whatever your key supports, e.g. MiniMax-Text-01)

const KEY = process.env.MINIMAX_API_KEY;
const BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1';
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-Text-01'; // clean output; M2 emits <think> tags

import { themeFor, themeTone } from './themes.ts';

export type Ctx = { brief: string; upstream: { seq: number; department: string; content: string }[]; feedback?: string; pages?: { slug: string; title: string }[]; self?: { title: string; slug: string }; theme?: string };

// One-line role per department — the only thing that differs between agents.
const ROLE: Record<string, string> = {
  research:    'You are the Research department of an automated creative agency. From the brief, output concise market & positioning research. Plain text.',
  branding:    'You are the Branding department. Output ONLY a JSON object of design tokens: {"palette":{"primary":"#hex","accent":"#hex","bg":"#hex","text":"#hex"},"type":{"display":"Font","body":"Font"},"radius":"12px"}. CRITICAL: text vs bg MUST meet WCAG AA contrast (>=4.5:1) — dark text on a light bg or vice-versa. JSON only, no prose.',
  stack:       'You are the Stack department. Decide the tech stack and state it in one short paragraph.',
  database:    'You are the Database department. Output ONLY runnable PostgreSQL for this app: a CREATE TABLE block for the core entities, THEN 3-6 INSERT statements seeding realistic example rows into the main public-facing table (e.g. products/menu/listings) so the site has real data to display. Use BARE table names (no schema prefix), no DROP/ALTER, no prose, no markdown fences.',
  design:      'You are the Design-system department. Using the brand tokens above, list the components and how the tokens map.',
  media:       'You are the Art Direction department. Describe the visual/imagery direction (mood, hero imagery, iconography) for this website. Concrete and on-brief.',
  content:     'You are the Content department. Output ONLY ONE valid JSON object (a single object — never two blocks). For sitemap/IA: {"sections":[{"id":"hero","title":"..."}, ...]}. For copy: {"hero":{"headline":"...","body":"..."}, ...}. Invent realistic, specific names and details that fit the brief (a real-sounding business name, real-sounding people/places); NEVER output bracketed placeholders like [Studio Name] or lorem ipsum. Exactly one JSON object, no prose, no markdown, no second block.',
  copywriting: 'You are the Copywriting department. Output ONLY valid JSON mapping section ids to final on-brand copy: {"hero":{"headline":"...","subhead":"...","cta":"..."},"about":{"body":"..."}, ...} with real copy for this brief. Invent realistic, specific names/details; NEVER use bracketed placeholders like [Studio Name] or lorem ipsum. JSON only.',
  strategy:    'You are the Strategy department. Give a concrete, brief-specific plan: positioning, the sections the site needs and why, and the single key message. Plain text, specific.',
  auth:        'You are the Auth department. Specify the accounts/authentication model.',
  build:       'You are the Build department composing ONE page of a multi-page site (named in "YOU ARE BUILDING THIS PAGE"). You do NOT write HTML or CSS — a deterministic renderer turns your spec into a perfect, responsive, accessible page (nav, fonts, spacing, contrast are guaranteed by the system). Output ONLY a JSON object, no prose/markdown/fences:\n' +
               '{"brand":{"name":"<brand name>","cta":"<short nav button, e.g. Get started>","tokens":{"primary":"#hex","bg":"#hex","accent":"#hex","font_display":"Grotesk|Fraunces|Inter","font_body":"Inter|Grotesk"}},"sections":[ ... 3 to 6 sections ... ]}\n' +
               'Section types (use a mix that fits THIS page; every page MUST open with a hero):\n' +
               '- {"type":"hero","image":"2-4 word stock-photo search","eyebrow":"short kicker","headline":"...","lead":"1-2 sentence subhead","cta":"button label"}\n' +
               '- {"type":"features","title":"...","intro":"one line","items":[{"title":"...","body":"..."}]}  (3-4 items)\n' +
               '- {"type":"split","image":"2-4 word photo search","eyebrow":"...","title":"...","body":"a paragraph","cta":"label","reverse":false}\n' +
               '- {"type":"gallery","title":"...","images":["2-4 word photo search", "..."]}  (4-6 queries)\n' +
               '- {"type":"cta","headline":"...","body":"one line","cta":"label"}\n' +
               '- {"type":"form","title":"...","intro":"one line","cta":"Send","fields":[{"name":"name","label":"Full name"},{"name":"email","label":"Email","type":"email"},{"name":"message","label":"Message","type":"textarea"}],"form":"contact"}  (a REAL form whose submissions are stored in the database — put one on a contact / get-in-touch / sign-up / stockists page. "form" names the table bucket, default "contact".)\n' +
               '- {"type":"feed","title":"...","intro":"one line","form":"listing","empty":"Nothing here yet."}  (a LIVE list of the site\'s own PUBLIC submissions to the form with the SAME "form" name — for a directory / listings / reviews / community wall. Pair it with a {"type":"form","form":"listing"} so visitors add an entry and SEE it appear. Use for app/store/directory briefs. NEVER point a feed at a private "contact" form.)\n' +
               '- {"type":"collection","title":"...","intro":"one line","table":"items","empty":"Nothing here yet."}  (a LIVE list rendered from the project\'s REAL database table named "table" — products, menu, listings, fleet. Use for app/store pages; the database department must CREATE and SEED that exact table. Reads the live DB.)\n' +
               'Rules: use the EXACT brand + copy from upstream; write real, specific copy (NEVER [placeholders] or lorem ipsum); image fields are 2-4 word stock-photo SEARCH TERMS (not URLs); pick bg + primary with strong contrast for each other (the renderer guarantees readable text either way). The system owns fonts, spacing, shape and layout (chosen from the brief) — you only supply copy, section order and 2 brand colours. JSON ONLY.',
  integration: 'You are the Integration department. List the integrations to wire and the deploy steps.',
  qa:          'You are QA. The built site is verified by an automated render check, not by you. Briefly note any obvious gaps you would flag.',
};

function buildUser(ctx: Ctx): string {
  let s = '';
  if (ctx.feedback) s += `IMPORTANT — your previous attempt FAILED an automated check: ${ctx.feedback}\nProduce a corrected version that passes this check.\n\n`;
  s += `BRIEF: ${ctx.brief}\n`;
  if (ctx.upstream.length) {
    s += `\nUPSTREAM RESULTS (the departments you depend on):\n`;
    for (const u of ctx.upstream) s += `\n[#${u.seq} ${u.department}]\n${u.content}\n`;
  }
  if (ctx.self && ctx.pages && ctx.pages.length) {
    s += `\nYOU ARE BUILDING THIS PAGE: "${ctx.self.title}" — output the full HTML for ${ctx.self.slug}.html.\n`;
    s += `Shared top nav must link ALL pages (highlight the current one):\n`;
    s += ctx.pages.map(p => `  ${p.title} -> ${p.slug}.html`).join('\n') + '\n';
    s += `Use those exact relative hrefs (home is index.html). Build ONLY this one page.\n`;
    const th = themeFor(ctx.theme, ctx.brief);
    s += `\nDesign language: ${th}. Match the copy TONE to it — ${themeTone(th)}. (The system renders all visual design; you write copy + choose sections + 2 colours.)\n`;
  }
  return s;
}

async function callMiniMax(system: string, user: string, maxTokens = 1500): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.7,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`MiniMax ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new Error('MiniMax: empty response ' + JSON.stringify(data).slice(0, 200));
  return String(text);
}

// generic MiniMax text call (used by the planner); '' when no key so callers fall back
export async function llm(system: string, user: string, maxTokens = 2000): Promise<string> {
  return KEY ? callMiniMax(system, user, maxTokens) : '';
}

export async function runAgent(department: string, ctx: Ctx): Promise<string> {
  if (KEY) {
    const system = ROLE[department] || `You are the ${department} department of an automated agency. Do your part for the brief.`;
    return await callMiniMax(system, buildUser(ctx), department === 'build' ? 8000 : 1500);
  }
  return stub(department, ctx.brief);
}

// ---- offline deterministic fallback (no key) ----
const DB_SQL = `create table users (
  id serial primary key,
  phone text unique not null,
  password_hash text not null
);
create table items (
  id serial primary key,
  name text not null,
  price numeric not null
);
create table orders (
  id serial primary key,
  user_id int references users(id),
  total numeric not null,
  status text not null default 'placed'
);
insert into items (name, price) values
  ('Margherita', 9.50), ('Pepperoni', 12.00), ('Garden Salad', 7.25), ('Tiramisu', 6.00);`;

function stub(department: string, brief: string): string {
  switch (department) {
    case 'research':    return `Research for: ${brief}\n\nMarket: dense urban demand for fast, reliable service; customers skew 18-40, mobile-first, and value live tracking plus flexible payment (card, wallet, and cash on delivery are all common in this region). The category is crowded but fragmented, so trust, speed and transparent pricing are the real wedges. Positioning: the fastest honest option in the city — clear fees, genuine human support, and progress you can actually see. Key risks are supply-side reliability and first-order trust; mitigate with referral incentives, visible ETAs, and a no-quibble first-order guarantee.`;
    case 'branding':    return JSON.stringify({ palette: { primary: '#0B6E4F', accent: '#E9C46A', bg: '#FFFFFF', text: '#11201A' }, type: { display: 'Inter', body: 'Inter' }, radius: '12px' });
    case 'stack':       return `Stack decision: Supabase (Postgres) backend + Next.js PWA.`;
    case 'database':    return DB_SQL;
    case 'design':      return `Design system: brand tokens applied; 12 base components.`;
    case 'media':       return `Media: 20 product images sourced + brand assets.`;
    case 'content':     return JSON.stringify({ sections: [{ id: 'hero', title: 'Hero' }, { id: 'about', title: 'About' }, { id: 'contact', title: 'Contact' }] });
    case 'copywriting': return JSON.stringify({ hero: { headline: 'Welcome', subhead: 'Built by Relay', cta: 'Get started' }, about: { body: 'About us.' }, contact: { body: 'Reach us.' } });
    case 'auth':        return `Auth: phone + password, OTP, sessions.`;
    case 'frontend':    return `Screens built: browse, cart, checkout, track. (applies brand tokens)`;
    // The engine renders a SPEC (not HTML): return a valid brand + sections spec so the deterministic
    // renderer (and the theme system) run fully offline. Real copy, no placeholders, contrasting colours.
    case 'build':       return JSON.stringify({
      brand: { name: 'Swift Lane', cta: 'Order now', tokens: { bg: '#0b0e14', primary: '#7c7aff', accent: '#36b37e' } },
      sections: [
        { type: 'hero', eyebrow: 'City-wide delivery', headline: 'Anything you need, at your door in under an hour', lead: 'Swift Lane connects you to the shops and kitchens nearby and brings your order over while it is still warm.', cta: 'Order now' },
        { type: 'features', title: 'Why Swift Lane', intro: 'Built for speed and trust.', items: [
          { title: 'Live tracking', body: 'Watch your courier move on the map from pickup to your door.' },
          { title: 'Pay your way', body: 'Card, wallet, or cash on delivery — whatever suits you.' },
          { title: 'Real support', body: 'A person, not a bot, the moment something needs sorting.' }] },
        { type: 'split', eyebrow: 'For merchants', title: 'Grow without building your own fleet', body: 'List your menu, accept orders, and let our couriers handle the last mile. You keep your customers; we keep them moving.', cta: 'Partner with us' },
        { type: 'form', title: 'Get early access', intro: 'Tell us your neighbourhood and we will let you know the day we launch near you.', cta: 'Request access' },
      ],
    });
    case 'integration': return `Integration: payments + maps wired; deploy config ready.`;
    case 'qa':          return `QA: no blocking gaps noted.`;
    default:            return `[${department}] completed for: ${brief}`;
  }
}

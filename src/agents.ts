// A working agent is JUST AN API CALL: context in -> text/artifact out.
// Live provider: MiniMax (OpenAI-compatible /chat/completions). If MINIMAX_API_KEY is
// unset, falls back to deterministic STUBS so the engine still runs end-to-end offline.
//   MINIMAX_API_KEY   – required for live calls
//   MINIMAX_BASE_URL  – default https://api.minimax.io/v1   (or https://api.minimaxi.com/v1)
//   MINIMAX_MODEL     – default MiniMax-M2  (set to whatever your key supports, e.g. MiniMax-Text-01)

const KEY = process.env.MINIMAX_API_KEY;
const BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1';
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-Text-01'; // clean output; M2 emits <think> tags

export type Ctx = { brief: string; upstream: { seq: number; department: string; content: string }[]; feedback?: string; pages?: { slug: string; title: string }[]; self?: { title: string; slug: string } };

// One-line role per department — the only thing that differs between agents.
const ROLE: Record<string, string> = {
  research:    'You are the Research department of an automated creative agency. From the brief, output concise market & positioning research. Plain text.',
  branding:    'You are the Branding department. Output ONLY a JSON object of design tokens: {"palette":{"primary":"#hex","accent":"#hex","bg":"#hex","text":"#hex"},"type":{"display":"Font","body":"Font"},"radius":"12px"}. CRITICAL: text vs bg MUST meet WCAG AA contrast (>=4.5:1) — dark text on a light bg or vice-versa. JSON only, no prose.',
  stack:       'You are the Stack department. Decide the tech stack and state it in one short paragraph.',
  database:    'You are the Database department. Output ONLY a runnable PostgreSQL CREATE TABLE block for this app — no prose, no markdown fences.',
  design:      'You are the Design-system department. Using the brand tokens above, list the components and how the tokens map.',
  media:       'You are the Art Direction department. Describe the visual/imagery direction (mood, hero imagery, iconography) for this website. Concrete and on-brief.',
  content:     'You are the Content department. Output ONLY ONE valid JSON object (a single object — never two blocks). For sitemap/IA: {"sections":[{"id":"hero","title":"..."}, ...]}. For copy: {"hero":{"headline":"...","body":"..."}, ...}. Invent realistic, specific names and details that fit the brief (a real-sounding business name, real-sounding people/places); NEVER output bracketed placeholders like [Studio Name] or lorem ipsum. Exactly one JSON object, no prose, no markdown, no second block.',
  copywriting: 'You are the Copywriting department. Output ONLY valid JSON mapping section ids to final on-brand copy: {"hero":{"headline":"...","subhead":"...","cta":"..."},"about":{"body":"..."}, ...} with real copy for this brief. Invent realistic, specific names/details; NEVER use bracketed placeholders like [Studio Name] or lorem ipsum. JSON only.',
  strategy:    'You are the Strategy department. Give a concrete, brief-specific plan: positioning, the sections the site needs and why, and the single key message. Plain text, specific.',
  auth:        'You are the Auth department. Specify the accounts/authentication model.',
  build:       'You are the Build department building ONE page of a multi-page site (named in "YOU ARE BUILDING THIS PAGE"). You receive brand tokens (JSON palette hex) and copy (JSON). Output a COMPLETE self-contained HTML document for THIS page only (<!doctype html> ... </html>), with a shared STICKY top nav linking all listed pages via relative <slug>.html (current page highlighted). ' +
               'STYLE WITH TAILWIND UTILITY CLASSES ONLY — do NOT write a <style> block or custom CSS (the build system compiles Tailwind for you). Apply the brand palette as Tailwind arbitrary values, e.g. bg-[#0B6E4F] text-[#11201A] border-[#e5e7eb]. ' +
               'Design to a HIGH 2024 bar, not basic: glass sticky nav (backdrop-blur bg-white/70 border-b); a bold hero with class="font-display" headings at text-5xl md:text-7xl tracking-tight and a gradient accent (bg-gradient-to-r from-[#a] to-[#b] bg-clip-text text-transparent); generous rhythm (sections py-24 md:py-32, max-w-6xl mx-auto px-6); cards rounded-2xl ring-1 ring-black/5 shadow-sm hover:shadow-md transition; a real multi-column footer. Headings use class="font-display" (or class="font-serif-display" for an editorial/luxury brief). ' +
               'PHOTOGRAPHY: where a real photo elevates the page (a hero image/side visual, feature or gallery sections, team/testimonial avatars), use <img src="" data-q="2-4 word stock-photo search" alt="..." class="..."> — the build system swaps each for a REAL licensed photo served locally. Give precise, on-brief queries (e.g. data-q="modern coffee shop interior", data-q="smiling professional portrait"). Aim for 2-5 photos. Size them with Tailwind (object-cover, rounded-2xl, aspect-video / h-full). NEVER hardcode an external image URL (they 404), and NEVER add <script src=...> or the Tailwind CDN (cdn.tailwindcss.com) — Tailwind is compiled & inlined for you, so the page must be 100% self-contained (no external scripts, styles, or fonts). Use CSS gradients/shapes/inline SVG for abstract or brand visuals. Use the EXACT copy provided, but REPLACE any bracketed placeholder (e.g. [Studio Name], [Class Name]) with a realistic specific value — never ship brackets or lorem ipsum. Output ONLY raw HTML — no markdown, no fences, no commentary.',
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
);`;

function stub(department: string, brief: string): string {
  switch (department) {
    case 'research':    return `Research for: ${brief}\nPremium urban market; cash-on-delivery common; FR/AR conventions.`;
    case 'branding':    return JSON.stringify({ palette: { primary: '#0B6E4F', accent: '#E9C46A', bg: '#FFFFFF', text: '#11201A' }, type: { display: 'Inter', body: 'Inter' }, radius: '12px' });
    case 'stack':       return `Stack decision: Supabase (Postgres) backend + Next.js PWA.`;
    case 'database':    return DB_SQL;
    case 'design':      return `Design system: brand tokens applied; 12 base components.`;
    case 'media':       return `Media: 20 product images sourced + brand assets.`;
    case 'content':     return JSON.stringify({ sections: [{ id: 'hero', title: 'Hero' }, { id: 'about', title: 'About' }, { id: 'contact', title: 'Contact' }] });
    case 'copywriting': return JSON.stringify({ hero: { headline: 'Welcome', subhead: 'Built by Relay', cta: 'Get started' }, about: { body: 'About us.' }, contact: { body: 'Reach us.' } });
    case 'auth':        return `Auth: phone + password, OTP, sessions.`;
    case 'frontend':    return `Screens built: browse, cart, checkout, track. (applies brand tokens)`;
    case 'build':       return `<!doctype html><html><head><meta charset="utf-8"><title>${brief}</title>
<style>body{margin:0;font-family:system-ui;background:#0B0E14;color:#EAEDF5}
.hero{min-height:100vh;display:grid;place-items:center;text-align:center;padding:2rem}
h1{font-size:clamp(2rem,6vw,4rem);background:linear-gradient(90deg,#7C7AFF,#36B37E);-webkit-background-clip:text;color:transparent}</style></head>
<body><div class="hero"><div><h1>${brief}</h1><p>Generated offline by Relay (stub). Set MINIMAX_API_KEY for the real build.</p></div></div></body></html>`;
    case 'integration': return `Integration: payments + maps wired; deploy config ready.`;
    case 'qa':          return `QA: no blocking gaps noted.`;
    default:            return `[${department}] completed for: ${brief}`;
  }
}

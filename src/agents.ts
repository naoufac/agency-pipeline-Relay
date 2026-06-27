// A working agent is JUST AN API CALL: context in -> text/artifact out.
// Live provider: MiniMax (OpenAI-compatible /chat/completions). If MINIMAX_API_KEY is
// unset, falls back to deterministic STUBS so the engine still runs end-to-end offline.
//   MINIMAX_API_KEY   – required for live calls
//   MINIMAX_BASE_URL  – default https://api.minimax.io/v1   (or https://api.minimaxi.com/v1)
//   MINIMAX_MODEL     – default MiniMax-M2  (set to whatever your key supports, e.g. MiniMax-Text-01)

const KEY = process.env.MINIMAX_API_KEY;
const BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1';
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-Text-01'; // clean output; M2 emits <think> tags

export type Ctx = { brief: string; upstream: { seq: number; department: string; content: string }[] };

// One-line role per department — the only thing that differs between agents.
const ROLE: Record<string, string> = {
  research:    'You are the Research department of an automated creative agency. From the brief, output concise market & positioning research. Plain text.',
  branding:    'You are the Branding department. Output brand tokens — palette as hex codes, typography, radius — plus a one-line guide. You MUST include hex colours like #0B6E4F.',
  stack:       'You are the Stack department. Decide the tech stack and state it in one short paragraph.',
  database:    'You are the Database department. Output ONLY a runnable PostgreSQL CREATE TABLE block for this app — no prose, no markdown fences.',
  design:      'You are the Design-system department. Using the brand tokens above, list the components and how the tokens map.',
  media:       'You are the Art Direction department. Describe the visual/imagery direction (mood, hero imagery, iconography) for this website. Concrete and on-brief.',
  content:     'You are the Content department. If asked for sitemap/IA, list the page sections in order. If asked for copy, write the actual final copy for each section in the brand tone. Real copy, not placeholders.',
  auth:        'You are the Auth department. Specify the accounts/authentication model.',
  build:       'You are the Build department. Using the brand tokens, sitemap, copy and art direction above, output a COMPLETE, polished, self-contained single-file website as ONE HTML document. Start with <!doctype html>. Inline ALL CSS in a <style> tag and any JS in a <script> tag — no external files, no build step, no frameworks. Apply the brand palette and typography EXACTLY. Use the real copy provided. Make it genuinely well-designed and responsive. Output ONLY the raw HTML — no markdown, no code fences, no commentary before or after.',
  integration: 'You are the Integration department. List the integrations to wire and the deploy steps.',
  qa:          'You are QA. The built site is verified by an automated render check, not by you. Briefly note any obvious gaps you would flag.',
};

function buildUser(ctx: Ctx): string {
  let s = `BRIEF: ${ctx.brief}\n`;
  if (ctx.upstream.length) {
    s += `\nUPSTREAM RESULTS (the departments you depend on):\n`;
    for (const u of ctx.upstream) s += `\n[#${u.seq} ${u.department}]\n${u.content}\n`;
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
    case 'branding':    return `Brand tokens\nprimary=#0B6E4F  secondary=#E9C46A\ntypography=Inter  radius=12px`;
    case 'stack':       return `Stack decision: Supabase (Postgres) backend + Next.js PWA.`;
    case 'database':    return DB_SQL;
    case 'design':      return `Design system: brand tokens applied; 12 base components.`;
    case 'media':       return `Media: 20 product images sourced + brand assets.`;
    case 'content':     return `Copy: premium, locally-proud microcopy set.`;
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

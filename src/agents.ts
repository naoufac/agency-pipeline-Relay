// A working agent is JUST AN API CALL: context in -> text/artifact out.
// Live provider (preferred): OpenRouter (OpenAI-compatible) pinned to a MiniMax REASONING model, with
// OpenRouter's server-side WEB SEARCH plugin turned on for the research/strategy/planning calls — so
// those agents are grounded in REAL, cited facts within a SINGLE call (the one-call-per-agent rule is
// preserved; OpenRouter runs the search and folds results into the same completion). MiniMax's
// chain-of-thought returns in a SEPARATE `reasoning` field, so `content` stays clean — no <think> leak.
// Downstream JSON agents (content/copy/build/database) inherit the grounded facts via the DAG, so they
// stay strict-JSON and we pay for search only on the research phase.
// Fallbacks: MiniMax-direct (no web), then deterministic STUBS (no key) so the engine runs offline.
//   OPENROUTER_API_KEY   – preferred. OPENROUTER_MODEL (default minimax/minimax-m2.7, MiniMax-only).
//   OPENROUTER_BASE_URL  – default https://openrouter.ai/api/v1 ;  WEB_MAX_RESULTS (default 5).
//   MINIMAX_API_KEY / MINIMAX_BASE_URL / MINIMAX_MODEL – legacy direct fallback.

const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OR_MODEL = process.env.OPENROUTER_MODEL || 'minimax/minimax-m2.7'; // used for WEB-grounded calls (Exa plugin is OR-only)
// the FALLBACK LADDER when MiniMax-direct is quota-dead: free first, then a really-cheap paid
// model — free tiers are congested/flaky by nature (probed live 2026-07-05), so the ladder ends
// on a reliable $0.08/M rung. Owner's directive: 'as fallback use free models / really cheap one'.
const OR_FALLBACK_MODELS = (process.env.OPENROUTER_FALLBACK_MODELS || 'google/gemma-4-31b-it:free,mistralai/mistral-small-24b-instruct-2501')
  .split(',').map((m) => m.trim()).filter(Boolean);
const KEY = process.env.MINIMAX_API_KEY;
const BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1';
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-Text-01';
const LIVE = !!(OR_KEY || KEY);   // any live provider configured?
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90000);  // hard per-request cap — a hung/slow call can't stall a build forever
// departments whose output is improved by REAL-WORLD facts -> enable web search (grounding). Everything
// else inherits those facts through upstream context, so search cost is ~2 calls/project.
const WEB_DEPTS = new Set(['research', 'strategy']);

import { themeFor, themeTone } from './themes.ts';

export type Ctx = { brief: string; upstream: { seq: number; department: string; content: string }[]; feedback?: string; pages?: { slug: string; title: string }[]; self?: { title: string; slug: string }; theme?: string; layout?: any; shape?: string; archetype?: string; tables?: string[]; forms?: Record<string, any[]>; primaryTable?: string; brand?: { name: string; cta: string | null; tokens: any }; site?: any };

// One-line role per department — the only thing that differs between agents.
const ROLE: Record<string, string> = {
  policies:    'You are the Operations department. From the brief, decide the REAL business rules for this specific business and output ONLY a JSON object (no prose): {"min_notice_hours":<int 0-336, how many hours ahead a visitor must book>,"cancellation_hours":<int 0-336>,"capacity_per_slot":<int 1-500, simultaneous bookings per time slot>,"max_party_size":<int 1-500>}. Ground every number in the business type (a barber: notice 1-2h, capacity 1; a restaurant: notice 2-4h, capacity = tables, party up to 10; a store: notice 0). JSON only.',
  research:    'You are the Research department of an automated creative agency. From the brief, output concise market & positioning research. Plain text.',
  branding:    'You are the Branding department. Invent ONE real, specific brand/business name for this brief, then a palette. Output ONLY a JSON object: {"name":"<the brand name>","palette":{"primary":"#hex","accent":"#hex","bg":"#hex","text":"#hex"},"type":{"display":"Font","body":"Font"},"radius":"12px"}. The "name" is the site\'s SINGLE identity — it becomes the logo and must be the only business name used across every page. CRITICAL: text vs bg MUST meet WCAG AA contrast (>=4.5:1) — dark text on a light bg or vice-versa. JSON only, no prose.',
  stack:       'You are the Stack department. Decide the tech stack and state it in one short paragraph.',
  database:    'You are the Database department. ORDER matters — the core ACTION entity (what a visitor DOES: bookings/orders/deliveries/listings) comes FIRST with all its fields; catalog entities next; identity tables (users/clients) LAST; seeds ≤6 rows each; COMPACT one-line JSON. DESIGN the app\'s data model and output ONLY a JSON object (no prose, no SQL, no fences): {"entities":[{"name":"products","public":true,"display":"name","fields":[{"name":"title","type":"text","required":true},{"name":"price","type":"money","required":true},{"name":"category","type":"ref:categories"},{"name":"in_stock","type":"bool","default":true},{"name":"description","type":"longtext"}],"seed":[{"title":"...","price":12.5,"category":1,"in_stock":true,"description":"..."}]}]}. ' +
               'Field types: text, longtext, int, money, bool, date, datetime, email, url, slug, image, json. Relations: "type":"ref:<entity>". Rules: model the REAL entities for this brief (3-6 tables, proper relations); mark the main public-facing entity "public":true with "display" set to its title field and SEED it with 4-8 realistic rows; ALSO seed 3+ realistic rows into EVERY table referenced by a required "ref:" field (an empty referenced table makes the booking/order form impossible to submit — its dropdown would have no options); required/unique where it matters. The system COMPILES this into a correct, indexed Postgres schema (serial PKs, FK constraints + indexes, created_at) — you only describe the model. JSON only.' +
               ' STORE CONTRACT (when the brief is a shop/e-commerce): you MUST include EXACTLY these three entities so the built-in cart/checkout can write real orders — "products" (public:true, display:"title" or "name", a "price" money field, seeded 4-8 rows), "orders" (customer_name text required, email text, phone text, notes longtext, status text, total money), "order_items" (order ref:orders required, product ref:products required, qty int required, unit_price money). Name them exactly products / orders / order_items.' +
               ' STRICT OUTPUT (a malformed model fails the build): emit EXACTLY ONE JSON object — self-check that every { has a matching } and there is NO second block, no fences, no prose before/after, no trailing commas. The "entities" key MUST be present and a NON-EMPTY array. Every integer value (seed PKs, counts, amounts) MUST fit PostgreSQL INT4 (max 2,147,483,647): use small seed PKs (1-100) and, for a genuinely huge real-world number (a bounty, a population, a market cap), scale it down or put it in a "text" field — NEVER emit an integer over 2.1 billion.',
  design:      'You are the Design-system department. Using the brand tokens above, list the components and how the tokens map.',
  media:       'You are the Art Direction department. Describe the visual/imagery direction (mood, hero imagery, iconography) for this website. Concrete and on-brief.',
  content:     'You are the Content department. Your task is EITHER information architecture OR page copy — NEVER both at once. Emit EXACTLY ONE JSON object for the SINGLE shape your task asks for. IA/sitemap shape: {"sections":[{"id":"hero","title":"..."}, ...]}. Copy shape: {"hero":{"headline":"...","body":"..."}, ...}. Do NOT combine the two shapes and do NOT output a second JSON object. Invent realistic, specific names and details that fit the brief (a real-sounding business name, real-sounding people/places); NEVER output bracketed placeholders like [Studio Name] or lorem ipsum. Self-check before answering: count your { and } — they MUST match, and your output MUST be EXACTLY one top-level JSON object — no second block, no prose or markdown before or after.',
  copywriting: 'You are the Copywriting department. Output ONLY valid JSON mapping section ids to final on-brand copy: {"hero":{"headline":"...","subhead":"...","cta":"..."},"about":{"body":"..."}, ...} with real copy for this brief. Invent realistic, specific names/details; NEVER use bracketed placeholders like [Studio Name] or lorem ipsum. JSON only.',
  strategy:    'You are the Strategy department. Give a concrete, brief-specific plan: positioning, the sections the site needs and why, and the single key message. Plain text, specific.',
  auth:        'You are the Auth department. Specify the accounts/authentication model.',
  build:       '⚠️ OUTPUT FORMAT: ONE parseable JSON object. NO HTML tags, NO CSS, NO markdown fences, NO prose before/after. Your output starts with { and ends with }. Self-check before submitting.\n\nYou are the Build department composing ONE page of a multi-page site (named in "YOU ARE BUILDING THIS PAGE"). The renderer turns your JSON spec into a perfect, responsive, accessible page (nav, fonts, spacing, contrast are guaranteed). Do NOT write HTML or CSS — write ONLY the JSON spec below:\n' +
               '{"brand":{"name":"<brand name>","cta":"<short nav button, e.g. Get started>","tokens":{"primary":"#hex","bg":"#hex","accent":"#hex","font_display":"Grotesk|Fraunces|Inter","font_body":"Inter|Grotesk"}},"sections":[ ... 3 to 6 sections ... ]}\n' +
               'Section types (use a mix that fits THIS page; every page MUST open with a hero):\n' +
               '- {"type":"hero","image":"2-4 word stock-photo search","eyebrow":"short kicker","headline":"...","lead":"1-2 sentence subhead","cta":"button label"}\n' +
               '- {"type":"features","title":"...","intro":"one line","items":[{"title":"...","body":"..."}]}  (3-4 items)\n' +
               '- {"type":"split","image":"2-4 word photo search","eyebrow":"...","title":"...","body":"a paragraph","cta":"label","reverse":false}\n' +
               '- {"type":"gallery","title":"...","images":["2-4 word photo search", "..."]}  (4-6 queries)\n' +
               '- {"type":"cta","headline":"...","body":"one line","cta":"label"}\n' +
               '- {"type":"stats","title":"...","items":[{"value":"480+","label":"projects shipped"},{"value":"98%","label":"would refer us"}]}  (3-4 big-number stats)\n' +
               '- {"type":"pricing","title":"...","intro":"one line","plans":[{"name":"Pro","price":"$29","period":"mo","featured":true,"body":"one line","features":["...","..."],"cta":"Get Pro"}]}  (2-3 plans; mark one featured)\n' +
               '- {"type":"testimonials","title":"...","items":[{"quote":"...","name":"...","role":"..."}]}  (2-6 real-sounding quotes)\n' +
               '- {"type":"faq","title":"...","items":[{"q":"...","a":"..."}]}  (3-8 question/answer pairs)\n' +
               '- {"type":"form","title":"...","intro":"one line","cta":"Send","fields":[{"name":"name","label":"Full name"},{"name":"email","label":"Email","type":"email"},{"name":"message","label":"Message","type":"textarea"}],"form":"contact"}  (a REAL form whose submissions are stored in the database — put one on a contact / get-in-touch / sign-up / stockists page. "form" names the table bucket, default "contact".)\n' +
               '- {"type":"feed","title":"...","intro":"one line","form":"listing","empty":"Nothing here yet."}  (a LIVE list of the site\'s own PUBLIC submissions to the form with the SAME "form" name — for a directory / listings / reviews / community wall. Pair it with a {"type":"form","form":"listing"} so visitors add an entry and SEE it appear. Use for app/store/directory briefs. NEVER point a feed at a private "contact" form.)\n' +
               '- {"type":"collection","title":"...","intro":"one line","table":"items","empty":"Nothing here yet."}  (a LIVE list rendered from the project\'s REAL database table named "table" — products, menu, listings, fleet. Use for app/store pages; the database department must CREATE and SEED that exact table. Reads the live DB.)\n' +
               '- {"type":"form","table":"listings","title":"Add yours","cta":"Add"}  (an "add a record" form that writes a REAL row to the database table named "table" — the FIELDS are generated automatically from that table\'s columns, you do NOT list them. Pair it with a {"type":"collection","table":"<same table>"} so a visitor adds an entry and SEES it appear. Use for directory / listings / classifieds / reviews apps.)\n' +
               '- {"type":"video","title":"...","eyebrow":"...","youtubeId":"dQw4w9WgXcQ","poster":"concert stage lights","caption":"..."}  (ARC D — ONLY when the brief EXPLICITLY mentions a video, YouTube link, or "watch this". Extract the YouTube video ID from a URL in the brief — e.g. from https://youtu.be/dQw4w9WgXcQ the id is dQw4w9WgXcQ. NEVER invent a YouTube id. Alternatively use {"type":"video","src":"https://…/video.mp4"} for a direct video file (https, ends .mp4 or .webm). The renderer creates a privacy-safe click-to-load facade — no third-party requests until the visitor clicks play.)\n' +
               'Rules: use the EXACT brand + copy from upstream; write real, specific copy (NEVER [placeholders] or lorem ipsum); image fields are 2-4 word stock-photo SEARCH TERMS (not URLs); pick bg + primary with strong contrast for each other (the renderer guarantees readable text either way). The system owns fonts, spacing, shape and layout (chosen from the brief) — you only supply copy, section order and 2 brand colours.\n\n⚠️ FINAL CHECK before submitting: does your output contain any of \"<\", \">\", \"```\", or text before \"{\" or after \"}\"? If YES — REWRITE the entire response as pure JSON. JSON ONLY.',
  compose:     'You are the Composition department. You compose the ENTIRE multi-page website as ONE JSON object — the site\'s single source (its CMS). A deterministic renderer turns it into perfect, responsive, accessible pages and OWNS all visual design, the shared navigation, fonts, spacing, shape and the LOCKED brand palette. You only choose, for EACH page, its sections + real copy. Output ONLY JSON (no prose/markdown/fences):\n' +
               '{"pages":[{"slug":"index","title":"Home","sections":[ ...3-6 sections... ]},{"slug":"about","title":"About","sections":[...]}]}\n' +
               'Compose EVERY page listed under "PAGES TO COMPOSE" using its EXACT slug + title; give each 3-6 sections; every page MUST open with a hero. Write real, specific copy for THIS brief (NEVER [placeholders] or lorem ipsum). image fields are 2-4 word stock-photo SEARCH TERMS (not URLs). A cta MAY set "link":"<page slug>".\n' +
               'BUSINESS NAME — SYSTEM-OWNED, NOT YOUR CHOICE: wherever the business/brand name would appear in copy (headlines, about, footer, CTAs), write the LITERAL token {{brand}} — exactly those 9 characters. NEVER write an actual business name, variation, or made-up name anywhere. The system substitutes the ONE locked name. Example: "Welcome to {{brand}}" / "Why choose {{brand}}?" / "{{brand}} was founded in 2019". This guarantees one identity across every page.\n' +
               'Section types (mix what fits each page):\n' +
               '- {"type":"hero","image":"2-4 word photo","eyebrow":"kicker","headline":"...","lead":"1-2 sentence subhead","cta":"label"}\n' +
               '- {"type":"features","title":"...","intro":"one line","items":[{"title":"...","body":"..."}]}  (3-4)\n' +
               '- {"type":"split","image":"2-4 word photo","eyebrow":"...","title":"...","body":"a paragraph","cta":"label","reverse":false}\n' +
               '- {"type":"gallery","title":"...","images":["2-4 word photo","..."]}  (4-6)\n' +
               '- {"type":"cta","headline":"...","body":"one line","cta":"label"}\n' +
               '- {"type":"stats","title":"...","items":[{"value":"480+","label":"projects shipped"}]}  (3-4)\n' +
               '- {"type":"pricing","title":"...","intro":"one line","plans":[{"name":"Pro","price":"$29","period":"mo","featured":true,"body":"one line","features":["...","..."],"cta":"Get Pro"}]}  (2-3; mark one featured)\n' +
               '- {"type":"testimonials","title":"...","items":[{"quote":"...","name":"...","role":"..."}]}  (2-6)\n' +
               '- {"type":"faq","title":"...","items":[{"q":"...","a":"..."}]}  (3-8)\n' +
               '- {"type":"logos","title":"Trusted by","items":["Acme Co","Nordia","..."]}  (4-8 client/press names — social-proof band, plain text)\n' +
               '- {"type":"offer","eyebrow":"kicker","title":"the offer in one line","body":"one sentence","bullets":["what they get","..."],"price":"$499","period":"one-time","cta":"label","guarantee":"a concrete risk-reversal, e.g. 30-day money-back"}  (the conversion core — price only if the brief names one)\n' +
               '- {"type":"form","title":"...","intro":"one line","cta":"Send","form":"contact"}  (a REAL stored form; put one on a contact / sign-up / get-in-touch page)\n' +
               '- {"type":"collection","title":"...","table":"items"} and {"type":"feed","form":"listing"}  (LIVE lists of real DB rows / public submissions — for app/store/directory pages; use the EXACT table names provided, pair a feed with a matching form)\n' +
               '- STORE ONLY: {"type":"products","title":"...","intro":"one line","table":"products"} (the SHOP GRID with Add-to-cart — put it on the shop/index page) · {"type":"cart","title":"Your cart"} (ONLY on the cart page) · {"type":"checkout","title":"Checkout","intro":"one line","cta":"Place order"} (ONLY on the checkout page)\n' +
               '- VIDEO (ARC D): {"type":"video","title":"...","youtubeId":"<id>","poster":"2-4 word photo search","caption":"..."}  ONLY when the brief EXPLICITLY mentions a video or YouTube link. Extract the YouTube id from a URL in the brief — e.g. from https://youtu.be/dQw4w9WgXcQ the id is dQw4w9WgXcQ. NEVER invent or guess a YouTube id. The renderer builds a privacy-safe facade (no tracking until play is clicked). For a direct file: {"type":"video","src":"https://…/video.mp4"}.\n' +
               'JSON ONLY — exactly one object containing every page. Self-check: every { has a matching }, no second block, no prose/fences.',
  integration: 'You are the Integration department. List the integrations to wire and the deploy steps.',
  qa:          'You are QA. The built site is verified by an automated render check, not by you. Briefly note any obvious gaps you would flag.',
};

function buildUser(ctx: Ctx, department?: string): string {
  let s = '';
  if (ctx.feedback) s += `IMPORTANT — your previous attempt FAILED an automated check: ${ctx.feedback}\nProduce a corrected version that passes this check.\n\n`;
  s += `BRIEF: ${ctx.brief}\n`;
  if (ctx.upstream.length) {
    s += `\nUPSTREAM RESULTS (the departments you depend on):\n`;
    for (const u of ctx.upstream) s += `\n[#${u.seq} ${u.department}]\n${u.content}\n`;
  }
  // COMPOSE: build the WHOLE site (all pages) in one shot — the single CMS the renderer projects pages from.
  if (department === 'compose' && ctx.pages && ctx.pages.length) {
    s += `\nPAGES TO COMPOSE (compose ALL of them, in this order; each opens with a hero):\n`;
    s += ctx.pages.map(p => `  ${p.slug} — "${p.title}"`).join('\n') + '\n';
    const th = themeFor(ctx.theme, ctx.brief);
    s += `\nDesign language: ${th}. Match the copy TONE to it — ${themeTone(th)}. (The system renders all visual design, the shared nav and the locked palette; you write copy + choose sections per page.)\n`;
    if (ctx.tables && ctx.tables.length) {
      s += `\nThis app's REAL database tables: ${ctx.tables.join(', ')}.`;
      if (ctx.primaryTable) s += ` The MAIN catalog/list table is "${ctx.primaryTable}" — a product/listing/menu {"type":"collection"} or {"type":"form"} MUST use table:"${ctx.primaryTable}".`;
      s += ` Use EXACT table names so live data shows.`;
      s += ` REQUIRED: the site's core user action (booking, ordering, reserving, signing up) MUST be a {"type":"form","table":"..."} section on the fitting page — its fields are auto-generated from the table's schema (relations become dropdowns of real records); you only write the title/intro/cta.\n`;
    }
    if (ctx.brand && ctx.brand.name) {
      s += `\nBUSINESS NAME — SYSTEM-OWNED: do NOT write the business name anywhere. Wherever the name would appear in copy, write the literal token {{brand}} — the system inserts the one locked name (the renderer also owns the logo, palette + nav button). You ONLY write copy + sections. Never invent or write a business name.\n`;
    }
    // STORE (PQ2): the shop grid + cart + checkout are deterministic components — the composer only
    // places them and writes the copy around them.
    if ((ctx as any).archetype === 'store') {
      s += `\nTHIS IS A STORE: the shop/index page MUST include {"type":"products","table":"products"}; the cart page gets {"type":"cart"}; the checkout page gets {"type":"checkout"}. Do NOT put a generic form on the checkout page — the checkout component already collects the buyer's details and writes a REAL order.\n`;
    }
    // LANDING (PLAN.md M1): one page engineered to convert — strict order, proof + offer, CTA last.
    if (ctx.shape === 'landing') {
      s += `\nTHIS IS A LANDING PAGE — one page engineered to CONVERT, not a brochure:
- SECTION ORDER (strict): hero (name the visitor's PAIN in the headline, the PROMISE in the lead) → proof (logos and/or stats/testimonials) → what-they-get (features or split) → offer (concrete deliverable + risk-reversal guarantee; price ONLY if the brief names one) → objections (faq, optional) → the FINAL section MUST be cta or form.
- REQUIRED: an "offer" section, plus at least TWO of: logos, stats, testimonials, offer, pricing, faq.
- COPY: outcome-specific headline (numbers beat adjectives), second person ("you"), ONE consistent call-to-action label repeated in hero/offer/final, zero generic filler.\n`;
    }
    s += `\nEvery cta MAY set "link":"<page slug>". Valid slugs: ${(ctx.pages || []).map(p => p.slug).join(', ')}.\n`;
    return s;
  }
  if (ctx.self && ctx.pages && ctx.pages.length) {
    s += `\nYOU ARE BUILDING THIS PAGE: "${ctx.self.title}" — output the full HTML for ${ctx.self.slug}.html.\n`;
    s += `Shared top nav must link ALL pages (highlight the current one):\n`;
    s += ctx.pages.map(p => `  ${p.title} -> ${p.slug}.html`).join('\n') + '\n';
    s += `Use those exact relative hrefs (home is index.html). Build ONLY this one page.\n`;
    const th = themeFor(ctx.theme, ctx.brief);
    s += `\nDesign language: ${th}. Match the copy TONE to it — ${themeTone(th)}. (The system renders all visual design; you write copy + choose sections + 2 colours.)\n`;
    if (ctx.tables && ctx.tables.length) {
      s += `\nThis app's REAL database tables: ${ctx.tables.join(', ')}.`;
      if (ctx.primaryTable) s += ` The MAIN catalog/list table is "${ctx.primaryTable}" — a product/listing/menu {"type":"collection"} or {"type":"form"} MUST use table:"${ctx.primaryTable}". Do NOT put a collection on a lookup table (categories) or contact info.`;
      s += ` Use EXACT table names so live data shows.\n`;
    }
    s += `\nEvery cta SHOULD set "link":"<page slug>" to point at the RIGHT page (e.g. a "Contact us" cta → "link":"${(ctx.pages?.find(p => /contact/.test(p.slug)) || ctx.pages?.[ctx.pages.length - 1] || { slug: 'index' }).slug}"). Valid slugs: ${(ctx.pages || []).map(p => p.slug).join(', ')}.\n`;
    if (ctx.brand && ctx.brand.name) {
      s += `\nBRAND IDENTITY — LOCKED for the WHOLE site (every page shares ONE). The brand/business name is "${ctx.brand.name}". Use EXACTLY this name as brand.name AND everywhere a name appears in the copy (hero, about, footer) — NEVER invent a different name, variation, or a tagline used as the name.${ctx.brand.tokens && ctx.brand.tokens.bg ? ` Palette is fixed: bg ${ctx.brand.tokens.bg}, primary ${ctx.brand.tokens.primary} — set brand.tokens to these.` : ''}\n`;
    }
  }
  return s;
}

// Per-call instrumentation for the openrouter-vs-minimax A/B (Task 10): every live call reports which
// provider+model served it, how long it took, whether web search was on, and whether it succeeded.
export type LLMResult = { text: string; meta: { provider: 'openrouter' | 'minimax-direct'; model: string; latencyMs: number; web: boolean; ok: boolean; error?: string } };

// the single live call. Prefer OpenRouter (MiniMax + optional web search); else MiniMax-direct.
// Returns the text AND per-call meta. On failure it returns ok:false (no throw) with the captured error —
// the string wrappers (llmText/llm/runAgent) still yield '' on failure exactly as the old throw-path did
// (planner: empty→null; runner: re-throws after logging meta so the agent_error retry path is unchanged).
// QUOTA-CLASS error: the provider account is unusable (weekly key limit, spent credits, bad key)
// — can last DAYS. Distinct from transient (timeouts/5xx, which retry) and from model failures.
// The 2026-07-04 outage: OpenRouter weekly limit killed builds while a configured MiniMax-direct
// key sat unused — callLLM now fails over on exactly this class.
export function isQuotaExhausted(msg: any): boolean {
  const s2 = String(msg ?? '');
  if (isBadKey(s2)) return false;   // a revoked/invalid key is PERMANENT config, not transient quota — must fail, never park
  if (/your current token plan|token plan (?:is )?(?:expired|exhausted|used up)/i.test(s2)) return true;  // MiniMax bills via 500 (observed live 2026-07-04)
  return /\b(401|402|403|429)\b/.test(s2) && /(key limit|quota|credit|exceeded|insufficient|billing|payment required)/i.test(s2);
}
// a 401 unauthorized / invalid-key is a MISCONFIGURATION that never self-heals — parking it as
// 'quota' loops the build forever. Classify it out of quota so the runner fails it fast.
export function isBadKey(msg: any): boolean {
  const s2 = String(msg ?? '');
  return /\b401\b/.test(s2) && /(unauthorized|invalid.*key|no auth|authentication)/i.test(s2);
}

// try each rung in order — we are already in degraded mode, so ANY failure moves down the ladder
async function callOpenRouterLadder(messages: any[], maxTokens: number, timeoutMs: number, t0: number): Promise<LLMResult> {
  let last: any = null;
  for (const m of OR_FALLBACK_MODELS) {
    try { return await callOpenRouter(messages, m, maxTokens, timeoutMs, false, t0); }
    catch (e: any) { last = e; }
  }
  throw last ?? new Error('fallback ladder empty');
}

// M-family reasoning spends tokens in <think> BEFORE the answer — the caller's budget is for
// the ANSWER, so the wire budget gets headroom on top, and an all-think truncation retries
// ONCE with double. (Observed live on M3 2026-07-05: intermittent empty-after-strip at 3k caps.)
const THINK_HEADROOM = Number(process.env.MINIMAX_THINK_HEADROOM || 4000);
async function callMiniMaxDirect(messages: any[], maxTokens: number, timeoutMs: number, web: boolean, t0: number, _retry = false): Promise<LLMResult> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.7, max_tokens: maxTokens + THINK_HEADROOM }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`MiniMax ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  // M2-family direct API embeds reasoning as <think>…</think> INSIDE message.content
  // (OpenRouter separates it) — strip it or the site copy ships with the model's inner monologue
  const text = String(data?.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) {
    if (!_retry) return callMiniMaxDirect(messages, (maxTokens + THINK_HEADROOM) * 2, timeoutMs, web, t0, true);
    throw new Error('MiniMax: empty response after reasoning strip ' + JSON.stringify(data).slice(0, 200));
  }
  return { text, meta: { provider: 'minimax-direct', model: MODEL, latencyMs: Date.now() - t0, web, ok: true } };
}

// one small ping of the FALLBACK (the OpenRouter free model) — used by the daily digest so a
// dead fallback surfaces before the day the primary lapses. null = no fallback configured.
export async function pingFallback(): Promise<boolean | null> {
  if (!OR_KEY || !KEY) return null;   // fallback only exists when BOTH are configured
  // 400 tokens — enough even for a reasoning model to close its think block
  try { const r = await callOpenRouterLadder([{ role: 'system', content: 'Answer with the single word: ok' }, { role: 'user', content: 'ping' }], 400, 45000, Date.now()); return !!r.meta.ok; }
  catch { return false; }
}

async function callOpenRouter(messages: any[], model: string, maxTokens: number, timeoutMs: number, web: boolean, t0: number): Promise<LLMResult> {
  const body: any = { model, messages, temperature: 0.7, max_tokens: maxTokens };
  // OpenRouter's server-side web search (Exa) — runs INSIDE this one completion and folds in citations.
  if (web) body.plugins = [{ id: 'web', max_results: Number(process.env.WEB_MAX_RESULTS || 5) }];
  // reasoning effort only for models that HAVE reasoning — a free non-reasoning model may reject it
  if (/minimax|deepseek-r1|o[13]-|thinking/i.test(model)) body.reasoning = { effort: 'minimal' };
  const res = await fetch(`${OR_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json',
      'HTTP-Referer': 'https://board.naples.agency', 'X-Title': 'Relay',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  const text = String(data?.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) {
    const fin = data?.choices?.[0]?.finish_reason;
    throw new Error(fin === 'length'
      ? 'OpenRouter: truncated before content — raise max_tokens (reasoning ate the budget)'
      : 'OpenRouter: empty response ' + JSON.stringify(data).slice(0, 200));
  }
  return { text, meta: { provider: 'openrouter', model, latencyMs: Date.now() - t0, web, ok: true } };
}

// PROVIDER ORDER (owner's directive 2026-07-05): MiniMax-direct is the PRIMARY — the coding
// plan carries ~12.5B tokens/month of M3. OpenRouter is the FALLBACK on a FREE/cheap model.
// Exception: web-grounded calls (research/strategy) go OR-first — the Exa plugin is OR-only —
// and fall back to MiniMax UNgrounded rather than fail. Transient errors never fail over.
export async function callLLM(system: string, user: string, maxTokens: number = 16000, opts: { web?: boolean; timeoutMs?: number } = {}): Promise<LLMResult> {
  const t0 = Date.now();
  const web = !!opts.web;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : LLM_TIMEOUT_MS;  // compose (whole site) needs more
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const primary: 'openrouter' | 'minimax-direct' = (web && OR_KEY) ? 'openrouter' : (KEY ? 'minimax-direct' : 'openrouter');
  try {
    if (primary === 'openrouter') return web ? await callOpenRouter(messages, OR_MODEL, maxTokens, timeoutMs, true, t0) : await callOpenRouterLadder(messages, maxTokens, timeoutMs, t0);
    return await callMiniMaxDirect(messages, maxTokens, timeoutMs, web, t0);
  } catch (e: any) {
    if (isQuotaExhausted(e?.message) && OR_KEY && KEY) {
      try {
        return primary === 'minimax-direct'
          ? await callOpenRouterLadder(messages, maxTokens, timeoutMs, t0)
          : await callMiniMaxDirect(messages, maxTokens, timeoutMs, false, t0);
      } catch (e2: any) {
        return { text: '', meta: { provider: primary === 'minimax-direct' ? 'openrouter' : 'minimax-direct', model: primary === 'minimax-direct' ? OR_FALLBACK_MODELS[OR_FALLBACK_MODELS.length - 1] : MODEL, latencyMs: Date.now() - t0, web, ok: false, error: `failover after [${String(e?.message).slice(0, 120)}]: ${String(e2?.message ?? e2)}`.slice(0, 300) } };
      }
    }
    return { text: '', meta: { provider: primary, model: primary === 'openrouter' ? (web ? OR_MODEL : OR_FALLBACK_MODELS[0]) : MODEL, latencyMs: Date.now() - t0, web, ok: false, error: String(e?.message ?? e) } };
  }
}

// string-returning form (drops the meta) for callers that just want the text.
export async function llmText(system: string, user: string, maxTokens: number = 3000, opts: { web?: boolean } = {}): Promise<string> {
  return (await callLLM(system, user, maxTokens, opts)).text;
}

// generic text call (used by the planner); '' when no provider so callers fall back. opts.web = ground in live web search.
// BACKWARD COMPAT: unchanged signature + string return — a thin wrapper around llmText, guarded so an offline
// (no-provider) process returns '' without a doomed network attempt, exactly as before.
export async function llm(system: string, user: string, maxTokens = 3000, opts: { web?: boolean } = {}): Promise<string> {
  return LIVE ? llmText(system, user, maxTokens, opts) : '';
}

// meta-returning form of llm() for callers that want the A/B instrumentation (provider/latency/ok).
export async function llmTracked(system: string, user: string, maxTokens = 3000, opts: { web?: boolean } = {}): Promise<LLMResult> {
  if (LIVE) return callLLM(system, user, maxTokens, opts);
  return { text: '', meta: { provider: OR_KEY ? 'openrouter' : 'minimax-direct', model: 'none', latencyMs: 0, web: !!opts.web, ok: false, error: 'no provider configured' } };
}

// run one department agent and return its text + per-call meta (the runner logs the meta to run_events).
export async function runAgentTracked(department: string, ctx: Ctx): Promise<LLMResult> {
  if (LIVE) {
    const system = ROLE[department] || `You are the ${department} department of an automated agency. Do your part for the brief.`;
    const web = WEB_DEPTS.has(department);
    // reasoning models need headroom; compose emits the WHOLE site (all pages) so it needs the most; build
    // emits one page's spec; web calls synthesize search results.
    const maxTokens = department === 'compose' ? 16000 : department === 'build' ? 8000 : (web ? 4000 : 3000);
    // compose generates the WHOLE site in one call (it replaces N per-page calls) — give it real headroom so
    // it doesn't flake on the 90s default the way a single small call never would.
    const timeoutMs = department === 'compose' ? Number(process.env.COMPOSE_TIMEOUT_MS || 180000) : undefined;
    return await callLLM(system, buildUser(ctx, department), maxTokens, { web, timeoutMs });
  }
  // offline deterministic fallback — synthesize a uniform meta so the runner's instrumentation still records it.
  return { text: stub(department, ctx.brief), meta: { provider: OR_KEY ? 'openrouter' : 'minimax-direct', model: 'stub', latencyMs: 0, web: WEB_DEPTS.has(department), ok: true } };
}

// BACKWARD COMPAT: string-returning entry point used by the eval harness (src/eval.ts). Unchanged contract.
export async function runAgent(department: string, ctx: Ctx): Promise<string> {
  return (await runAgentTracked(department, ctx)).text;
}

// ---- offline deterministic fallback (no key) ----
// offline stub: a JSON DATA MODEL (the engine compiles it to perfect DDL) — exercises the schema compiler
const DB_SQL = JSON.stringify({
  entities: [
    { name: 'menu_items', public: true, display: 'name', fields: [
      { name: 'name', type: 'text', required: true }, { name: 'price', type: 'money', required: true },
      { name: 'category', type: 'text' }, { name: 'description', type: 'longtext' }, { name: 'available', type: 'bool', default: true }],
      seed: [
        { name: 'Margherita', price: 9.5, category: 'Pizza', description: 'Tomato, mozzarella, basil', available: true },
        { name: 'Pepperoni', price: 12, category: 'Pizza', description: 'House sausage', available: true },
        { name: 'Garden Salad', price: 7.25, category: 'Sides', description: 'Seasonal greens', available: true },
        { name: 'Tiramisu', price: 6, category: 'Dessert', description: 'Classic, espresso-soaked', available: true }] },
    { name: 'orders', fields: [
      { name: 'customer_name', type: 'text', required: true }, { name: 'item', type: 'ref:menu_items' },
      { name: 'total', type: 'money' }, { name: 'status', type: 'text', default: 'placed' }] },
  ],
});

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
    case 'compose':     return JSON.stringify({
      pages: [
        { slug: 'index', title: 'Home', sections: [
          { type: 'hero', eyebrow: 'City-wide delivery', headline: 'Anything you need, at your door in under an hour', lead: 'Swift Lane connects you to the shops and kitchens nearby and brings your order over while it is still warm.', cta: 'Order now', image: 'city courier bike' },
          { type: 'features', title: 'Why Swift Lane', intro: 'Built for speed and trust.', items: [
            { title: 'Live tracking', body: 'Watch your courier move on the map from pickup to your door.' },
            { title: 'Pay your way', body: 'Card, wallet, or cash on delivery — whatever suits you.' },
            { title: 'Real support', body: 'A person, not a bot, the moment something needs sorting.' }] },
          { type: 'cta', headline: 'Hungry yet?', body: 'Get your first order in minutes.', cta: 'Order now' }] },
        { slug: 'about', title: 'About', sections: [
          { type: 'hero', headline: 'We move your city, one order at a time', lead: 'Swift Lane started with three couriers and a simple promise: fast, honest delivery.', image: 'team portrait warehouse' },
          { type: 'split', eyebrow: 'Our story', title: 'Built by people who deliver', body: 'We obsess over the last mile so local shops can compete with anyone.', cta: 'Partner with us' }] },
        { slug: 'contact', title: 'Contact', sections: [
          { type: 'hero', headline: 'Get in touch', lead: 'Questions, partnerships, or support — we reply fast.', image: 'support desk' },
          { type: 'form', title: 'Send us a message', intro: 'We answer within a day.', cta: 'Send', form: 'contact' }] },
      ],
    });
    case 'integration': return `Integration: payments + maps wired; deploy config ready.`;
    case 'qa':          return `QA: no blocking gaps noted.`;
    default:            return `[${department}] completed for: ${brief}`;
  }
}

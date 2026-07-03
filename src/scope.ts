// SCOPE — honest intake: what Relay includes, what it cannot yet (with the honest alternative),
// and a difficulty rating. Deterministic, closed set — no LLM, no randomness, no side effects.
export type ScopeItem = { name: string; promise: string };
export type ScopeMiss  = { ask: string; alternative: string };
export type Scope      = { includes: ScopeItem[]; excludes: ScopeMiss[]; difficulty: 1|2|3|4|5 };

type Cap   = { name: string; detect: RegExp; promise: string };
type Unsup = { detect: RegExp; ask: string; alternative: string };

// Closed capability registry — detect runs over the lowercased brief.
// \b on shop/store prevents "barbershop"/"restore" false-positives.
const CAPABILITIES: Cap[] = [
  { name: 'booking',  detect: /book|reserv|appoint|schedul/,
    promise: 'online booking with live receipts and status updates' },
  { name: 'store',    detect: /\bshop\b|\bstore\b|e-?commerce|catalog|\bcart\b|checkout|sell/,
    promise: 'a real store: product pages, cart, server-priced checkout, stock awareness' },
  { name: 'tracking', detect: /track|follow[- ]?up/,
    promise: 'live status tracking via a private link + email updates' },
  { name: 'accounts', detect: /account|sign ?in|log ?in|member|portal|user/,
    promise: 'sign-in on the site: email magic link + a personal records page' },
  { name: 'landing',  detect: /landing/,
    promise: 'one focused conversion page' },
];

// Unconditionally appended for app archetype; store gets these plus lead-email.
const ALWAYS_APP: ScopeItem[] = [
  { name: 'receipts', promise: 'every submission gets a private receipt page + find-my-booking' },
  { name: 'editing',  promise: "you edit your content live from the board's Content tab" },
];
const ALWAYS_STORE_EXTRA: ScopeItem[] = [
  { name: 'lead-email', promise: 'you are emailed every lead/order instantly' },
];

// Closed unsupported registry — first matching entry per brief produces one ScopeMiss.
const UNSUPPORTED: Unsup[] = [
  { detect: /fedex|\bups\b|dhl|stripe|paypal|payment gateway|twilio|\bsms\b|whatsapp|google (maps|calendar)|instagram|open ?ai|third[- ]party api|api integration/,
    ask: "external API integrations aren't supported yet",
    alternative: 'we deliver the equivalent in-app flow (internal tracking, cash/invoice orders)' },
  { detect: /native app|android app|ios app|app store|play store/,
    ask: 'a store-listed native app',
    alternative: 'an installable web app (add to home screen) — native packaging is on the roadmap' },
  { detect: /multi-?lang|translat|bilingual/,
    ask: 'multilingual versions',
    alternative: 'one language per site today' },
  { detect: /online payment|credit card|pay online/,
    ask: 'online card payments',
    alternative: 'orders are recorded and confirmed; payment is settled off-platform for now' },
];

// Exported for scope:check assertions only.
export const CAP_REGISTRY   = CAPABILITIES;
export const UNSUP_REGISTRY = UNSUPPORTED;
export const ALL_SCOPE_NAMES: ReadonlySet<string> = new Set([
  ...CAPABILITIES.map(c => c.name),
  ...ALWAYS_APP.map(i => i.name),
  ...ALWAYS_STORE_EXTRA.map(i => i.name),
]);

// Same brief + archetype → same Scope, always.
export function evaluateScope(brief: string, archetype: string): Scope {
  const b = brief.toLowerCase();
  const seen = new Set<string>();
  const includes: ScopeItem[] = [];

  for (const cap of CAPABILITIES) {
    if (cap.detect.test(b) && !seen.has(cap.name)) {
      includes.push({ name: cap.name, promise: cap.promise });
      seen.add(cap.name);
    }
  }
  if (archetype === 'app' || archetype === 'store') {
    for (const item of ALWAYS_APP) {
      if (!seen.has(item.name)) { includes.push(item); seen.add(item.name); }
    }
  }
  if (archetype === 'store') {
    for (const item of ALWAYS_STORE_EXTRA) {
      if (!seen.has(item.name)) { includes.push(item); seen.add(item.name); }
    }
  }

  const excludes: ScopeMiss[] = [];
  for (const u of UNSUPPORTED) {
    if (u.detect.test(b)) excludes.push({ ask: u.ask, alternative: u.alternative });
  }

  // 1 base (site) or 2 (app/store); +1 for ≥4 includes; +1 for ≥1 exclude;
  // +1 for ≥4 compound conjunctions; capped at 5.
  let d = archetype === 'site' ? 1 : 2;
  if (includes.length >= 4) d++;
  if (excludes.length >= 1) d++;
  if ((b.match(/\band\b|\bplus\b|\balso\b|\bwith\b/g) || []).length >= 4) d++;

  return { includes, excludes, difficulty: Math.min(d, 5) as 1|2|3|4|5 };
}

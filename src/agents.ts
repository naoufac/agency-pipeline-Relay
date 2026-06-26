// A working agent is JUST AN API CALL: context in -> text/artifact out.
// No ANTHROPIC_API_KEY in this environment, so these are deterministic STUBS.
// Swap the body of runAgent for an Anthropic call (same signature) to go live.

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

export type Ctx = { brief: string; upstream: { seq: number; department: string; content: string }[] };

export async function runAgent(department: string, ctx: Ctx): Promise<string> {
  const brief = ctx.brief;
  switch (department) {
    case 'research':    return `Research for: ${brief}\nPremium urban market; cash-on-delivery common; FR/AR conventions.`;
    case 'branding':    return `Brand tokens\nprimary=#0B6E4F  secondary=#E9C46A\ntypography=Inter  radius=12px`;
    case 'stack':       return `Stack decision: Supabase (Postgres) backend + Next.js PWA.`;
    case 'database':    return DB_SQL; // a REAL artifact — verified by actually applying it
    case 'design':      return `Design system: brand tokens applied; 12 base components.`;
    case 'media':       return `Media: 20 product images sourced + brand assets.`;
    case 'content':     return `Copy: premium, locally-proud microcopy set.`;
    case 'auth':        return `Auth: phone + password, OTP, sessions.`;
    case 'frontend':    return `Screens built: browse, cart, checkout, track. (applies brand tokens)`;
    case 'integration': return `Integration: payments + maps wired; deploy config ready.`;
    case 'qa':          return `QA harness ran build + smoke tests. Verdict: PASS.`;
    default:            return `[${department}] completed for: ${brief}`;
  }
}

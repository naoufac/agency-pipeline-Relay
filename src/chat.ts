// chat.ts — PROJECT CHAT, MULTI-SESSION (owner directive 2026-07-05). The client's dashboard
// gets a conversation per project; a user can hold MANY sessions. Two reply paths, chosen
// deterministically: a CHANGE-INTENT message triggers the real rebuild machinery (replan +
// runLoop — the same path as tg-door / the Rebuild button, data survives by the migration
// contract); anything else gets an LLM answer GROUNDED in the project's real facts (brief,
// status, pages, activity) — the model explains, it never invents capabilities.
import pg from 'pg';
import { callLLM } from './agents.ts';

export async function ensureChatTables(pool: pg.Pool): Promise<void> {
  await pool.query(`create table if not exists chat_sessions (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null,
    user_id uuid not null,
    title text not null default 'New chat',
    created_at timestamptz not null default now()
  )`);
  await pool.query(`create index if not exists chat_sessions_proj_user on chat_sessions(project_id, user_id, created_at desc)`);
  await pool.query(`create table if not exists chat_messages (
    id bigserial primary key,
    session_id uuid not null references chat_sessions(id) on delete cascade,
    role text not null check (role in ('user','relay')),
    body text not null,
    created_at timestamptz not null default now()
  )`);
  await pool.query(`create index if not exists chat_messages_session on chat_messages(session_id, id)`);
}

export async function listSessions(pool: pg.Pool, projectId: string, userId: string) {
  return (await pool.query(
    `select s.id, s.title, s.created_at,
       (select count(*)::int from chat_messages m where m.session_id = s.id) as messages
     from chat_sessions s where s.project_id=$1 and s.user_id=$2 order by s.created_at desc limit 50`,
    [projectId, userId])).rows;
}

export async function createSession(pool: pg.Pool, projectId: string, userId: string) {
  return (await pool.query('insert into chat_sessions(project_id, user_id) values ($1,$2) returning id, title, created_at', [projectId, userId])).rows[0];
}

// every read is scoped to the OWNING user — a session id alone is never enough
export async function sessionOf(pool: pg.Pool, sessionId: string, userId: string): Promise<{ id: string; project_id: string; title: string } | null> {
  return (await pool.query('select id, project_id, title from chat_sessions where id=$1 and user_id=$2', [sessionId, userId])).rows[0] || null;
}

export async function listMessages(pool: pg.Pool, sessionId: string) {
  return (await pool.query('select id, role, body, created_at from chat_messages where session_id=$1 order by id asc limit 500', [sessionId])).rows;
}

// a message that ASKS FOR WORK — verbs in the five site locales. Deterministic: the regex
// decides whether the rebuild machinery fires; the LLM never gets to trigger a build.
export const CHANGE_INTENT = /\b(change|update|add|remove|replace|rename|switch|make it|set the|redo|cambia|aggiungi|rimuovi|modifica|sostituisci|modifie|ajoute|supprime|remplace|cambia el|añade|quita|reemplaza|ändere|füge|entferne|ersetze)\b/i;
// …but a QUESTION that merely CONTAINS a change verb ("should we add a booking form?", "what would
// it take to change the colors?") must NOT sweep the live site and rebuild. A rebuild is destructive
// (pages regenerate, minutes of build) so we only fire on IMPERATIVE phrasing: not ending in '?' and
// not opening with an interrogative/modal across the five locales. Ambiguous polite requests fall to
// the grounded answer, which coaches the client to say the change plainly — a confirmation step, by
// design. An explicit "change:/update:/rebuild:" prefix always counts. (adversarial audit 2026-07-05)
const QUESTION_LEAD = /^\s*(what|whats|when|where|why|who|how|which|is|are|am|do|does|did|can|could|would|should|will|shall|may|might|cosa|quando|dove|perch[eé]|chi|come|quale|puoi|potresti|dovrei|dovremmo|posso|quoi|quand|o[uù]|pourquoi|comment|quel|quelle|peux|pourrais|est-ce|dois|devrait|qu[eé]|cu[aá]ndo|d[oó]nde|por qu[eé]|qui[eé]n|c[oó]mo|cu[aá]l|puedo|puedes|podr[ií]a|deber[ií]a|was|wann|wo|warum|wer|wie|welche|kann|k[oö]nnte|soll|sollte|darf)\b/i;
export function wantsRebuild(body: string): boolean {
  const b = String(body || '').trim();
  if (/^\s*(change|update|rebuild)\s*[:\-—]/i.test(b)) return true;   // explicit directive prefix — always a command
  if (!CHANGE_INTENT.test(b)) return false;
  if (b.endsWith('?')) return false;                                  // a question, never a command
  if (QUESTION_LEAD.test(b)) return false;                            // opens like a question / modal
  return true;
}

export type RebuildHook = (projectId: string, changeText: string) => Promise<{ started: boolean; reason?: string }>;
export type AnswerHook = (system: string, user: string) => Promise<string>;

const defaultAnswer: AnswerHook = async (system, user) => {
  const r = await callLLM(system, user, 900, { timeoutMs: 60_000 });
  return r.meta.ok && r.text ? r.text : 'I could not reach the model just now — please try again in a moment.';
};

export async function postMessage(
  pool: pg.Pool,
  args: { sessionId: string; userId: string; body: string },
  hooks: { rebuild: RebuildHook; answer?: AnswerHook },
): Promise<{ ok: boolean; reply?: string; rebuilding?: boolean; error?: string }> {
  const body = String(args.body || '').trim().slice(0, 4000);
  if (!body) return { ok: false, error: 'empty message' };
  const sess = await sessionOf(pool, args.sessionId, args.userId);
  if (!sess) return { ok: false, error: 'no such session' };

  await pool.query("insert into chat_messages(session_id, role, body) values ($1,'user',$2)", [sess.id, body]);
  // the first message names the session
  if (sess.title === 'New chat') {
    await pool.query('update chat_sessions set title=$2 where id=$1', [sess.id, body.slice(0, 60)]);
  }

  let reply: string; let rebuilding = false;
  if (wantsRebuild(body)) {
    const r = await hooks.rebuild(sess.project_id, body);
    rebuilding = r.started;
    reply = r.started
      ? 'On it — rebuilding your site with that change now. Your existing data and web address survive the rebuild. Watch the Build tab; this usually takes a few minutes.'
      : `I can't start that rebuild right now: ${r.reason || 'the site is busy'}. Try again in a few minutes.`;
  } else {
    // GROUNDED answer: the model sees the project's REAL facts and the recent thread — nothing else
    const proj = (await pool.query(
      `select brief, status, params->'site'->'pages' as pages, params->>'archetype' as archetype, params->>'slug' as slug from projects where id=$1`,
      [sess.project_id])).rows[0];
    const recent = (await pool.query('select role, body from chat_messages where session_id=$1 order by id desc limit 8', [sess.id])).rows.reverse();
    const facts = proj ? [
      `brief: ${proj.brief}`,
      `status: ${proj.status}`,
      `kind: ${proj.archetype || 'site'}`,
      proj.slug ? `live at: https://${proj.slug}.naples.agency (Android app at /app.apk, build record at /how-it-was-built.html)` : '',
      Array.isArray(proj.pages) ? `pages: ${proj.pages.map((p: any) => p.title).join(', ')}` : '',
    ].filter(Boolean).join('\n') : 'project not found';
    const system = `You are Relay, an autonomous web agency. The user is the client of ONE project. Answer briefly and concretely from the FACTS below — never invent features or promises. If they want something changed, tell them to say the change plainly (e.g. "change: make the hero photo darker") and it will rebuild automatically. FACTS:\n${facts}`;
    const thread = recent.map((m: any) => `${m.role === 'user' ? 'Client' : 'Relay'}: ${m.body}`).join('\n');
    reply = await (hooks.answer || defaultAnswer)(system, thread || body);
  }
  await pool.query("insert into chat_messages(session_id, role, body) values ($1,'relay',$2)", [sess.id, reply.slice(0, 4000)]);
  return { ok: true, reply, rebuilding };
}

// after a chat-triggered rebuild, the SESSION hears the outcome — the client shouldn't have
// to poll the Build tab. Fire-and-forget; intervals injectable so the gate can run it fast.
export async function announceWhenDone(
  pool: pg.Pool, sessionId: string, projectId: string,
  opts: { intervalMs?: number; deadlineMs?: number } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? 30_000;
  const deadline = Date.now() + (opts.deadlineMs ?? 30 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    try {
      const p = (await pool.query(
        `select p.status, p.params->>'slug' as slug,
           (select d.passed from dogfood_reviews d where d.project_id=$1 order by d.id desc limit 1) as passed,
           (select count(*)::int from tasks where project_id=$1 and status in ('ready','running','verifying')) as active
         from projects p where p.id=$1`, [projectId])).rows[0];
      if (!p) return;
      if (p.status === 'done' && Number(p.active) === 0 && p.passed !== null) {
        const url = p.slug ? `https://${p.slug}.naples.agency/` : '';
        const body = p.passed
          ? `✅ Done — your change is live${url ? ` at ${url}` : ''}. The independent review passed again.`
          : `⚠️ The rebuild finished but the review flagged issues — I'm keeping the previous quality bar in mind. Check the Build tab or tell me what looks off.`;
        await pool.query("insert into chat_messages(session_id, role, body) values ($1,'relay',$2)", [sessionId, body]);
        return;
      }
      if (p.status === 'blocked') {
        await pool.query("insert into chat_messages(session_id, role, body) values ($1,'relay',$2)", [sessionId, '⚠️ The rebuild could not finish — the operator has been alerted and your DATA is safe. Try rephrasing the change, or ask me what happened.']);
        return;
      }
    } catch { /* transient poll error — keep waiting */ }
  }
  await pool.query("insert into chat_messages(session_id, role, body) values ($1,'relay',$2)", [sessionId, '⏱ The rebuild is taking longer than usual — check the Build tab for live progress.']).catch(() => {});
}

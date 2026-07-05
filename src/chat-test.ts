// chat:check — PROJECT CHAT, multi-session. Real DB, scratch users, injected hooks (no LLM,
// no network). Pins: sessions are per-user (a session id alone is NEVER enough), a user holds
// MANY sessions, change-intent fires the rebuild hook exactly once, plain questions get the
// grounded answer path, the first message titles the session, cascade delete leaves no orphans.
import { randomUUID } from 'node:crypto';
import { makePool } from './db.ts';
import { ensureChatTables, listSessions, createSession, sessionOf, listMessages, postMessage, CHANGE_INTENT, wantsRebuild, announceWhenDone } from './chat.ts';

const pool = makePool();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra); }
};

const projA = randomUUID(), userA = randomUUID(), userB = randomUUID();
try {
  await ensureChatTables(pool);
  await pool.query(`insert into projects(id, brief, status, params) values ($1,'a barbershop for chat-check','done','{"archetype":"app","slug":"chat-scratch"}')`, [projA]);

  // multi-session per user
  const s1 = await createSession(pool, projA, userA);
  const s2 = await createSession(pool, projA, userA);
  ok('a user can hold MANY sessions on one project', s1.id !== s2.id && (await listSessions(pool, projA, userA)).length === 2);

  // isolation: another user sees nothing and cannot read the session
  ok('sessions are invisible to other users', (await listSessions(pool, projA, userB)).length === 0);
  ok('a session id alone is never enough (ownership scoped)', (await sessionOf(pool, s1.id, userB)) === null && (await sessionOf(pool, s1.id, userA)) !== null);

  // change-intent → the rebuild hook fires exactly once; the reply says so
  let rebuilds: string[] = [];
  const hooks = {
    rebuild: async (pid: string, txt: string) => { rebuilds.push(pid + '|' + txt); return { started: true }; },
    answer: async (_sys: string, _u: string) => 'grounded answer (stub)',
  };
  const r1 = await postMessage(pool, { sessionId: s1.id, userId: userA, body: 'change: make the hero photo darker' }, hooks);
  ok('change-intent fires the rebuild machinery exactly once', r1.ok === true && r1.rebuilding === true && rebuilds.length === 1 && rebuilds[0].startsWith(projA));
  ok('the reply tells the client what happens (data survives, watch the build)', /rebuild/i.test(String(r1.reply)) && /data.*survive/i.test(String(r1.reply)));

  // plain question → the answer path, NOT the rebuild
  const r2 = await postMessage(pool, { sessionId: s1.id, userId: userA, body: 'what pages does my site have?' }, hooks);
  ok('a plain question gets the grounded answer, never a rebuild', r2.ok === true && r2.rebuilding === false && r2.reply === 'grounded answer (stub)' && rebuilds.length === 1);

  // titling + thread shape
  ok('the first message titles the session', (await sessionOf(pool, s1.id, userA))!.title.startsWith('change: make the hero'));
  const msgs = await listMessages(pool, s1.id);
  ok('the thread alternates user/relay and persists', msgs.length === 4 && msgs[0].role === 'user' && msgs[1].role === 'relay' && msgs[3].role === 'relay');

  // a stranger's post is rejected before anything is written
  const r3 = await postMessage(pool, { sessionId: s1.id, userId: userB, body: 'change: delete everything' }, hooks);
  ok('a stranger cannot post into the session (and no rebuild fires)', r3.ok === false && rebuilds.length === 1 && (await listMessages(pool, s1.id)).length === 4);

  // intent detector sanity across locales
  ok('intent: Italian/French change verbs count', CHANGE_INTENT.test('aggiungi una pagina menu') && CHANGE_INTENT.test('ajoute une page contact'));
  ok('intent: questions do not', !CHANGE_INTENT.test('how many bookings do I have?') && !CHANGE_INTENT.test('quanto costa?'));
  // wantsRebuild is the ACTUAL gate on the destructive path — a question that merely CONTAINS a change
  // verb must NOT sweep the live site (adversarial audit 2026-07-05). Imperatives still fire.
  ok('rebuild: an imperative change fires ("add a menu page")', wantsRebuild('add a menu page') === true);
  ok('rebuild: an explicit "change:" prefix always fires', wantsRebuild('change: make the hero darker') === true);
  ok('rebuild: a QUESTION with a change verb does NOT ("should we add a booking form?")', wantsRebuild('should we add a booking form?') === false);
  ok('rebuild: a hypothetical does NOT ("what would it take to change the colors?")', wantsRebuild('what would it take to change the colors?') === false);
  ok('rebuild: an Italian imperative fires, an Italian question does not', wantsRebuild('aggiungi una pagina menu') === true && wantsRebuild('puoi aggiungere una pagina contatti?') === false);
  const chatSrc = (await import('node:fs')).readFileSync(new URL('./chat.ts', import.meta.url), 'utf8');
  ok('chat: postMessage routes the destructive path through wantsRebuild (not the raw regex)', /if \(wantsRebuild\(body\)\)/.test(chatSrc));

  // the rebuild ANNOUNCES its outcome into the session (fast injected poll; project is 'done'+reviewed)
  await pool.query(`insert into dogfood_reviews(project_id, passed, summary, issues) values ($1, true, 'ok', '[]')`, [projA]);
  const s3 = await createSession(pool, projA, userA);
  await announceWhenDone(pool, s3.id, projA, { intervalMs: 50, deadlineMs: 3000 });
  const ann = await listMessages(pool, s3.id);
  ok('a finished rebuild announces itself into the session (live url included)', ann.length === 1 && ann[0].role === 'relay' && /✅/.test(ann[0].body) && ann[0].body.includes('chat-scratch.naples.agency'), JSON.stringify(ann.map((m: any) => m.body.slice(0, 60))));
  await pool.query('delete from dogfood_reviews where project_id=$1', [projA]);
  const serverSrc2 = (await import('node:fs')).readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  ok('server: the chat rebuild hook wires the announcement', serverSrc2.includes('announceWhenDone(pool, sidQ, projectId)'));
  const css = (await import('node:fs')).readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  ok('chat is phone-first (session list stacks under 720px)', css.includes('.chatwrap') && css.includes('max-width: 720px'));

  // cascade: deleting a session leaves no orphan messages
  await pool.query('delete from chat_sessions where id=$1', [s1.id]);
  ok('deleting a session cascades its messages', Number((await pool.query('select count(*)::int n from chat_messages where session_id=$1', [s1.id])).rows[0].n) === 0);

  // the server routes exist and are auth-gated (source pins)
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  ok('server: chat routes demand a signed-in user + project visibility', server.includes("'/api/chat/sessions'") && server.includes("'/api/chat/messages'") && /chat\/sessions'[\s\S]{0,200}sign in to chat/.test(server) && /chat\/sessions'[\s\S]{0,400}canSee/.test(server));
  ok('server: chat posting is rate-capped', server.includes('CHAT_HITS'));
  const appjs = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  ok('board: the Chat tab exists with sessions + composer', appjs.includes("tabLink(id,'chat','Chat',tab)") && appjs.includes('newsess') && appjs.includes('chatform'));
} finally {
  await pool.query('delete from chat_sessions where project_id=$1', [projA]).catch(() => {});
  await pool.query('delete from projects where id=$1', [projA]).catch(() => {});
  await pool.end();
}

console.log(`\nchat:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

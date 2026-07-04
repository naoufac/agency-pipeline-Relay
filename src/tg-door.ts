import pg from 'pg';
import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { plan, replan } from './planner.ts';
import { runLoop } from './runner.ts';
import { SITES } from './verify.ts';

const TOKEN = process.env.TG_DOOR_TOKEN;
const ALLOWLIST = new Set(
  (process.env.TG_DOOR_CHAT || '').split(',').map((s) => s.trim()).filter(Boolean)
);
const MAX_ACTIVE = 6;
const BASE_URL = process.env.PUBLIC_URL || 'https://board.naples.agency';

const tgUrl = (method: string) => `https://api.telegram.org/bot${TOKEN}/${method}`;
const short = (id: string) => id.slice(0, 8);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function tgPost(method: string, body: object): Promise<any> {
  const r = await fetch(tgUrl(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function reply(chatId: string, text: string) {
  await tgPost('sendMessage', { chat_id: chatId, text }).catch(() => {});
}

async function activeCount(pool: pg.Pool): Promise<number> {
  const r = await pool.query(
    "select count(distinct project_id)::int n from tasks where status in ('ready','running','verifying')"
  );
  return r.rows[0]?.n ?? 0;
}

async function watchUntilDone(pool: pg.Pool, chatId: string, id: string, brief: string) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(30_000);
    try {
      const r = await pool.query(
        `select p.status,
          (select d.passed from dogfood_reviews d where d.project_id=p.id order by d.id desc limit 1) as review_passed
         from projects p where p.id=$1`,
        [id]
      );
      const row = r.rows[0];
      if (!row || !['done', 'blocked'].includes(row.status)) continue;
      const emoji = row.status === 'done' ? '✅' : '⚠️';
      const rv = row.review_passed === true ? ' · review ✓' : row.review_passed === false ? ' · review ✗' : '';
      const url = row.status === 'done' ? `\n${BASE_URL}/sites/${id}/` : '';
      await reply(chatId, `${emoji} ${row.status}: ${brief} · id ${short(id)}${rv}${url}`);
      return;
    } catch {
      // transient DB error — keep polling
    }
  }
  await reply(chatId, `⏱ Timed out waiting for ${short(id)} (30 min)`);
}

async function handleStatus(pool: pg.Pool, chatId: string) {
  const r = await pool.query(
    `select p.id, p.status,
      (select d.passed from dogfood_reviews d where d.project_id=p.id order by d.id desc limit 1) as review_passed
     from projects p order by p.created_at desc limit 3`
  );
  if (!r.rows.length) { await reply(chatId, 'No projects yet.'); return; }
  const lines = r.rows.map((row: any) => {
    const rv = row.review_passed === true ? '· review ✓' : row.review_passed === false ? '· review ✗' : '';
    return `${short(row.id)} · ${row.status}${rv ? ' ' + rv : ''}`;
  });
  await reply(chatId, lines.join('\n'));
}

async function poll(pool: pg.Pool, offset: number): Promise<number> {
  const r = await fetch(`${tgUrl('getUpdates')}?offset=${offset}&timeout=30&limit=100`);
  const data = await r.json();
  // a bad/revoked token answers instantly with ok:false — back off, never hot-loop the API
  if (!data.ok || !Array.isArray(data.result)) { await sleep(10_000); return offset; }
  for (const upd of data.result) {
    offset = Math.max(offset, upd.update_id + 1);
    const msg = upd.message;
    if (!msg?.text) continue;
    const chatId = String(msg.chat?.id);
    if (!ALLOWLIST.has(chatId)) continue;
    const text = (msg.text as string).trim();
    if (text === '/status') {
      handleStatus(pool, chatId).catch((e: any) => console.error('tg-door status', e?.message ?? e));
      continue;
    }
    // a Telegram command is never a brief — '/start' once became a real build attempt
    if (text.startsWith('/')) {
      await reply(chatId, 'Text me a brief and I build it (e.g. "a booking site for a barbershop"). Commands: /status — latest builds.');
      continue;
    }
    // ITERATION (M3 at the front door): REPLY to a build message — or write 'change <id>: …' — and
    // the SAME site rebuilds with the amendment. The schema migrates additively; the data survives.
    const repliedShort = String(msg.reply_to_message?.text || '').match(/\bid ([0-9a-f]{8})\b/i)?.[1];
    const changeM = text.match(/^(?:change|update)\s+([0-9a-f-]{8,36})\s*[:\u2014-]\s*(.+)$/is);
    if (repliedShort || changeM) {
      const short8 = (changeM ? changeM[1] : repliedShort)!.slice(0, 8).toLowerCase();
      const changeText = (changeM ? changeM[2] : text).trim();
      try {
        const pr = (await pool.query("select id, brief from projects where id::text like $1 || '%' order by created_at desc limit 1", [short8])).rows[0];
        if (!pr) { await reply(chatId, `No build found for id ${short8}.`); continue; }
        const busy = Number((await pool.query("select count(*)::int n from tasks where project_id=$1 and status in ('ready','running','verifying')", [pr.id])).rows[0].n);
        if (busy) { await reply(chatId, 'That site is still building — send the change once it finishes.'); continue; }
        const amended = `${pr.brief} · UPDATE: ${changeText}`;
        // sweep the previous generation's pages (stale slugs would mix two navigations); assets stay
        try { const dir = fileURLToPath(new URL(pr.id + '/', SITES)); for (const f of readdirSync(dir)) if (f.endsWith('.html')) rmSync(dir + '/' + f); } catch {}
        await replan(pool, pr.id, amended);
        if (process.env.RELAY_BUILD !== '0') runLoop(pool, pr.id, { cap: 4, review: true }).catch(() => {});
        await reply(chatId, `Updating ${short8} — ${changeText}\nYour existing data survives the rebuild.`);
        watchUntilDone(pool, chatId, pr.id, amended).catch(() => {});
      } catch (e: any) { console.error('tg-door change', e?.message ?? e); await reply(chatId, 'Could not start the update — please try again.'); }
      continue;
    }
    // any other text is a brief
    try {
      const active = await activeCount(pool);
      if (active >= MAX_ACTIVE) { await reply(chatId, 'At capacity, try in a few minutes.'); continue; }
      const id = await plan(pool, text);
      if (process.env.RELAY_BUILD !== '0')
        runLoop(pool, id, { cap: 4, review: true }).catch(() => {});
      await reply(chatId, `Building: ${text} · id ${short(id)}`);
      const pr = await pool.query('select params from projects where id=$1', [id]);
      const sc = pr.rows[0]?.params?.scope as { includes?: {promise:string}[]; excludes?: {ask:string;alternative:string}[] } | undefined;
      if (sc?.includes?.length) {
        await reply(chatId, `Scope: ${sc.includes.map(i => i.promise).join(' · ')}`);
        if (sc.excludes?.length)
          await reply(chatId, `Not included: ${sc.excludes.map(e => `${e.ask} — ${e.alternative}`).join('; ')}`);
      }
      watchUntilDone(pool, chatId, id, text).catch((e: any) => console.error('tg-door watch', e?.message ?? e));
    } catch (e: any) {
      console.error('tg-door build', e?.message ?? e);
      await reply(chatId, 'Failed to start build — check server logs.');
    }
  }
  return offset;
}

export function startTgDoor(pool: pg.Pool): void {
  if (!TOKEN || !ALLOWLIST.size) {
    console.log('tg-door: TG_DOOR_TOKEN / TG_DOOR_CHAT not set — Telegram front door inactive');
    return;
  }
  let offset = 0;
  (async () => {
    console.log('tg-door: listening');
    for (;;) {
      try {
        offset = await poll(pool, offset);
      } catch (e: any) {
        console.error('tg-door poll error', e?.message ?? e);
        await sleep(10_000);
      }
    }
  })();
}

import pg from 'pg';
import { plan } from './planner.ts';
import { runLoop } from './runner.ts';

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
    // any other text is a brief
    try {
      const active = await activeCount(pool);
      if (active >= MAX_ACTIVE) { await reply(chatId, 'At capacity, try in a few minutes.'); continue; }
      const id = await plan(pool, text);
      if (process.env.RELAY_BUILD !== '0')
        runLoop(pool, id, { cap: 4, review: true }).catch(() => {});
      await reply(chatId, `Building: ${text} · id ${short(id)}`);
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

// App builder — data / auth / API / UI. Not a website wearing JSON.
// Prove the schema exists, REST is live, UI fetches /api/app. Never call render.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Builder, BuildCtx } from './types.ts';
import * as appdb from '../appdb.ts';
import { handleAppApi } from '../app/api.ts';

export type AppProof = {
  ok: boolean;
  log: string;
  tables?: string[];
  ui?: string;
  api?: string;
};

export async function proveApp(pool: any, projectId: string, destDir?: string): Promise<AppProof> {
  if (process.env.RELAY_APP_API !== '1') {
    return { ok: false, log: 'app: RELAY_APP_API unset — fullstack_app cannot ship an API' };
  }
  let tables: string[] = [];
  try {
    tables = await appdb.listTables(pool, projectId);
  } catch (e: any) {
    return { ok: false, log: 'app: schema missing — ' + String(e?.message ?? e).slice(0, 160) };
  }
  if (!tables.length) return { ok: false, log: 'app: no tables in project schema' };

  const url = new URL(`http://relay.local/api/app/${projectId}/ui`);
  let ui: { status: number; contentType: string; body: string } | null = null;
  try {
    const r = await handleAppApi(pool, projectId, 'ui', null, { method: 'GET', url, body: '' }, 'public');
    ui = r as any;
  } catch (e: any) {
    return { ok: false, log: 'app: UI render failed — ' + String(e?.message ?? e).slice(0, 160) };
  }
  if (!ui || ui.status !== 200) return { ok: false, log: `app: UI status ${ui?.status ?? 'null'}` };
  if (!(ui.contentType || '').includes('text/html')) return { ok: false, log: 'app: UI is not HTML' };
  if (!ui.body.includes('/api/app')) return { ok: false, log: 'app: UI does not call /api/app' };
  if (ui.body.includes('<!--relay:rendered-->') || ui.body.includes('<!--relay:astro-->')) {
    return { ok: false, log: 'app: UI is a website costume — expected app UI, not a rendered site' };
  }

  const api = `/api/app/${projectId}`;
  if (destDir) {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'app.json'), JSON.stringify({ tables, api, ui: `${api}/ui` }, null, 2));
  }
  await pool.query(
    "update projects set params = jsonb_set(params, '{app_built}', $2::jsonb, true) where id=$1",
    [projectId, JSON.stringify({ ok: true, tables, api, ui: `${api}/ui` })],
  );
  return { ok: true, log: `app: ${tables.length} table(s) · REST ${api} · UI ${api}/ui`, tables, ui: `${api}/ui`, api };
}

export const appBuilder: Builder = {
  id: 'app',
  async finalize(pool, projectId, ctx: BuildCtx) {
    const dest = join(ctx.sitesDir, projectId);
    return proveApp(pool, projectId, dest);
  },
};

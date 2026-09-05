// Campaign builder — email + social assets pack. Not a website wearing JSON.
// Never call render.ts. A website-shaped payload (hero/pages/cms) fails closed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Builder, BuildCtx } from './types.ts';

export type CampaignProof = { ok: boolean; log: string; emails?: number; social?: number };

function firstJson(s: string): any {
  const t = String(s || '').replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  for (const open of ['{', '['] as const) {
    const start = t.indexOf(open); if (start < 0) continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === open) depth++;
      else if (t[i] === close) { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { break; } } }
    }
  }
  return undefined;
}

export function proveCampaignPack(content: string): { ok: boolean; log: string; pack?: any; emails?: number; social?: number } {
  const obj = firstJson(content);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, log: 'campaign: not a JSON object' };
  if (obj.pages || obj.sections || obj.hero || obj.cms || obj.nav) {
    return { ok: false, log: 'campaign: website-shaped payload rejected (no hero, no CMS, no pages)' };
  }
  const emailRaw = obj.email || obj.emails || obj.newsletter || obj.newsletters;
  const socialRaw = obj.social || obj.posts || obj.ads || obj.creatives;
  if (!emailRaw) return { ok: false, log: 'campaign: missing email/newsletter asset' };
  if (!socialRaw) return { ok: false, log: 'campaign: missing social/ad assets' };
  const emails = Array.isArray(emailRaw) ? emailRaw : [emailRaw];
  const posts = Array.isArray(socialRaw) ? socialRaw : [socialRaw];
  if (!emails.length) return { ok: false, log: 'campaign: empty email' };
  if (!posts.length) return { ok: false, log: 'campaign: empty social' };
  const e0 = emails[0];
  if (!e0 || typeof e0 !== 'object' || !(e0.subject || e0.title) || !(e0.body || e0.html || e0.text)) {
    return { ok: false, log: 'campaign: email needs subject + body' };
  }
  const p0 = posts[0];
  if (!p0 || typeof p0 !== 'object' || !(p0.copy || p0.caption || p0.text || p0.body)) {
    return { ok: false, log: 'campaign: social needs copy' };
  }
  return { ok: true, log: `campaign: ${emails.length} email(s) · ${posts.length} social`, pack: obj, emails: emails.length, social: posts.length };
}

export async function proveCampaign(pool: any, projectId: string, destDir?: string): Promise<CampaignProof> {
  const r = await pool.query(
    `select o.content from tasks t
       join task_outputs o on o.task_id=t.id and o.is_current
      where t.project_id=$1 and t.department='content' and t.status='done'
      order by t.seq desc limit 1`,
    [projectId],
  );
  const content = String(r.rows[0]?.content || '');
  const proof = proveCampaignPack(content);
  if (!proof.ok) return { ok: false, log: proof.log };
  if (destDir) {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'campaign.json'), JSON.stringify(proof.pack, null, 2));
  }
  await pool.query(
    "update projects set params = jsonb_set(params, '{campaign_built}', $2::jsonb, true) where id=$1",
    [projectId, JSON.stringify({ ok: true, emails: proof.emails, social: proof.social })],
  );
  return { ok: true, log: proof.log, emails: proof.emails, social: proof.social };
}

export const campaignBuilder: Builder = {
  id: 'campaign',
  async finalize(pool, projectId, ctx: BuildCtx) {
    const dest = join(ctx.sitesDir, projectId);
    return proveCampaign(pool, projectId, dest);
  },
};

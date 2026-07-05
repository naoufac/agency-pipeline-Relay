// ANDROID v1 — every produced site becomes an installable, signed Android app (TWA).
// The subdomain is the app's origin; the PWA manifest painted at build time is the single
// source of name/colors/icons (CMS-first: ONE base model, projected — never re-invented here).
// Everything an APK needs is derived deterministically from real produced output:
//   packageId  ← slug            (agency.naples.<slug>, Java-package-safe)
//   twa-manifest ← manifest.webmanifest + slug
//   assetlinks  ← packageId + the relay signing key's SHA-256
// Bubblewrap/gradle only executes what these generators decide — no LLM anywhere.
import pg from 'pg';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const KEYSTORE = process.env.RELAY_KS_PATH || '/root/relay-android.keystore';
export const KS_ALIAS = 'relay';

// the slug IS the app's identity (host, packageId, build path) — anything that is not a
// clean lowercase DNS label stops HERE, before it can mint a divergent or traversing identity
export function assertCleanSlug(slug: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(String(slug || ''))) throw new Error('slug is not a clean DNS label: ' + JSON.stringify(slug));
  return slug;
}

// a Java package segment must be [A-Za-z_][A-Za-z0-9_]* — slugs are DNS labels, so the only
// repairs are dash→underscore and a leading digit (java forbids it, DNS allows it)
export function packageIdFor(slug: string): string {
  const seg = String(slug || '').toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!seg) throw new Error('packageIdFor: empty slug');
  return 'agency.naples.' + (/^[0-9]/.test(seg) ? 'a' + seg : seg);
}

// the exact JSON Android's verifier fetches from https://<host>/.well-known/assetlinks.json —
// when it matches the APK's signature, the app opens fullscreen (no browser chrome)
export function assetlinksFor(packageId: string, sha256: string): object[] {
  if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(sha256)) throw new Error('assetlinksFor: bad SHA-256 fingerprint');
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: packageId, sha256_cert_fingerprints: [sha256] },
  }];
}

// bubblewrap's twa-manifest.json, filled ONLY from the site's own webmanifest + slug
export function twaManifestFor(slug: string, webmanifest: any, versionCode = 1): any {
  const host = `${assertCleanSlug(slug)}.naples.agency`;
  const name = String(webmanifest?.name || slug).slice(0, 50);
  const launcher = String(webmanifest?.short_name || name).slice(0, 30);
  const theme = String(webmanifest?.theme_color || '#1a1a1a');
  const bg = String(webmanifest?.background_color || '#ffffff');
  return {
    packageId: packageIdFor(slug),
    host,
    name,
    launcherName: launcher,
    display: 'standalone',
    themeColor: theme,
    navigationColor: theme,
    navigationColorDark: theme,
    navigationDividerColor: theme,
    navigationDividerColorDark: theme,
    backgroundColor: bg,
    enableNotifications: false,
    startUrl: '/',
    iconUrl: `https://${host}/icon-512.png`,
    maskableIconUrl: `https://${host}/icon-512.png`,
    splashScreenFadeOutDuration: 300,
    signingKey: { path: KEYSTORE, alias: KS_ALIAS },
    // bubblewrap's JSON field is appVersion (TwaManifest maps appVersion -> versionName);
    // 'appVersionName' here is silently ignored and ships versionName "" — Play rejects that.
    // versionCode INCREMENTS per packaging: Android only updates an installed app when the
    // new code is HIGHER — a constant 1 froze every install on its first version forever.
    appVersion: `1.0.${Math.max(1, Math.floor(versionCode))}`,
    appVersionCode: Math.max(1, Math.floor(versionCode)),
    shortcuts: [],
    generatorApp: 'relay',
    webManifestUrl: `https://${host}/manifest.webmanifest`,
    fallbackType: 'customtabs',
    features: {},
    alphaDependencies: { enabled: false },
    enableSiteSettingsShortcut: true,
    isChromeOSOnly: false,
    isMetaQuest: false,
    fullScopeUrl: `https://${host}/`,
    minSdkVersion: 21,
    orientation: 'default',
    fingerprints: [],
    additionalTrustedOrigins: [],
    retainedBundles: [],
  };
}

// the signing cert's SHA-256, straight from the keystore — assetlinks must NEVER be written
// from anything else (a hand-typed fingerprint is exactly the class of lie this forbids)
export function keystoreSha256(storepass: string): string {
  // -storepass:env — the password must NEVER ride argv: /proc/*/cmdline is world-readable and
  // execFileSync puts the full argv into e.message on failure, which the CLI would then log
  const out = execFileSync('keytool', ['-list', '-v', '-keystore', KEYSTORE, '-alias', KS_ALIAS, '-storepass:env', 'RELAY_KT_PASS'], { encoding: 'utf8', env: { ...process.env, RELAY_KT_PASS: storepass } });
  const m = out.match(/SHA256:\s*([0-9A-F:]{95})/);
  if (!m) throw new Error('keystoreSha256: fingerprint not found in keytool output');
  return m[1];
}

export async function buildApk(pool: pg.Pool, projectId: string, sitesUrl: URL): Promise<{ apk: string; packageId: string; sha256: string; slug: string }> {
  const pass = process.env.RELAY_KS_PASS;
  if (!pass) throw new Error('RELAY_KS_PASS not set');
  if (!existsSync(KEYSTORE)) throw new Error('signing keystore missing at ' + KEYSTORE + ' — without it bubblewrap would PROMPT to create a new (wrong) identity');
  // ATOMIC increment RETURNING the new value — two builds racing (worker + owner click, canary +
  // auto-hook) across PROCESSES can't both read the same v and stamp a duplicate versionCode
  // (Android refuses an update with an equal code). Reserved up front; a failed build leaves a
  // harmless gap (gaps update fine; collisions don't).
  const row = (await pool.query(
    "update projects set params = jsonb_set(params, '{apk_version}', to_jsonb(coalesce((params->>'apk_version')::int,0)+1), true) where id=$1 returning params->>'slug' as slug, (params->>'apk_version')::int as v",
    [projectId])).rows[0];
  const slug = row?.slug;
  if (!slug) throw new Error('project has no slug — subdomain identity is the APK origin');
  const versionCode = Number(row.v);
  assertCleanSlug(slug);
  const siteDir = fileURLToPath(new URL(projectId + '/', sitesUrl));
  if (!existsSync(siteDir + 'manifest.webmanifest'))
    throw new Error('site predates the PWA base (no manifest.webmanifest) — rebuild the site first, then package it');
  const wm = JSON.parse(readFileSync(siteDir + 'manifest.webmanifest', 'utf8'));

  const work = `/root/apk-builds/${slug}`;
  mkdirSync(work, { recursive: true });
  writeFileSync(work + '/twa-manifest.json', JSON.stringify(twaManifestFor(slug, wm, versionCode), null, 2));
  const env = { ...process.env, BUBBLEWRAP_KEYSTORE_PASSWORD: pass, BUBBLEWRAP_KEY_PASSWORD: pass, CI: 'true' };
  // update regenerates the Android project from twa-manifest.json (build alone PROMPTS
  // about a missing checksum on a fresh project — headless means no prompts, ever)
  execFileSync('bubblewrap', ['update', '--skipVersionUpgrade'], { cwd: work, stdio: ['ignore', 'inherit', 'inherit'], env, timeout: 5 * 60_000 });
  execFileSync('bubblewrap', ['build', '--skipPwaValidation'], { cwd: work, stdio: ['ignore', 'inherit', 'inherit'], env, timeout: 15 * 60_000 });
  const built = work + '/app-release-signed.apk';
  if (!existsSync(built)) throw new Error('bubblewrap finished but no signed APK at ' + built);

  const sha = keystoreSha256(pass);
  const pkg = packageIdFor(slug);
  mkdirSync(siteDir + '.well-known', { recursive: true });
  writeFileSync(siteDir + '.well-known/assetlinks.json', JSON.stringify(assetlinksFor(pkg, sha), null, 1));
  copyFileSync(built, siteDir + 'app.apk');
  return { apk: siteDir + 'app.apk', packageId: pkg, sha256: sha, slug };
}

// ---- the product surface: packaging as a board action AND a default build step ----
// ONE gradle at a time (it eats a core and real memory); everything else waits in a FIFO.
// The queue serves both the board button and the runner's auto-package hook; its cap is
// the abuse ceiling on the public board.
const QUEUE_CAP = 8;
const queue: Array<{ pool: pg.Pool; projectId: string }> = [];
let running: string | null = null;
export function apkInFlight(projectId: string): boolean { return running === projectId || queue.some((q) => q.projectId === projectId); }

export async function apkStatus(pool: pg.Pool, projectId: string, sitesUrl: URL): Promise<{ apk: boolean; building: boolean; url: string | null }> {
  const has = existsSync(fileURLToPath(new URL(projectId + '/app.apk', sitesUrl)));
  let url: string | null = null;
  if (has) {
    const slug = (await pool.query("select params->>'slug' as slug from projects where id=$1", [projectId])).rows[0]?.slug;
    url = slug ? `https://${slug}.naples.agency/app.apk` : `/sites/${projectId}/app.apk`;
  }
  return { apk: has, building: apkInFlight(projectId), url };
}

// spawns the CLI in a child process — buildApk itself is execFileSync-based and would
// freeze the whole server's event loop for the length of a gradle run.
// launchFn is injectable ONLY so the gate suite can observe queue behavior without spawning.
export function packageProjectAsync(pool: pg.Pool, projectId: string, launchFn: (pool: pg.Pool, projectId: string) => void = launchPackager): { started: boolean; queued?: boolean; error?: string } {
  if (apkInFlight(projectId)) return { started: true, queued: running !== projectId };
  if (!process.env.RELAY_KS_PASS) return { started: false, error: 'signing is not configured on this server' };
  if (!existsSync(KEYSTORE)) return { started: false, error: 'signing keystore missing on this server' };
  if (running) {
    if (queue.length >= QUEUE_CAP) return { started: false, error: 'packaging queue is full — try again later' };
    queue.push({ pool, projectId });
    return { started: true, queued: true };
  }
  running = projectId;
  launchFn(pool, projectId);
  return { started: true };
}

// test-only: reset the queue state so gates can exercise it in isolation
export function _resetApkQueue(): void { queue.length = 0; running = null; }

function launchPackager(pool: pg.Pool, projectId: string): void {
  const jdk = process.env.RELAY_JDK_HOME || '/usr/lib/jvm/java-17-openjdk-amd64';
  const child = spawn('npx', ['tsx', 'src/apk.ts', projectId], {
    cwd: process.cwd(),
    env: { ...process.env, JAVA_HOME: jdk, PATH: `${process.env.PATH || ''}:${jdk}/bin` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (c) => out += c);
  child.stderr!.on('data', (c) => out += c);
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 25 * 60_000);
  const finish = async (code: number | null) => {
    clearTimeout(killer);
    // the whole body is guarded: a throw here (a failed db import, a dead pool) must NEVER strand
    // `running` — that would freeze the packaging queue for the life of the process.
    try {
      const tail = out.trim().split('\n').slice(-3).join(' · ').slice(0, 400);
      const { ev } = await import('./db.ts');
      await ev(pool, projectId, null, code === 0 ? 'apk_built' : 'apk_failed', tail).catch(() => {});
      if (code !== 0) console.error('apk package failed', projectId, tail);
    } catch (e: any) { console.error('apk finish', projectId, e?.message ?? e); }
    running = null;
    const next = queue.shift();
    if (next) { running = next.projectId; launchPackager(next.pool, next.projectId); }
  };
  child.on('close', finish);
  child.on('error', (e) => { out += String(e?.message ?? e); finish(1); });
}

// CLI: npm run -s apk -- <projectId>
if (process.argv[1] && process.argv[1].endsWith('apk.ts')) {
  const id = process.argv[2];
  if (!/^[0-9a-f-]{36}$/.test(id || '')) { console.error('usage: tsx src/apk.ts <projectId>'); process.exit(2); }
  const { makePool } = await import('./db.ts');
  const { SITES } = await import('./verify.ts');
  const pool = makePool();
  try {
    const r = await buildApk(pool, id, SITES);
    console.log(`APK ready: ${r.apk}\npackage ${r.packageId}\nsha256 ${r.sha256}\nhttps://${r.slug}.naples.agency/app.apk`);
    process.exit(0);
  } catch (e: any) {
    // belt-and-braces: no error path may echo the keystore password into logs
    const redact = (m: string) => process.env.RELAY_KS_PASS ? m.split(process.env.RELAY_KS_PASS).join('***') : m;
    console.error('apk build failed:', redact(String(e?.message ?? e)));
    process.exit(1);
  }
}

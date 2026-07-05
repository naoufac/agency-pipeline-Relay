// apk:check — the Android identity is DERIVED, never hand-typed. These gates pin the
// derivations (slug→packageId, webmanifest→twa-manifest, keystore→assetlinks) so a drift
// in any of them fails the suite before an APK with a broken identity can ever be signed.
import { packageIdFor, twaManifestFor, assetlinksFor, assertCleanSlug, apkStatus, packageProjectAsync, _resetApkQueue, apkInFlight } from './apk.ts';
import { SECTIONS } from './components.ts';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra); }
};

// ---- packageId: Java-package-safe, deterministic ----
ok('packageId: dashes become underscores', packageIdFor('la-favorita-taqueria') === 'agency.naples.la_favorita_taqueria');
ok('packageId: digit-leading slug gets a letter prefix (java forbids leading digits)', packageIdFor('7eleven-clone') === 'agency.naples.a7eleven_clone');
ok('packageId: every segment is a valid java identifier', /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/.test(packageIdFor('meridian-2')));
ok('packageId: empty slug throws (an APK without identity must never build)', (() => { try { packageIdFor(''); return false; } catch { return true; } })());

// ---- twa-manifest: filled ONLY from the site's own webmanifest + slug ----
const wm = { name: 'La Favorita Taqueria', short_name: 'La Favorita', theme_color: '#6b6b23', background_color: '#faf6ee' };
const twa = twaManifestFor('la-favorita-taqueria', wm);
ok('twa: host is the site subdomain', twa.host === 'la-favorita-taqueria.naples.agency');
ok('twa: name/launcher come from the webmanifest', twa.name === 'La Favorita Taqueria' && twa.launcherName === 'La Favorita');
ok('twa: theme/background colors come from the webmanifest', twa.themeColor === '#6b6b23' && twa.backgroundColor === '#faf6ee');
ok('twa: icon + webmanifest URLs are https on the subdomain', twa.iconUrl === 'https://la-favorita-taqueria.naples.agency/icon-512.png' && twa.webManifestUrl.startsWith('https://la-favorita-taqueria.naples.agency/'));
ok('twa: launcherName capped at 30 chars (Play requirement)', twaManifestFor('x', { short_name: 'y'.repeat(60) }).launcherName.length <= 30);
ok('twa: name capped at 50 chars', twaManifestFor('x', { name: 'y'.repeat(90) }).name.length <= 50);
ok('twa: notifications off, customtabs fallback, packageId matches slug', twa.enableNotifications === false && twa.fallbackType === 'customtabs' && twa.packageId === packageIdFor('la-favorita-taqueria'));
ok('twa: missing webmanifest fields fall back sanely, never crash', (() => { const t = twaManifestFor('bare', {}); return t.name === 'bare' && /^#/.test(t.themeColor) && /^#/.test(t.backgroundColor); })());

// ---- assetlinks: the exact shape Android's verifier fetches ----
const SHA = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
const al: any = assetlinksFor('agency.naples.demo', SHA);
ok('assetlinks: single statement, handle_all_urls relation', Array.isArray(al) && al.length === 1 && al[0].relation[0] === 'delegate_permission/common.handle_all_urls');
ok('assetlinks: android_app namespace + package + fingerprint', al[0].target.namespace === 'android_app' && al[0].target.package_name === 'agency.naples.demo' && al[0].target.sha256_cert_fingerprints[0] === SHA);
ok('assetlinks: malformed fingerprint throws (never publish a broken identity)', (() => { try { assetlinksFor('agency.naples.demo', 'AA:BB'); return false; } catch { return true; } })());

// ---- slug guard: the identity can only be minted from a clean DNS label ----
ok('slug guard: clean label passes through', assertCleanSlug('la-favorita-taqueria') === 'la-favorita-taqueria');
ok('slug guard: path traversal throws', (() => { try { assertCleanSlug('../../etc'); return false; } catch { return true; } })());
ok('slug guard: uppercase throws (Android host match is case-sensitive)', (() => { try { assertCleanSlug('Evil'); return false; } catch { return true; } })());
ok('slug guard: 64+ char label throws (DNS limit)', (() => { try { assertCleanSlug('a'.repeat(64)); return false; } catch { return true; } })());
ok('twa: dirty slug cannot mint a manifest', (() => { try { twaManifestFor('../evil', {}); return false; } catch { return true; } })());

// ---- version identity: the field bubblewrap actually reads ----
ok('twa: appVersion is set (bubblewrap ignores appVersionName — versionName would ship empty)', twa.appVersion === '1.0.1' && twa.appVersionCode === 1);
ok('twa: versionCode is a parameter — repackaging ships a HIGHER code (Android refuses updates otherwise)', twaManifestFor('x', {}, 7).appVersionCode === 7 && twaManifestFor('x', {}, 7).appVersion === '1.0.7');
ok('twa: garbage versionCode floors to 1, never 0 or negative', twaManifestFor('x', {}, 0).appVersionCode === 1 && twaManifestFor('x', {}, -3 as any).appVersionCode === 1);
{
  const src = readFileSync(new URL('./apk.ts', import.meta.url), 'utf8');
  ok('buildApk: versionCode is an ATOMIC UPDATE ... RETURNING (no cross-process lost-update / duplicate code)', src.includes('returning params->>') && src.includes("jsonb_set(params, '{apk_version}'") && !src.includes('const versionCode = Number(row.v) + 1'));
  ok('FIFO finish() is fully guarded — a throw never strands running (queue-freeze forever)', /const finish = async[\s\S]{0,320}try \{[\s\S]{0,600}catch[\s\S]{0,220}running = null/.test(src));
}

// ---- secrets: the password never rides argv ----
const apkSrc = readFileSync(new URL('./apk.ts', import.meta.url), 'utf8');
ok('keytool gets the password via -storepass:env, never argv', apkSrc.includes("'-storepass:env'") && !apkSrc.includes("'-storepass',"));
ok('keystore preflight exists (missing keystore must never reach a bubblewrap prompt)', apkSrc.includes('existsSync(KEYSTORE)'));
ok('CLI error path redacts the keystore password', apkSrc.includes('redact'));

// ---- the surface: packaging is a product action, still invariant-guarded ----
{
  const saved = process.env.RELAY_KS_PASS;
  delete process.env.RELAY_KS_PASS;
  const r = packageProjectAsync({} as any, '00000000-0000-0000-0000-000000000000');
  ok('packaging without signing config refuses (never a half-signed app)', r.started === false && !!r.error);
  if (saved !== undefined) process.env.RELAY_KS_PASS = saved;
}
ok('apkStatus: no artifact → apk:false, no url invented', await (async () => {
  const st = await apkStatus({} as any, '00000000-0000-0000-0000-000000000000', new URL('file:///nonexistent-apk-test/'));
  return st.apk === false && st.building === false && st.url === null;
})());
{
  const withApp = SECTIONS.chain({ android: { url: 'https://demo.naples.agency/app.apk', qr: '<svg data-qr="1"></svg>' } });
  ok('chain section: android block renders link + QR when an APK exists', withApp.includes('https://demo.naples.agency/app.apk') && withApp.includes('data-qr="1"') && withApp.includes('Android app'));
  const without = SECTIONS.chain({});
  ok('chain section: NO android block without an APK (never a promise)', !without.includes('Android app (') && !without.includes('Download the app'));
}

// ---- the queue: one gradle at a time, FIFO, capped — observed via an injected launcher ----
{
  const saved = process.env.RELAY_KS_PASS;
  process.env.RELAY_KS_PASS = 'test-only';
  _resetApkQueue();
  const launched: string[] = [];
  const stub = (_p: any, id: string) => { launched.push(id); };
  const a = packageProjectAsync({} as any, '11111111-1111-1111-1111-111111111111', stub);
  const b = packageProjectAsync({} as any, '22222222-2222-2222-2222-222222222222', stub);
  const a2 = packageProjectAsync({} as any, '11111111-1111-1111-1111-111111111111', stub);
  ok('queue: first job launches immediately', a.started === true && !a.queued && launched.length === 1);
  ok('queue: second job queues behind the running one (never a parallel gradle)', b.started === true && b.queued === true && launched.length === 1);
  ok('queue: re-requesting a job already in flight is idempotent', a2.started === true && launched.length === 1);
  ok('queue: both jobs report as in-flight', apkInFlight('11111111-1111-1111-1111-111111111111') && apkInFlight('22222222-2222-2222-2222-222222222222'));
  let full = 0;
  for (let i = 0; i < 20; i++) {
    const r = packageProjectAsync({} as any, `33333333-3333-3333-3333-3333333333${String(i).padStart(2, '0')}`, stub);
    if (!r.started) full++;
  }
  ok('queue: capped — floods are refused, not accumulated', full > 0, `refused ${full}`);
  _resetApkQueue();
  if (saved !== undefined) process.env.RELAY_KS_PASS = saved; else delete process.env.RELAY_KS_PASS;
}

// ---- android by default: the runner packages every finished production build ----
{
  const runner = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8');
  ok('runner: auto-packages after done+review (RELAY_APK_AUTO gate)', runner.includes('packageProjectAsync') && runner.includes('RELAY_APK_AUTO'));
  const canary = readFileSync(new URL('./canary.ts', import.meta.url), 'utf8');
  ok('canary: asserts apk_built + serves /app.apk on the subdomain', canary.includes("type='apk_built'") && canary.includes("path: '/app.apk'"));
  ok('canary: sweeps old packaging workdirs', canary.includes('/root/apk-builds/'));
  ok('canary: iteration leg — rebuild via the public API, data-survival + identity + re-review', canary.includes('/api/rebuild') && canary.includes('appRowCount') && canary.includes('data LOST') && canary.includes('identity changed'));
  const plannerSrc = readFileSync(new URL('./planner.ts', import.meta.url), 'utf8');
  ok('replan carries the slug forward (a rebuild may never move the site)', plannerSrc.includes('slug: prev.slug'));
  const runnerSrc = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8');
  ok('slug lock derives from the LOCKED brand, never the re-resolved name', runnerSrc.includes('lockedName') && runnerSrc.includes('brandSlug(lockedName)'));
  ok('primary-table chooser never grids the options table', runnerSrc.includes('OPTIONS_TABLE') && runnerSrc.includes('!OPTIONS_TABLE.test(t.table)'));
}

// ---- serving: the pieces the phone actually touches ----
const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
ok('server: .apk has the android MIME type', server.includes("apk: 'application/vnd.android.package-archive'"));
ok('server: subdomain Host-routing exists (the APK origin resolves)', server.includes('.naples.agency') && server.includes("path = '/sites/'"));
{
  const i = server.indexOf("path === '/api/apk'");
  const route = i >= 0 ? server.slice(i, i + 1200) : '';
  ok('server: /api/apk exists and is ownership-gated (404, never leaked)', i >= 0 && route.includes('canSee') && route.includes('ownerOf'));
  ok('server: POST /api/apk requires the OWNER + an IP cap (a WRITE that spawns a 25-min gradle, never anon)', route.includes("user.id !== owner") && route.includes('APK_HITS'));
  ok('server: POST /api/apk goes through packageProjectAsync (in-flight capped)', route.includes('packageProjectAsync'));
}
{
  const appjs = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  ok('board: Android button wired to /api/apk with polling', appjs.includes("/api/apk?id=") && appjs.includes('Make Android app'));
}

console.log(`\napk:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

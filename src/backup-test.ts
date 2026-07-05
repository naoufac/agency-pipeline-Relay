// backup:check — a backup that isn't proven restorable is a wish, not a backup. This suite runs
// the REAL backup script in dry mode (full dump + encrypt + decrypt-roundtrip + restore-list,
// no ship) on every check run — so "suites green" always includes "tonight's backup will work".
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra); }
};

const out = mkdtempSync('/tmp/relay-bkcheck-');
try {
  let stdout = '';
  try {
    stdout = execFileSync('bash', [new URL('../deploy/backup.sh', import.meta.url).pathname, 'dry'],
      { encoding: 'utf8', env: { ...process.env, BACKUP_OUT: out }, timeout: 5 * 60_000 });
  } catch (e: any) { stdout = String(e?.stdout || '') + String(e?.stderr || e?.message || ''); }
  ok('backup script runs its full verify chain (dump→encrypt→decrypt→restore-list)', stdout.includes('DRY OK'), stdout.slice(-300));
  ok('encrypted dump exists and is real-sized (>1MB)', existsSync(out + '/relay.dump.enc') && statSync(out + '/relay.dump.enc').size > 1_000_000);
  ok('encrypted secrets exist (keystore + envs + tunnel creds)', existsSync(out + '/secrets.tar.gz.enc') && statSync(out + '/secrets.tar.gz.enc').size > 1000);
  ok('NO plaintext left behind (dump + secrets are wiped after encryption)', !existsSync(out + '/relay.dump') && !existsSync(out + '/secrets.tar.gz') && !existsSync(out + '/verify.dump'));
  {
    let m: any = {};
    try { m = JSON.parse(readFileSync(out + '/manifest.json', 'utf8')); } catch {}
    ok('manifest is externally checkable (stamp, sizes, shas, project count)', /^\d{4}-\d{2}-\d{2}T/.test(String(m.stamp)) && Number(m.dump_bytes) > 1_000_000 && /^[0-9a-f]{64}$/.test(String(m.dump_sha256)) && Number(m.projects) > 0);
  }
  const sh = readFileSync(new URL('../deploy/backup.sh', import.meta.url), 'utf8');
  ok('verification happens BEFORE shipping (a pushed backup is a proven backup)', sh.indexOf('VERIFY before shipping') < sh.indexOf('git push'));
  ok('failure in push mode rings the phone (Telegram ERR trap)', sh.includes('RELAY BACKUP FAILED') && sh.includes("trap 'alarm $LINENO' ERR"));
  ok('suspiciously small dump refuses to ship', sh.includes('suspiciously small'));
  ok('vault history stays bounded (weekday rotation + single-commit force push)', sh.includes('date -u +%a') && sh.includes('push -q --force'));
  ok('integrity guards route through the ALARM (exit 1 in a || group bypasses the ERR trap)', sh.includes('die() {') && sh.includes('|| die $LINENO') && !/\|\| \{ echo[^}]*exit 1; \}/.test(sh));
  ok('the ERR trap is installed BEFORE cd + .env source (a broken .env must still alert)', sh.indexOf("trap 'alarm $LINENO' ERR") < sh.indexOf('. ./.env'));
  ok('the alarm has a fallback token source (survives a broken /srv/relay/.env)', sh.includes('/root/.relay-monitor.env'));
  const svc = readFileSync(new URL('../deploy/systemd/relay-backup.service', import.meta.url), 'utf8');
  ok('backup service has an external OnFailure alert (never trusts the failing script)', svc.includes('OnFailure=relay-alert@'));
} finally {
  rmSync(out, { recursive: true, force: true });
}

// ---- the daily brief: every number from the DB, visitor rows only, dry-runnable ----
{
  const out2 = execFileSync('npx', ['tsx', new URL('./digest.ts', import.meta.url).pathname],
    { encoding: 'utf8', env: { ...process.env, DIGEST_DRY: '1' }, timeout: 3 * 60_000 });
  ok('digest: renders every section from live data', out2.includes('RELAY — daily brief') && out2.includes('Builds 24h:') && out2.includes('Canary:') && out2.includes('Vault:') && out2.includes('Surfaces:'), out2.slice(0, 200));
  const src = readFileSync(new URL('./digest.ts', import.meta.url), 'utf8');
  ok('digest: client activity counts PRIVATE tables only (seeds can never inflate it)', src.includes('PRIVATE_READ.test(t.table_name)'));
}

console.log(`\nbackup:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

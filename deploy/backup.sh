#!/usr/bin/env bash
# RELAY VAULT — the agency survives the box dying.
# Nightly: dump the database (every project + every client app schema), tar the unrecoverable
# secrets (Android signing keystore, envs, tunnel credentials), encrypt both with the owner-held
# key, VERIFY the encrypted artifacts actually decrypt and restore-list, then ship to the private
# relay-vault repo. Verification happens BEFORE shipping — a pushed backup is a proven backup.
# Modes:  backup.sh push   — full run + ship (the nightly timer)
#         backup.sh dry    — full run incl. verification, no ship (the gate suite)
# Failure in push mode rings the owner's phone (Telegram) via the ERR trap.
set -euo pipefail
MODE="${1:-push}"
KEY=/root/.backup-key
VAULT_DIR=/root/relay-vault
VAULT_REPO="git@github.com:naoufac/relay-vault.git"
OUT="${BACKUP_OUT:-$(mktemp -d /tmp/relay-backup.XXXXXX)}"
KEEP_OUT="${BACKUP_OUT:+1}"
cleanup() { [ -n "$KEEP_OUT" ] || rm -rf "$OUT"; }
trap cleanup EXIT

# fallback token source so the alarm survives even a broken /srv/relay/.env (same file the uptime
# monitor uses); the real .env below overrides it on a normal night.
[ -f /root/.relay-monitor.env ] && . /root/.relay-monitor.env

alarm() {
  echo "BACKUP FAILED at line $1" >&2
  if [ "$MODE" = "push" ] && [ -n "${TG_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ]; then
    curl -s -m 20 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      -d chat_id="${TG_CHAT_ID}" -d text="🧨 RELAY BACKUP FAILED (line $1) — the vault did NOT update tonight. Check the box." >/dev/null || true
  fi
}
# install the trap FIRST — cd/.env failures must alert too. die() routes the hand-written integrity
# guards through the SAME alarm: an explicit `exit 1` inside a `|| { ... }` group does NOT trigger
# the ERR trap, which had silenced the four checks that matter most.
trap 'alarm $LINENO' ERR
die() { alarm "$1"; exit 1; }

cd /srv/relay 2>/dev/null || cd /root/agency-pipeline || die $LINENO
set -a; . ./.env 2>/dev/null || die $LINENO; set +a

[ -s "$KEY" ] || die $LINENO
command -v pg_dump >/dev/null && command -v openssl >/dev/null

# 1 · the database — the single source every produced site can be regenerated from
pg_dump "$DATABASE_URL" -Fc -f "$OUT/relay.dump"
DUMP_BYTES=$(stat -c%s "$OUT/relay.dump")
[ "$DUMP_BYTES" -gt 1000000 ] || die $LINENO   # dump suspiciously small — refuse to ship it

# 2 · the unrecoverable secrets — a lost keystore means every published Android app is orphaned
tar -C / -czf "$OUT/secrets.tar.gz" \
  root/relay-android.keystore \
  srv/relay/.env \
  root/agency-pipeline/.env \
  root/.cloudflared \
  root/.bubblewrap/config.json

# 3 · encrypt — AES-256-CBC, PBKDF2 200k; the key lives on this box AND on the owner's phone
for f in relay.dump secrets.tar.gz; do
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY" -in "$OUT/$f" -out "$OUT/$f.enc"
done

# 4 · VERIFY before shipping — the only backup that counts is one that provably restores
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY" -in "$OUT/relay.dump.enc" -out "$OUT/verify.dump"
cmp -s "$OUT/relay.dump" "$OUT/verify.dump"
# (list to a file first — `pg_restore | grep -q` dies of SIGPIPE under pipefail on the first match)
pg_restore --list "$OUT/verify.dump" > "$OUT/verify.list"
grep -q "projects" "$OUT/verify.list" || die $LINENO   # restore-list has no projects table
rm -f "$OUT/verify.list"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY" -in "$OUT/secrets.tar.gz.enc" -out "$OUT/verify.tar.gz"
tar -tzf "$OUT/verify.tar.gz" | grep -q "relay-android.keystore" || die $LINENO   # secrets tar missing the keystore
rm -f "$OUT/verify.dump" "$OUT/verify.tar.gz"

# 5 · manifest — externally checkable without the key
{
  echo "{"
  echo "  \"stamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"dump_bytes\": $DUMP_BYTES,"
  echo "  \"dump_sha256\": \"$(sha256sum "$OUT/relay.dump" | cut -d' ' -f1)\","
  echo "  \"dump_enc_sha256\": \"$(sha256sum "$OUT/relay.dump.enc" | cut -d' ' -f1)\","
  echo "  \"secrets_enc_sha256\": \"$(sha256sum "$OUT/secrets.tar.gz.enc" | cut -d' ' -f1)\","
  echo "  \"projects\": $(psql "$DATABASE_URL" -tAc 'select count(*) from projects' | tr -d ' '),"
  echo "  \"prod_head\": \"$(git -C /srv/relay rev-parse --short HEAD 2>/dev/null || echo unknown)\""
  echo "}"
} > "$OUT/manifest.json"
rm -f "$OUT/relay.dump" "$OUT/secrets.tar.gz"   # plaintext never leaves the box

echo "backup verified: $DUMP_BYTES B dump · $(cat "$OUT/manifest.json" | tr -d '\n' | head -c 200)"
[ "$MODE" = "dry" ] && { echo "DRY OK"; exit 0; }

# 6 · ship — 7-day weekday rotation in a single-commit repo (bounded forever, no growing archive)
DOW=$(date -u +%a | tr 'A-Z' 'a-z')
if [ ! -d "$VAULT_DIR/.git" ]; then
  rm -rf "$VAULT_DIR"
  git clone --depth 1 "https://github.com/naoufac/relay-vault.git" "$VAULT_DIR" 2>/dev/null \
    || { mkdir -p "$VAULT_DIR" && git -C "$VAULT_DIR" init -q && git -C "$VAULT_DIR" remote add origin "https://github.com/naoufac/relay-vault.git"; }
fi
cp "$OUT/relay.dump.enc"     "$VAULT_DIR/relay-$DOW.dump.enc"
cp "$OUT/secrets.tar.gz.enc" "$VAULT_DIR/secrets-$DOW.tar.gz.enc"
cp "$OUT/manifest.json"      "$VAULT_DIR/manifest-$DOW.json"
cp "$OUT/manifest.json"      "$VAULT_DIR/manifest-latest.json"
[ -f "$VAULT_DIR/README.md" ] || cat > "$VAULT_DIR/README.md" <<'EOF'
# relay-vault — disaster recovery for the Relay agency
Encrypted nightly backups (AES-256-CBC, PBKDF2 200k). The key is /root/.backup-key on the box
AND held by the owner. Restore procedure: docs/RESTORE.md in agency-pipeline-Relay.
EOF
cd "$VAULT_DIR"
git checkout -q --orphan tmp$$ 2>/dev/null || true
git add -A
git -c user.name=relay-backup -c user.email=backup@naples.agency commit -qm "vault $(date -u +%F) ($DOW)"
git branch -qM main
git push -q --force origin main
echo "shipped to relay-vault ($DOW)"

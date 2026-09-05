#!/usr/bin/env bash
# Local gzip dump of Relay's agency DB. Restorable. Never write a 20-byte empty gzip.
# pg_dump must succeed BEFORE gzip is created. Size < 100KB is a failed dump, not a backup.
set -euo pipefail
DIR=/root/backups/relay-db
mkdir -p "$DIR"
TS=$(date -u +%Y%m%d-%H%M%S)
TMP=$(mktemp "$DIR/.tmp-XXXXXX.sql")
OUT="$DIR/agency-$TS.sql.gz"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

if ! docker exec ap-pg pg_dump -U postgres -d agency --no-owner --clean --if-exists > "$TMP"; then
  echo "$(date -u +%FT%TZ) FAIL pg_dump" >> "$DIR/backup.log"
  exit 1
fi
BYTES=$(stat -c%s "$TMP")
if [ "$BYTES" -lt 100000 ]; then
  echo "$(date -u +%FT%TZ) FAIL dump too small (${BYTES}B)" >> "$DIR/backup.log"
  exit 1
fi
gzip -c "$TMP" > "$OUT"
ls -1t "$DIR"/agency-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "$(date -u +%FT%TZ) ok $(du -h "$OUT" | cut -f1) ${BYTES}B -> $OUT" >> "$DIR/backup.log"

#!/usr/bin/env bash
# Bring up Relay's shared headless-CMS instances (idempotent). Reads secrets from ../.env.
# Per-project isolation is by row filter (project_id), so ONE shared instance serves all projects.
# Directus is adapter #1 (proven by `npm run prove:directus`). Others added as their adapters land.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
set -a; . "$HERE/.env" 2>/dev/null; set +a
USER=$(echo "$DATABASE_URL" | sed -E 's#postgres(ql)?://([^:]+):([^@]+)@.*#\2#')
PW=$(echo "$DATABASE_URL"   | sed -E 's#postgres(ql)?://([^:]+):([^@]+)@.*#\3#')
APIP=$(docker inspect ap-pg -f '{{.NetworkSettings.Networks.bridge.IPAddress}}')

echo "› directus database (on ap-pg)"
docker exec ap-pg psql -U "$USER" -d postgres -tAc "select 1 from pg_database where datname='directus'" | grep -q 1 \
  || docker exec ap-pg psql -U "$USER" -d postgres -c "create database directus"

echo "› directus container (127.0.0.1:8055, restart=unless-stopped)"
if docker ps -a --format '{{.Names}}' | grep -qx relay-directus; then
  docker start relay-directus >/dev/null
else
  docker run -d --name relay-directus --restart unless-stopped -p 127.0.0.1:8055:8055 \
    -e KEY="$DIRECTUS_KEY" -e SECRET="$DIRECTUS_SECRET" \
    -e DB_CLIENT=pg -e DB_HOST="$APIP" -e DB_PORT=5432 -e DB_DATABASE=directus -e DB_USER="$USER" -e DB_PASSWORD="$PW" \
    -e ADMIN_EMAIL="$DIRECTUS_ADMIN_EMAIL" -e ADMIN_PASSWORD="$DIRECTUS_ADMIN_PASSWORD" \
    -e PUBLIC_URL="${DIRECTUS_PUBLIC_URL:-https://cms.naples.agency}" -e WEBSOCKETS_ENABLED=false directus/directus:12.0.2
fi

echo "› wait for health + ensure an admin user with a static token"
for i in $(seq 1 40); do curl -sf "$DIRECTUS_URL/server/info" >/dev/null 2>&1 && break; sleep 3; done
if [ "$(docker exec ap-pg psql -U "$USER" -d directus -tAc "select count(*) from directus_users" | tr -d ' ')" = "0" ]; then
  ROLEID=$(docker exec ap-pg psql -U "$USER" -d directus -tAc "select id from directus_roles order by 1 limit 1" | tr -d ' ')
  docker exec relay-directus npx directus users create --email "$DIRECTUS_ADMIN_EMAIL" --password "$DIRECTUS_ADMIN_PASSWORD" --role "$ROLEID" >/dev/null
fi
docker exec ap-pg psql -U "$USER" -d directus -tAc \
  "update directus_users set token='$DIRECTUS_TOKEN' where email='$DIRECTUS_ADMIN_EMAIL' and (token is distinct from '$DIRECTUS_TOKEN')" >/dev/null
echo "✓ directus up: $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DIRECTUS_TOKEN" "$DIRECTUS_URL/collections")"

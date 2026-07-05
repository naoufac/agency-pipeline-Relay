#!/usr/bin/env bash
# Relay uptime watchdog v2 — every SERVING SURFACE, not just the board.
# The board and the client sites ride DIFFERENT tunnels (relay vs the wildcard on anouf-chat):
# v1 only pinged the board, so every client subdomain could go dark while the monitor stayed
# green. v2 probes each surface with its own flap-dampened state; alerts name the surface.
# Cron: */5 * * * * /usr/local/bin/relay-uptime-check.sh
set -uo pipefail
[ -f /root/.relay-monitor.env ] && . /root/.relay-monitor.env
api="https://api.telegram.org/bot${TG_TOKEN}/sendMessage"

# name | url | mode  (200 = must be exactly 200 · up = anything but 5xx/tunnel-dead/000)
# the sites probe MUST be a PERMANENT project — canary-built sites are swept nightly by design
CHECKS="
board|https://board.naples.agency/healthz|200
sites|https://nenna.naples.agency/|200
cms|https://cms.naples.agency/server/health|up
"

alert() { curl -s -F chat_id="${TG_CHAT_ID}" -F text="$1" "$api" >/dev/null; }

echo "$CHECKS" | while IFS='|' read -r name url mode; do
  [ -z "$name" ] && continue
  STATE="/tmp/relay-uptime-${name}.state"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$url" 2>/dev/null || echo 000)
  case "$mode" in
    200) [ "$code" = "200" ] && now=up || now=down ;;
    # a health probe: ONLY 2xx is up. 4xx (a renamed Directus health route on :latest, a WAF 403,
    # an auth wall) is NOT healthy — treating it as up false-greens a broken surface.
    *)   case "$code" in 2??) now=up ;; *) now=down ;; esac ;;
  esac
  prev=$(cat "$STATE" 2>/dev/null || echo up)
  if [ "$now" = "up" ] && [ "$prev" = "down" ]; then
    alert "✅ Relay RECOVERED — surface '${name}' (${url}) is back (${code})."
  elif [ "$now" = "down" ] && [ "$prev" = "up" ]; then
    case "$name" in
      sites) hint="the WILDCARD tunnel (anouf-named-tunnel.service) or relay.service — client sites + APK downloads are dark" ;;
      cms)   hint="the Directus container (port 8055)" ;;
      *)     hint="relay.service / relay-tunnel.service / the database" ;;
    esac
    alert "🔴 Relay DOWN — surface '${name}' returned ${code}. Likely: ${hint}."
  fi
  echo "$now" > "$STATE"
done

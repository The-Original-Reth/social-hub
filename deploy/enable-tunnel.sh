#!/bin/sh
# Runs INSIDE the container (pct enter 110). Connects Social Hub to a Cloudflare Tunnel.
# Asks for the public hostname and the tunnel token, saves them in .env and starts the tunnel.
set -eu
cd /opt/social-hub
[ -f .env ] || { echo ".env not found; run the installer first." >&2; exit 1; }

printf 'Public hostname (e.g. social.yourdomain.com): '
read -r HOSTNAME_IN
HOSTNAME_IN=$(printf '%s' "$HOSTNAME_IN" | sed -e 's|^https\?://||' -e 's|/.*$||')
[ -n "$HOSTNAME_IN" ] || { echo "No hostname given." >&2; exit 1; }

printf 'Tunnel token (input hidden): '
stty -echo 2>/dev/null || true
read -r TOKEN
stty echo 2>/dev/null || true
echo
# Accept the whole "cloudflared service install <token>" command too.
TOKEN=$(printf '%s' "$TOKEN" | awk '{print $NF}')
[ -n "$TOKEN" ] || { echo "No token given." >&2; exit 1; }

setvar() { # setvar KEY VALUE: replace the line if present, otherwise append it
  if grep -q "^$1=" .env; then
    tmp=$(mktemp); awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > "$tmp"
    cat "$tmp" > .env; rm -f "$tmp"
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
setvar PUBLIC_BASE_URL "https://$HOSTNAME_IN"
setvar COMPOSE_PROFILES tunnel
setvar CLOUDFLARE_TUNNEL_TOKEN "$TOKEN"
chmod 600 .env

docker compose up -d
echo ">> Waiting for the tunnel to connect"
for i in $(seq 1 20); do
  if docker logs social-hub-tunnel 2>&1 | grep -q "Registered tunnel connection"; then
    echo ">> Tunnel connected. Social Hub is at https://$HOSTNAME_IN"
    exit 0
  fi
  sleep 2
done
echo "Tunnel did not connect yet. Check: docker logs social-hub-tunnel" >&2
exit 1

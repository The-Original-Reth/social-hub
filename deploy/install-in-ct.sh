#!/bin/sh
# Runs INSIDE the LXC container. Installs Docker if needed, unpacks Social Hub to /opt/social-hub and starts it.
# Usage: sh install-in-ct.sh /root/social-hub.tar.gz
set -eu
ARCHIVE="${1:-/root/social-hub.tar.gz}"
APP_DIR=/opt/social-hub

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo ">> Installing Docker"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl >/dev/null
    curl -fsSL https://get.docker.com | sh
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache docker docker-cli-compose
    rc-update add docker default
    service docker start
  else
    echo "Unsupported distro: install Docker manually, then re-run." >&2
    exit 1
  fi
fi

mkdir -p "$APP_DIR"
echo ">> Unpacking to $APP_DIR (keeping data/ and .env)"
tar --no-same-owner -xzf "$ARCHIVE" -C "$APP_DIR"
mkdir -p "$APP_DIR/data"
chown -R 1000:1000 "$APP_DIR/data"

if [ ! -f "$APP_DIR/.env" ]; then
  PASS=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  sed -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$PASS|" \
      -e "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=http://${IP:-localhost}:3000|" \
      "$APP_DIR/.env.example" > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo ">> Created $APP_DIR/.env with a random admin password:"
  echo "   username: admin"
  echo "   password: $PASS"
fi

cd "$APP_DIR"
echo ">> Building and starting the container"
docker compose up -d --build
docker compose ps
echo ">> Done. Open http://$(hostname -I 2>/dev/null | awk '{print $1}'):3000"

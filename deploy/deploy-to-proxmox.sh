#!/bin/sh
# Run from the project folder on your PC (Git Bash / WSL / Linux / macOS).
# Packs the app, copies it to the Proxmox host, pushes it into the container and installs it.
# Usage: sh deploy/deploy-to-proxmox.sh root@<proxmox-host> [CTID]
set -eu
TARGET="${1:?Usage: deploy-to-proxmox.sh root@<proxmox-host> [CTID]}"
CTID="${2:-110}"
ARCHIVE=deploy/social-hub.tar.gz

echo ">> Packing app"
tar --owner=0 --group=0 -czf "$ARCHIVE" --exclude=node_modules --exclude=data --exclude=.env --exclude='deploy/*.tar.gz' \
  package.json package-lock.json Dockerfile docker-compose.yml .dockerignore .env.example src public scripts deploy/install-in-ct.sh deploy/enable-tunnel.sh README.md TERMS.md PRIVACY.md LICENSE

echo ">> Copying to $TARGET"
scp -q "$ARCHIVE" deploy/install-in-ct.sh "$TARGET:/tmp/"

ssh "$TARGET" CTID="$CTID" sh -s <<'REMOTE'
set -eu
if ! pct status "$CTID" >/dev/null 2>&1; then echo "Container $CTID not found on this host." >&2; exit 1; fi
# Docker inside an LXC container needs nesting (and keyctl for unprivileged containers).
FEAT=$(pct config "$CTID" | sed -n 's/^features: //p')
case "$FEAT" in *nesting=1*) ;; *)
  echo ">> Enabling nesting/keyctl on CT $CTID (needed for Docker) and restarting it"
  pct set "$CTID" --features nesting=1,keyctl=1
  pct reboot "$CTID" 2>/dev/null || { pct stop "$CTID"; }
  sleep 3 ;;
esac
pct status "$CTID" | grep -q running || { pct start "$CTID"; sleep 5; }
pct push "$CTID" /tmp/social-hub.tar.gz /root/social-hub.tar.gz
pct push "$CTID" /tmp/install-in-ct.sh /root/install-in-ct.sh
pct exec "$CTID" -- sh /root/install-in-ct.sh /root/social-hub.tar.gz
rm -f /tmp/social-hub.tar.gz /tmp/install-in-ct.sh
REMOTE

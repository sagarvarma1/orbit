#!/usr/bin/env bash
# Orbit installer: a self-hosted deployment platform on one Linux server.
#
#   curl -fsSL https://raw.githubusercontent.com/sagarvarma1/orbit/main/install.sh | sudo bash
#
# Non-interactive: ORBIT_ROOT_DOMAIN=example.com ACME_EMAIL=you@example.com ... | sudo -E bash
# Optional: ORBIT_APP_DOMAIN (default app.<root>), ORBIT_DIR (default /opt/orbit),
#           ORBIT_VERSION (image tag, default latest), ORBIT_REPO (default sagarvarma1/orbit).
set -euo pipefail

ORBIT_REPO="${ORBIT_REPO:-sagarvarma1/orbit}"
ORBIT_BRANCH="${ORBIT_BRANCH:-main}"
ORBIT_DIR="${ORBIT_DIR:-/opt/orbit}"
RAW="https://raw.githubusercontent.com/${ORBIT_REPO}/${ORBIT_BRANCH}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Prompts read from the terminal, because stdin is this script when piped from curl.
ask() {
  local var="$1" prompt="$2" default="${3:-}" value
  if [ -n "${!var:-}" ]; then return; fi
  [ -r /dev/tty ] || fail "$var is required (no terminal to ask on)."
  if [ -n "$default" ]; then printf '%s [%s]: ' "$prompt" "$default" >/dev/tty; else printf '%s: ' "$prompt" >/dev/tty; fi
  read -r value </dev/tty
  value="${value:-$default}"
  [ -n "$value" ] || fail "$var is required."
  printf -v "$var" '%s' "$value"
}

bold "Orbit installer"

[ "$(uname -s)" = "Linux" ] || fail "Orbit's installer supports Linux servers. On a laptop, see the README's Quick start."
[ "$(id -u)" -eq 0 ] || fail "Run as root (pipe into 'sudo bash')."
command -v curl >/dev/null || fail "curl is required."

# 1. Docker -----------------------------------------------------------------------------
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  ask INSTALL_DOCKER "Docker with the Compose plugin is required. Install it now via get.docker.com? (y/n)" "y"
  [ "$INSTALL_DOCKER" = "y" ] || fail "Install Docker Engine and the Compose plugin, then run this again."
  curl -fsSL https://get.docker.com | sh
fi
docker info >/dev/null 2>&1 || fail "Docker is installed but the daemon isn't running (try: systemctl start docker)."

# 2. Settings ---------------------------------------------------------------------------
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
echo
ask ORBIT_ROOT_DOMAIN "Domain for deployments (they'll be served at <name>.<domain>)" ""
ORBIT_ROOT_DOMAIN="$(echo "$ORBIT_ROOT_DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##')"
ask ORBIT_APP_DOMAIN "Domain for the Orbit dashboard" "app.${ORBIT_ROOT_DOMAIN}"
ask ACME_EMAIL "Email for Let's Encrypt certificate notices" ""

mkdir -p "$ORBIT_DIR/data"
cd "$ORBIT_DIR"

# 3. Files ------------------------------------------------------------------------------
curl -fsSL "$RAW/deploy/docker-compose.yml" -o docker-compose.yml
curl -fsSL "$RAW/deploy/Caddyfile" -o Caddyfile

if [ -f .env ]; then
  info "Keeping existing $ORBIT_DIR/.env"
else
  umask 077
  cat >.env <<EOF
# Orbit configuration. Edit, then: docker compose up -d
ORBIT_ROOT_DOMAIN=${ORBIT_ROOT_DOMAIN}
ORBIT_APP_DOMAIN=${ORBIT_APP_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
ORBIT_DATA_DIR=${ORBIT_DIR}/data
ORBIT_PUBLIC_IP=${PUBLIC_IP}
ORBIT_VERSION=${ORBIT_VERSION:-latest}
BUILD_CONCURRENCY=2
# Set to recover a forgotten admin password, restart, then remove it.
ORBIT_RESET_ADMIN_PASSWORD=
EOF
  umask 022
fi

# 4. Start ------------------------------------------------------------------------------
bold "Starting Orbit…"
docker compose pull
docker compose up -d

info "Waiting for the API…"
SETUP_CODE=""
for _ in $(seq 1 60); do
  SETUP_CODE="$(docker compose logs api 2>/dev/null | grep -o 'ORBIT SETUP CODE: [A-Z0-9-]*' | tail -1 | sed 's/ORBIT SETUP CODE: //' || true)"
  if [ -n "$SETUP_CODE" ] || docker compose logs api 2>/dev/null | grep -q "Orbit control plane on"; then break; fi
  sleep 2
done

# 5. Next steps -------------------------------------------------------------------------
echo
bold "Orbit is running."
echo
echo "1. Point DNS at this server${PUBLIC_IP:+ (${PUBLIC_IP})}:"
echo
printf '     %-6s %-28s %s\n' "Type" "Name" "Value"
printf '     %-6s %-28s %s\n' "A" "*.${ORBIT_ROOT_DOMAIN}" "${PUBLIC_IP:-<server IP>}"
case "$ORBIT_APP_DOMAIN" in
  *".${ORBIT_ROOT_DOMAIN}") ;; # covered by the wildcard
  *) printf '     %-6s %-28s %s\n' "A" "${ORBIT_APP_DOMAIN}" "${PUBLIC_IP:-<server IP>}" ;;
esac
echo
echo "2. Open https://${ORBIT_APP_DOMAIN}/setup and create the admin account."
if [ -n "$SETUP_CODE" ]; then
  echo "   Setup code: ${SETUP_CODE}"
else
  echo "   Setup code: run 'cd ${ORBIT_DIR} && docker compose logs api | grep \"SETUP CODE\"'"
fi
echo
echo "3. In Settings, connect GitHub to deploy private repositories and get instant push deploys."
echo
info "Files: ${ORBIT_DIR} · Update: cd ${ORBIT_DIR} && docker compose pull && docker compose up -d"

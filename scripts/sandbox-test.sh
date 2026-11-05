#!/usr/bin/env bash
# Runs the sandbox tests the way production runs Orbit: Linux, as root. Works on a laptop with
# Docker and in CI.
#
#   ./scripts/sandbox-test.sh              process sandbox: per-project users + edge firewall (NET_ADMIN)
#   ./scripts/sandbox-test.sh --e2e        ...plus the full end-to-end suite that way
#   ./scripts/sandbox-test.sh --containers sandbox containers: a real sandboxd starting containers on this
#                                          Docker daemon (host network + NET_ADMIN for its firewall)
#   ./scripts/sandbox-test.sh --containers --e2e  ...plus the end-to-end suite with every deployment's
#                                          code running in sandbox containers
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-}"
SETUP='
  set -e
  apt-get update -qq >/dev/null && apt-get install -y -qq iptables >/dev/null
  mkdir /work && cd /src && tar --exclude=node_modules --exclude=.next --exclude=data -cf - . | tar -xf - -C /work
  cd /work && corepack enable >/dev/null 2>&1 && pnpm install --frozen-lockfile >/dev/null
'

if [ "$MODE" = "--containers" ]; then
  docker build -q -f apps/api/runtime/Dockerfile -t orbit-runtime:dev . >/dev/null
  # The data dir must have the same path for this container and the daemon (bind mounts use host
  # paths), and live on the daemon's own filesystem (unix sockets don't cross Docker Desktop's file
  # sharing). A volume mounted at its own path on the daemon side is both.
  docker volume create orbit-sandboxd-test >/dev/null
  DIR=/var/lib/docker/volumes/orbit-sandboxd-test/_data
  docker run --rm --network host --cap-add NET_ADMIN -e E2E="${2:-}" -e E2E_FLAGS="${E2E_FLAGS:-}" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "orbit-sandboxd-test:$DIR" -v "$PWD:/src:ro" \
    -e ORBIT_SANDBOXD_TEST=1 -e ORBIT_SANDBOXD_TEST_DIR="$DIR" -e ORBIT_RUNTIME_IMAGE=orbit-runtime:dev \
    -e ORBIT_SANDBOXD_TEST_OFFLINE="${ORBIT_SANDBOXD_TEST_OFFLINE:-0}" \
    -e ORBIT_SANDBOXD_EXPECT_RUNTIME="${ORBIT_SANDBOXD_EXPECT_RUNTIME:-}" \
    node:22-bookworm bash -c "$SETUP"'
    (cd apps/api && npx vitest run test/sandboxd.test.ts)
    if [ "$E2E" = "--e2e" ]; then
      apt-get install -y -qq python3-pip >/dev/null
      TMPDIR='"$DIR"' PIP_BREAK_SYSTEM_PACKAGES=1 ORBIT_BUILDER=process node scripts/e2e.mjs --containers $E2E_FLAGS
    fi
  '
  exit 0
fi

docker run --rm --cap-add NET_ADMIN -e E2E="$MODE" -v "$PWD:/src:ro" node:22-bookworm bash -c "$SETUP"'
  (cd apps/api && npx vitest run test/sandbox.test.ts test/functions.test.ts)
  if [ "$E2E" = "--e2e" ]; then
    ORBIT_BUILDER=process node scripts/e2e.mjs --next
    grep -q "per-project users on · firewall on" /tmp/orbit-e2e-*/edge.log || { echo "sandbox was not active"; exit 1; }
  fi
'

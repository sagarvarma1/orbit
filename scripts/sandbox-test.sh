#!/usr/bin/env bash
# Runs the sandbox tests the way production runs the edge: Linux, as root, with NET_ADMIN for
# the firewall. Works on a laptop with Docker and in CI. `--e2e` also runs the full end-to-end
# suite that way, so real deployments (including Next.js servers) run as sandbox users.
set -euo pipefail
cd "$(dirname "$0")/.."
E2E="${1:-}"
docker run --rm --cap-add NET_ADMIN -e E2E="$E2E" -v "$PWD:/src:ro" node:22-bookworm bash -c '
  set -e
  apt-get update -qq >/dev/null && apt-get install -y -qq iptables >/dev/null
  mkdir /work && cd /src && tar --exclude=node_modules --exclude=.next --exclude=data -cf - . | tar -xf - -C /work
  cd /work && corepack enable >/dev/null 2>&1 && pnpm install --frozen-lockfile >/dev/null
  (cd apps/api && npx vitest run test/sandbox.test.ts test/functions.test.ts)
  if [ "$E2E" = "--e2e" ]; then
    ORBIT_BUILDER=process node scripts/e2e.mjs --next
    grep -q "per-project users on · firewall on" /tmp/orbit-e2e-*/edge.log || { echo "sandbox was not active"; exit 1; }
  fi
'

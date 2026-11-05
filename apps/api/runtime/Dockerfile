# The image sandbox containers run (sandboxd starts one container per function instance or app
# server): Node.js 22 and Python 3.12, like Vercel's runtimes, plus Orbit's runtime entrypoints.
# Deployment code is mounted read-only at /var/task; the root filesystem is read-only too.
# Build from the repo root:
#   docker build -f apps/api/runtime/Dockerfile -t orbit-runtime .
FROM python:3.12-slim-bookworm
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY apps/api/runtime/function-runner.mjs apps/api/runtime/python-runner.py apps/api/runtime/server-bridge.mjs /opt/orbit/
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /var/task

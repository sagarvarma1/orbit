# Control plane + edge image (same code, different entrypoints). Build from the repo root:
#   docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @orbit/api
COPY apps/api apps/api
RUN pnpm --filter @orbit/api build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @orbit/api

FROM base AS runtime
# git: cloning repos. docker CLI: launching isolated build containers via the host socket.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/runtime ./apps/api/runtime
COPY apps/api/package.json ./apps/api/
WORKDIR /app/apps/api
ENV NODE_ENV=production ORBIT_DATA_DIR=/data
EXPOSE 4000 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]

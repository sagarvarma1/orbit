# Contributing to Orbit

Thanks for helping. Bug reports, fixes and features are all welcome.

## Setup

Node 22.13+, pnpm (`corepack enable`) and git. Docker is optional for local development.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

The API prints a setup code on first start; open http://localhost:3000/setup to create your account.

## Before opening a pull request

```bash
pnpm typecheck
pnpm test
pnpm e2e          # deploys real repositories; takes a minute or two
pnpm format
```

- Keep changes focused, and add or update tests for behavior changes (`apps/api/test`, `scripts/e2e.mjs`).
- Match the surrounding code: small modules, comments that explain why, all SQL in `apps/api/src/db/repo.ts`.
- For larger changes, open an issue first so we can agree on the approach.

## Layout

- `apps/api`: control plane (`src/index.ts`) and edge (`src/edge.ts`)
- `apps/dashboard`: Next.js dashboard
- `deploy`, `install.sh`: production setup
- `examples/orbit-demo-app`: demo project

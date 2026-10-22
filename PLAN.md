# Orbit — Plan

Orbit is a small, self-hostable deployment platform in the spirit of Vercel: point it at a
public Git repository and it clones, installs, builds and serves the real output at an
immutable preview URL, with a production alias you can promote and roll back instantly.

The goal is a codebase that is small enough to read in an afternoon but makes the same
architectural choices a real platform does: a control plane that owns state, a build
pipeline that treats every build as hostile, an edge that only ever serves immutable
artifacts, and aliases as the single mutable pointer.

## Architecture

```
                 ┌───────────────────────────── control plane (apps/api, :4000) ─────────────────────────────┐
 Dashboard  ──►  │ Fastify REST + SSE ─► services (projects, deployments, aliases) ─► SQLite (WAL)           │
 (Next.js,       │        ▲                         │                                                         │
  :3000)         │ GitHub webhook / git poller      ▼                                                         │
                 │                         Build queue (concurrency N, timeout, cancel)                      │
                 │                                   │                                                       │
                 │          clone (shallow) ─► detect ─► install ─► build ─► bundle api/* ─► publish artifact │
                 │                    runs in: Docker container (if available) │ child process (fallback)    │
                 └──────────────────────────────────────────────────┬────────────────────────────────────────┘
                                                                    │ writes data/artifacts/<id>/ (immutable)
                                                                    ▼
 Browser ──► <id>.localhost:8080 ──►  Edge (apps/api edge entry, :8080)  ── reads SQLite (aliases, deployments)
             <project>.localhost        Host routing ─► static files / SPA fallback / 404
                                        /api/* ─► function runner (isolated child process per invocation)
```

Three processes, one SQLite file, one data directory:

| Process       | Responsibility                                                                 |
| ------------- | ------------------------------------------------------------------------------ |
| control plane | REST API, SSE log streaming, webhook receiver, git poller, build queue/workers |
| edge          | Host-header router serving artifacts and invoking functions                    |
| dashboard     | Next.js App Router UI, talks to the control plane over HTTP                    |

The edge never writes and never builds. It reads two things: "which deployment does this
hostname point at" (deployments + aliases tables) and files under an immutable artifact
directory. That separation means the edge keeps serving traffic if the control plane is
down or busy building, which is the property that matters most in a real platform.

### Data model (SQLite)

- `projects` — name (DNS label, doubles as production subdomain), repo URL, production
  branch, framework preset + overridable install/build/output/root directory,
  `auto_promote_paused` (set by an instant rollback, as Vercel does).
- `env_vars` — key, value, targets (`production`, `preview`).
- `deployments` — id (`dpl-xxxxxxxxxx`), project, target (`production`|`preview`), branch,
  commit sha/message/author, status (`queued|building|ready|error|canceled`), trigger
  (`import|redeploy|webhook|poll|manual`), timings, error message, framework, artifact dir.
- `aliases` — hostname label → deployment id. One row per alias; switching production is a
  single-row `UPDATE` inside a transaction, so the switch is atomic and instant.
- `alias_events` — history of production promotions/rollbacks (drives "rollback to previous").
- `branch_heads` — last seen sha per branch, used by the git poller.

### Build pipeline

1. **Clone**: `git init` + `git fetch --depth 1 origin <branch|sha>` + `checkout FETCH_HEAD`.
   Works for branch names and exact commit SHAs from webhooks without a full clone.
2. **Detect**: framework preset from `package.json` dependencies and config files
   (Next.js static export, Vite, Create React App, Astro, generic `build` script, plain
   static HTML). Package manager from lockfile (`pnpm-lock.yaml`, `yarn.lock`,
   `package-lock.json`). Every value is overridable per project.
3. **Install + build**: runs inside a throwaway `node:22` Docker container (CPU/memory
   limits, killed on cancel/timeout) when Docker is available, otherwise as a detached child
   process group with a scrubbed environment (no control-plane secrets leak into builds).
   Project env vars for the deployment's target are injected, plus `ORBIT_*` system vars.
4. **Functions**: files in `api/**/*.{js,ts,mjs}` are bundled with esbuild into
   self-contained ESM modules.
5. **Publish**: output copied into `data/artifacts/<deploymentId>/static`, a manifest
   (`orbit.json`) written, then the deployment flips to `ready`. Artifacts are never modified
   afterwards. Production-branch deployments are auto-assigned the production alias unless
   auto-promotion is paused by a rollback. Previews also get a branch alias
   `<project>-git-<branch>`.

Queue: in-process FIFO with a concurrency limit (`BUILD_CONCURRENCY`), per-build timeout
(`BUILD_TIMEOUT_SECONDS`), and cancel for both queued and running builds. On restart,
interrupted builds are marked `error` and queued ones are re-enqueued.

Logs: every line is appended to `data/logs/<id>.ndjson` (persisted) and published to an
in-process pub/sub. The SSE endpoint replays the file then tails live events, so a browser
that connects mid-build (or after) sees the full log.

### Edge

- Hostname → deployment: `<deploymentId>.<root>` (immutable preview), otherwise alias lookup
  (`<project>.<root>` production, `<project>-git-<branch>.<root>` branch alias).
- File resolution: exact file → `<path>.html` (clean URLs for Next export/Astro) →
  `<path>/index.html` → SPA fallback to `/index.html` for frameworks that need it (only for
  navigations, not for missing assets) → the site's own `404.html` → Orbit 404 page.
- Headers: correct `Content-Type`, `Cache-Control: public, max-age=31536000, immutable` for
  fingerprinted assets, `max-age=0, must-revalidate` for HTML, strong ETags derived from the
  deployment id (content can never change under an id), gzip for compressible types,
  path-traversal protection, `x-orbit-deployment` header.
- Not-ready deployments render a status page (building / failed / canceled).
- `/api/*` routes to bundled functions: each invocation runs in a fresh child process with
  Node's permission model (read-only access to the function bundle, no child processes, no
  fs writes), a memory cap and a 10s timeout. Handlers can be Web-standard
  (`(Request) => Response`, or named `GET`/`POST` exports) or Node-style `(req, res)`.

### Git integration

- `POST /api/webhooks/github` verifies `X-Hub-Signature-256` (HMAC-SHA256, constant-time
  compare). `push` to the production branch → production deployment; any other branch →
  preview. Branch deletions are ignored; `ping` is acknowledged.
- Because GitHub cannot reach `localhost`, an optional git poller (`GIT_POLL_INTERVAL_SECONDS`)
  uses `git ls-remote` to detect new commits and feeds the same code path. This makes the
  push-to-deploy demo work on a laptop with no tunnel.

## Tradeoffs

- **SQLite via `node:sqlite`** — zero native dependencies, WAL lets the edge read while the
  control plane writes. Single-node only; a real platform would use Postgres + a KV at the
  edge.
- **Edge reads the DB directly** instead of receiving pushed config. Simple and consistent;
  a production edge would cache alias config in memory and receive invalidations.
- **Static output only** (plus functions). Next.js must use `output: 'export'`. SSR,
  ISR and middleware would need a long-running server runtime per deployment.
- **Child process per function invocation** — strong isolation and simple, ~50ms cold
  start every time. A real system would keep warm, sandboxed workers (Firecracker, V8
  isolates).
- **Child-process builds are not a security boundary.** Docker mode is the isolated mode;
  the fallback exists so it runs anywhere (including this sandbox).
- **Single-tenant, no auth** on the dashboard/API. Fine for a local demo, not for the
  internet — the VPS guide puts it behind Caddy basic auth.

## Out of scope

- Authentication, teams, billing, quotas.
- SSR / ISR / edge middleware / image optimization.
- GitHub App installation flow, private repos.
- Custom domains per project, automatic TLS per project (the VPS guide uses a wildcard).
- Multi-region edge, CDN caching, analytics.

## Feature checklist (status as delivered)

Legend: ✅ built and tested in the sandbox · 🟡 built, not exercised (no Docker daemon / public domain in the sandbox)

- ✅ Import public GitHub repo, branch picker, framework auto-detection, overrides
- ✅ Shallow clone (branch or exact SHA), lockfile-aware install, build, env var injection per target
- 🟡 Docker build isolation (`DockerRunner`): implemented, but the sandbox had no Docker daemon
- ✅ Child-process fallback builder (all sandbox builds used it)
- ✅ Build queue: concurrency, timeout, cancel (process tree killed)
- ✅ Live logs over SSE, persisted, replay + resume
- ✅ Immutable deployments at `<id>.localhost:8080`, production alias, branch aliases
- ✅ Promote / instant rollback (atomic alias switch), auto-promotion paused after rollback
- ✅ Edge: Host routing, clean URLs, SPA fallback, content types, immutable caching, ETag/304, gzip, 404s
- ✅ Dashboard: projects, import flow, deployments, logs, env vars, settings, promote/rollback/redeploy/cancel
- ✅ GitHub webhook (signature verified, idempotent) + git poller, redeploy
- ✅ Stretch: serverless functions in `api/` (permission-model sandbox, timeout, memory cap)
- ✅ `vercel.json` redirects, rewrites and headers, validated at build time and applied at the edge
- ✅ Build cache: node_modules keyed by lockfile (install skipped on a hit), `.next/cache`, redeploy without cache
- ✅ GitHub commit statuses and PR preview comments (token-based), tested against a fake GitHub API
- ✅ Tests: unit (detection, router, functions, queue, webhooks, poller) + e2e against real repos
- 🟡 `docker compose up` and the Dockerfiles (written, compiled output and standalone dashboard verified, image builds not run)
- 🟡 VPS + Caddy wildcard TLS guide (written, not deployed)

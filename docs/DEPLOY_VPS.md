# Deploying Orbit to a VPS with wildcard TLS

This guide takes Orbit from `http://<id>.localhost:8080` to public URLs:

```
https://app.example.com                    dashboard + API (basic auth)
https://dpl-k3x9q2m1za.example.com         an immutable deployment
https://my-app.example.com                 production alias
https://my-app-git-feature-x.example.com   branch alias
```

Caddy terminates TLS with a single **wildcard certificate** for `*.example.com`. Wildcard
certificates require the ACME **DNS-01** challenge, so Caddy needs a module for your DNS provider.
The files in [`deploy/`](../deploy) use Cloudflare. Swap the module for another provider if you need to.

> Tested status: these files are written for the setup below but were **not** exercised end to end
> (the development sandbox had no Docker daemon and no public domain). Treat this as a recipe and expect to
> adjust small details.

## 1. Server

Any Linux VPS with 2+ vCPU and 4 GB RAM (builds are the heavy part). Install Docker Engine and the
Compose plugin (v2.24+):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in
```

Open ports 80 and 443 only. Orbit's own ports (3000, 4000 and 8080) bind to `127.0.0.1` in the VPS override.

## 2. DNS

Create two records pointing at the server's IP:

| Type | Name | Value |
| --- | --- | --- |
| A | `example.com` | `203.0.113.10` (optional, not used by Orbit) |
| A | `*.example.com` | `203.0.113.10` |

`app.example.com` is covered by the wildcard record. Project names `app`, `api`, `www`, `dashboard`
and `edge` are reserved so they can't collide with infrastructure hostnames.

Create a Cloudflare API token with **Zone → DNS → Edit** permission for the zone.

## 3. Configure

```bash
git clone <your fork> orbit && cd orbit
cp .env.example .env
```

Edit `.env`:

```bash
ORBIT_ROOT_DOMAIN=example.com
GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)
CLOUDFLARE_API_TOKEN=...
```

Edit `deploy/Caddyfile`:

1. Replace `example.com` and the email.
2. Generate a password hash and paste it into both `basic_auth` blocks:
   ```bash
   docker run --rm caddy:2 caddy hash-password --plaintext 'a-long-password'
   ```

## 4. Run

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.vps.yml up -d --build
```

What the override changes:

- `ORBIT_PUBLIC_PROTOCOL=https` and `ORBIT_PUBLIC_EDGE_PORT=443`, so the dashboard renders `https://…example.com` URLs.
- `ORBIT_BUILDER=docker` forces isolated builds. **Never run the child-process builder on a public server**,
  because builds execute arbitrary code from the repository.
- The dashboard is built with `NEXT_PUBLIC_API_URL=https://app.example.com`. Caddy routes `/api/*` on that origin to the
  control plane, so the browser's basic-auth credentials also cover `fetch()` and the SSE log stream.
- It adds a `caddy` service (host networking) built from `deploy/caddy.Dockerfile` with the DNS module.

Watch the first certificate being issued:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.vps.yml logs -f caddy
```

## 5. GitHub webhook

In each repository: **Settings → Webhooks → Add webhook**

- Payload URL: `https://app.example.com/api/webhooks/github`
- Content type: `application/json`
- Secret: the `GITHUB_WEBHOOK_SECRET` value
- Events: *Just the push event*

The webhook path is the only API route exempt from basic auth. It's authenticated by the HMAC
signature instead (`X-Hub-Signature-256`, constant-time compare). Pushes to a project's production
branch deploy to production, and other branches create previews.

## 6. Operations

- **State** lives in `./data` (SQLite DB, artifacts, logs). Back it up with
  `sqlite3 data/orbit.db ".backup data/orbit-backup.db"` plus a copy of `data/artifacts`.
- **Updating**: `git pull && docker compose … up -d --build`. Queued builds survive restarts. Builds that
  were running when the control plane stopped are marked as errors, and you can redeploy them.
- **Disk**: artifacts are immutable and never garbage-collected in this version. Deleting a project
  removes its artifacts.
- **Docker socket**: the control plane can start containers on the host. That's how build isolation works,
  and it's also why the dashboard must stay behind auth.

## Hardening ideas (not implemented)

- Run builds in gVisor (`--runtime=runsc`) or Firecracker microVMs instead of plain containers.
- Egress filtering for build containers (allow only the npm registry and GitHub).
- Per-project build secrets that are hidden from build logs.
- Serve artifacts from object storage behind a CDN, and have the edge read alias config from a KV store
  instead of SQLite.

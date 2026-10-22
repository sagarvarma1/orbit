# Self-hosting Orbit

Orbit runs on one Linux server with Docker. Caddy terminates HTTPS in front of it and issues certificates
automatically.

```
https://app.example.com                    dashboard + API
https://my-app.example.com                 production
https://my-app-git-feature-x.example.com   latest deployment of a branch
https://dpl-k3x9q2m1za.example.com         one immutable deployment
https://www.my-own-domain.com              a custom domain on a project
```

## Requirements

- A Linux server with 2+ vCPU and 4 GB RAM (builds are the heavy part). x86-64 or ARM64.
- Ports 80 and 443 open to the internet.
- A domain whose DNS you control.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/sagarvarma1/orbit/main/install.sh | sudo bash
```

It asks for three things (or reads them from the environment for unattended installs):

| Setting             | Example           | Used for                                     |
| ------------------- | ----------------- | -------------------------------------------- |
| `ORBIT_ROOT_DOMAIN` | `example.com`     | Deployments at `<name>.example.com`          |
| `ORBIT_APP_DOMAIN`  | `app.example.com` | The dashboard and API (default `app.<root>`) |
| `ACME_EMAIL`        | `you@example.com` | Let's Encrypt expiry notices                 |

```bash
curl -fsSL https://raw.githubusercontent.com/sagarvarma1/orbit/main/install.sh \
  | sudo ORBIT_ROOT_DOMAIN=example.com ACME_EMAIL=you@example.com bash
```

Everything lives in `/opt/orbit`: `docker-compose.yml`, `Caddyfile`, `.env` and `data/` (SQLite database,
deployment artifacts, logs and build cache).

## DNS

Create one wildcard record pointing at the server:

| Type | Name            | Value          |
| ---- | --------------- | -------------- |
| A    | `*.example.com` | your server IP |

It covers the dashboard (`app.example.com`) and every deployment. If the dashboard is on a different domain, add an
`A` record for it as well.

## First run

1. Open `https://app.example.com/setup`. The first request takes a few seconds while the certificate is issued.
2. Enter the setup code the installer printed. Lost it? `cd /opt/orbit && docker compose logs api | grep "SETUP CODE"`.
3. Create the admin account.
4. **Settings → GitHub → Create GitHub App.** GitHub shows a pre-filled form; confirm it, then choose the
   repositories Orbit may access. Pushes now arrive through the app's webhook, and private repositories work.
5. **New Project** → pick a repository → Deploy.

## Custom domains

Project → Settings → Domains → add `www.my-own-domain.com`. The dashboard shows the DNS record to create:

- **Subdomain** (`www.…`, `shop.…`): `CNAME` to your Orbit dashboard host (`app.example.com`).
- **Apex** (`my-own-domain.com`): `A` record to the server IP.

Once DNS resolves, the first HTTPS request gets a certificate. A domain can follow production (default) or a branch.

## How certificates work

Caddy uses **on-demand TLS**: when a request arrives for a hostname without a certificate, Caddy asks Orbit
(`GET /api/tls/allowed?domain=…`) and only requests a certificate if Orbit serves that hostname: the dashboard,
an existing deployment or alias, or a custom domain. No DNS provider credentials are needed.

Let's Encrypt allows 50 certificates per registered domain per week, and every deployment hostname that gets visited
needs one. If you open many preview URLs, switch to a **wildcard certificate**: build Caddy with your DNS provider's
module and replace the `https://` block in the `Caddyfile`:

```caddyfile
*.example.com {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	reverse_proxy edge:8080
}
```

(Keep the on-demand block too if you use custom domains.)

## Upgrading

```bash
cd /opt/orbit
docker compose pull && docker compose up -d
```

Pin a version with `ORBIT_VERSION=0.2.0` in `.env`. Database migrations run automatically on start.

## Backups

Back up `/opt/orbit/data` (and `.env`). For a consistent copy of the database, stop the API first or use
`sqlite3 data/orbit.db ".backup backup.db"`.

## Forgotten password

Set `ORBIT_RESET_ADMIN_PASSWORD=<new password>` in `.env`, run `docker compose up -d`, sign in, then remove the
variable and run `docker compose up -d` again.

## Troubleshooting

- **Certificate errors on first visit**: DNS isn't pointing at the server yet, or ports 80/443 are blocked.
  `docker compose logs caddy` shows the ACME attempts.
- **Builds fail with "Cannot connect to the Docker daemon"**: the API container needs `/var/run/docker.sock`.
- **Pushes don't deploy**: check the GitHub App is installed on the repository (Settings → GitHub). Orbit also polls
  every 60 seconds as a fallback.

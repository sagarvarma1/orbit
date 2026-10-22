# Caddy with the Cloudflare DNS module (needed for wildcard certificates via DNS-01).
# Swap the module for your DNS provider: https://caddyserver.com/docs/modules/ (dns.providers.*)
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

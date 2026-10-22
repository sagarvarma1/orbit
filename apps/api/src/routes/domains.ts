import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, requireProject } from "../context.js";
import type { Config } from "../config.js";
import type { Domain } from "../db/repo.js";
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors.js";
import { DEPLOYMENT_ID_RE } from "../lib/ids.js";

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** The dashboard's host: the name the server itself answers to, so domains can point at it. */
export function appHost(config: Pick<Config, "dashboardUrl">): string {
  return new URL(config.dashboardUrl).hostname.toLowerCase();
}

/** Accepts "Example.com", "https://www.example.com/path" and similar; returns a bare hostname. */
export function normalizeDomain(input: string, config: Pick<Config, "rootDomain" | "dashboardUrl">): string {
  let host = input.trim().toLowerCase();
  host = host
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (isIP(host) || !HOSTNAME_RE.test(host)) throw new BadRequestError(`"${input}" is not a valid domain name`);
  const root = config.rootDomain.toLowerCase();
  if (host === root || host.endsWith(`.${root}`)) {
    throw new BadRequestError(`Domains under ${root} are assigned automatically; add a domain you own instead`);
  }
  if (host === appHost(config)) throw new BadRequestError("That domain is used by the Orbit dashboard");
  return host;
}

export interface DnsStatus {
  /** null when it can't be checked (e.g. Orbit running on localhost). */
  configured: boolean | null;
  /** What to create at the DNS provider. */
  record: { type: "A" | "CNAME"; name: string; value: string } | null;
  detail: string;
}

const resolver = new Resolver({ timeout: 3000, tries: 1 });
const resolve4 = (host: string) => resolver.resolve4(host).catch(() => [] as string[]);
const resolveCname = (host: string) => resolver.resolveCname(host).catch(() => [] as string[]);

/** Apex domains need an A record; subdomains can CNAME to the Orbit server. */
const isApex = (host: string) => host.split(".").length === 2;

export async function checkDns(hostname: string, config: Pick<Config, "dashboardUrl" | "publicIp">): Promise<DnsStatus> {
  const server = appHost(config);
  const serverIps = config.publicIp ? [config.publicIp] : server === "localhost" ? [] : await resolve4(server);
  const record: DnsStatus["record"] = isApex(hostname)
    ? serverIps[0]
      ? { type: "A", name: "@", value: serverIps[0] }
      : null
    : { type: "CNAME", name: hostname.split(".")[0]!, value: server };
  if (serverIps.length === 0) {
    return { configured: null, record, detail: "DNS can't be checked while Orbit runs on localhost." };
  }
  const [ips, cnames] = await Promise.all([resolve4(hostname), resolveCname(hostname)]);
  if (cnames.some((c) => c.toLowerCase().replace(/\.$/, "") === server) || ips.some((ip) => serverIps.includes(ip))) {
    return { configured: true, record, detail: "Valid configuration" };
  }
  const now = ips.length ? `It currently points to ${ips.join(", ")}.` : "It doesn't resolve yet.";
  return { configured: false, record, detail: `${now} DNS changes can take a few minutes to apply.` };
}

const addDomainInput = z.object({
  hostname: z.string().min(1).max(260),
  branch: z.string().min(1).max(200).nullable().optional(),
});

export function domainRoutes(app: FastifyInstance, ctx: AppContext): void {
  const withUrl = (d: Domain) => ({ ...d, url: `${ctx.config.publicProtocol}://${d.hostname}` });

  app.get<{ Params: { id: string } }>("/api/projects/:id/domains", async (req) => {
    const project = requireProject(ctx, req.params.id);
    const domains = ctx.repo.listDomains(project.id);
    const statuses = await Promise.all(domains.map((d) => checkDns(d.hostname, ctx.config)));
    return { domains: domains.map((d, i) => ({ ...withUrl(d), dns: statuses[i] })) };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/domains", async (req, reply) => {
    const project = requireProject(ctx, req.params.id);
    const input = addDomainInput.parse(req.body);
    const hostname = normalizeDomain(input.hostname, ctx.config);
    const existing = ctx.repo.getDomain(hostname);
    if (existing) {
      const owner = ctx.repo.getProject(existing.projectId);
      throw new ConflictError(
        `${hostname} is already assigned to ${owner?.name === project.name ? "this project" : `project "${owner?.name}"`}`,
      );
    }
    const domain: Domain = { hostname, projectId: project.id, branch: input.branch ?? null, createdAt: Date.now() };
    ctx.repo.insertDomain(domain);
    reply.code(201);
    return { domain: { ...withUrl(domain), dns: await checkDns(hostname, ctx.config) } };
  });

  app.delete<{ Params: { id: string; hostname: string } }>("/api/projects/:id/domains/:hostname", async (req) => {
    const project = requireProject(ctx, req.params.id);
    const domain = ctx.repo.getDomain(req.params.hostname.toLowerCase());
    if (!domain || domain.projectId !== project.id) throw new NotFoundError("Domain not found in this project");
    ctx.repo.deleteDomain(domain.hostname);
    return { ok: true };
  });

  /**
   * Caddy's on-demand TLS asks here before requesting a certificate, so certificates are only
   * issued for hostnames Orbit actually serves (otherwise anyone could make it request
   * certificates for arbitrary names pointed at the server).
   */
  app.get("/api/tls/allowed", async (req, reply) => {
    const host = String((req.query as { domain?: string }).domain ?? "")
      .toLowerCase()
      .replace(/\.$/, "");
    reply.header("cache-control", "no-store");
    if (host && host === appHost(ctx.config)) return { allowed: true };
    if (ctx.repo.getDomain(host)) return { allowed: true };
    const suffix = `.${ctx.config.rootDomain}`;
    if (host.endsWith(suffix)) {
      const label = host.slice(0, -suffix.length);
      const known = DEPLOYMENT_ID_RE.test(label) ? ctx.repo.getDeployment(label) : ctx.repo.getAlias(label);
      if (known) return { allowed: true };
    }
    return reply.code(404).send({ allowed: false });
  });
}

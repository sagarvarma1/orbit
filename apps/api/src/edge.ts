/**
 * Edge: routes requests by Host header to immutable deployment artifacts.
 * Read-only: it never builds or writes, so it keeps serving even if the control plane is down.
 */
import http from "node:http";
import { config } from "./config.js";
import { openDb } from "./db/index.js";
import { Repo } from "./db/repo.js";
import { createEdgeHandler, type TargetLookup } from "./edge/server.js";
import { DEPLOYMENT_ID_RE } from "./lib/ids.js";
import { blockingParent, disableSandbox, installFirewall, lockDataDir, sandboxAvailable } from "./lib/sandbox.js";
import { branchAliasLabel } from "./lib/urls.js";

const repo = new Repo(openDb(config.dbPath));

// Deployment code runs as per-project users (Linux, as root); keep it away from Orbit's own state.
const blocked = sandboxAvailable() ? blockingParent(config.dataDir) : null;
if (blocked) {
  disableSandbox(`${blocked} isn't traversable`);
  console.error(
    `Sandbox: per-project users OFF: other users can't pass through ${blocked} to reach the data directory. Run \`chmod o+x ${blocked}\` and restart.`,
  );
}
if (sandboxAvailable()) {
  lockDataDir(config);
  const firewall = installFirewall();
  console.log(`Sandbox: per-project users on · firewall ${firewall.ok ? "on" : "OFF"}: ${firewall.detail}`);
  if (!firewall.ok)
    console.warn("  Give the edge container NET_ADMIN (see deploy/docker-compose.yml) to block private networks.");
} else {
  console.log("Sandbox: Node permission model only (per-project users need Linux and root)");
}

/** `<deploymentId>` is an immutable preview; anything else is an alias (production or branch). */
const lookup: TargetLookup = {
  resolve(label) {
    const deploymentId = DEPLOYMENT_ID_RE.test(label) ? label : repo.getAlias(label)?.deploymentId;
    if (!deploymentId) return null;
    const deployment = repo.getDeployment(deploymentId);
    return deployment ? { deploymentId: deployment.id, status: deployment.status } : null;
  },
  /** A custom domain follows its project's production alias, or a branch alias. */
  resolveDomain(hostname) {
    const domain = repo.getDomain(hostname);
    const project = domain && repo.getProject(domain.projectId);
    if (!domain || !project) return null;
    return this.resolve(domain.branch ? branchAliasLabel(project.name, domain.branch) : project.name);
  },
  sandboxId: (deploymentId) => repo.sandboxId(deploymentId),
};

const handle = createEdgeHandler({
  rootDomain: config.rootDomain,
  artifactsDir: config.artifactsDir,
  lookup,
  functionTimeoutMs: config.functionTimeoutMs,
  functionMemoryMb: config.functionMemoryMb,
  functionCacheBytes: config.functionCacheMb * 1024 * 1024,
  servers: {
    maxServers: config.serverMax,
    memoryMb: config.serverMemoryMb,
    idleTimeoutMs: config.serverIdleTimeoutSeconds * 1000,
  },
  functionWarm: {
    maxIdlePerFunction: config.functionWarmPerFunction,
    maxIdle: config.functionWarmMax,
    idleTimeoutMs: config.functionIdleTimeoutSeconds * 1000,
  },
  log: (message) => console.log(message),
});

const logRequests = process.env.EDGE_LOG_REQUESTS === "1";

const server = http.createServer((req, res) => {
  const started = Date.now();
  if (logRequests)
    res.on("finish", () =>
      console.log(`${res.statusCode} ${req.method} ${req.headers.host}${req.url} ${Date.now() - started}ms`),
    );
  handle(req, res).catch((err) => {
    console.error("[edge]", err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal edge error");
  });
});

server.listen(config.edgePort, config.host, () => {
  console.log(`Orbit edge on :${config.edgePort} · serving *.${config.rootDomain} · artifacts: ${config.artifactsDir}`);
});

// App servers and function processes are children of the edge; don't leave them running.
process.on("exit", () => handle.close());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));

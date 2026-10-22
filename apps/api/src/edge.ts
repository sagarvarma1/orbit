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

const repo = new Repo(openDb(config.dbPath));

/** `<deploymentId>` is an immutable preview; anything else is an alias (production or branch). */
const lookup: TargetLookup = {
  resolve(label) {
    const deploymentId = DEPLOYMENT_ID_RE.test(label) ? label : repo.getAlias(label)?.deploymentId;
    if (!deploymentId) return null;
    const deployment = repo.getDeployment(deploymentId);
    return deployment ? { deploymentId: deployment.id, status: deployment.status } : null;
  },
};

const handle = createEdgeHandler({
  rootDomain: config.rootDomain,
  artifactsDir: config.artifactsDir,
  lookup,
  functionTimeoutMs: config.functionTimeoutMs,
  functionMemoryMb: config.functionMemoryMb,
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

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));

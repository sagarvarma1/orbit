/**
 * sandboxd: starts and stops the sandbox containers that run deployment code (functions and
 * app servers). It is the only Orbit process with the Docker socket at runtime and the only one
 * that changes the host firewall; the edge, which handles untrusted traffic, asks it for
 * instances over a unix socket in the data directory that only root can open.
 *
 *   POST   /v1/instances           {kind, runtime, deploymentId, entry, memoryMb, sandboxId} -> {id, socketPath}
 *   GET    /v1/instances/:id/wait  resolves when the instance stops -> {reason}
 *   DELETE /v1/instances/:id
 *   POST   /v1/reset               stop everything (the edge restarted)
 *   GET    /v1/health
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { installSandboxFirewall } from "./sandbox/firewall.js";
import { type CreateInstance, SandboxManager, SandboxRequestError } from "./sandbox/manager.js";
import { LaunchError } from "./edge/launcher.js";

const manager = new SandboxManager({
  dataDir: config.dataDir,
  hostDataDir: config.hostDataDir,
  artifactsDir: config.artifactsDir,
  image: config.runtimeImage,
  runtime: config.sandboxRuntime,
  maxInstances: config.sandboxMaxInstances,
  maxMemoryMb: Math.max(config.functionMaxMemoryMb, config.serverMemoryMb),
  dockerSocket: config.dockerSocket,
  log: (message) => console.log(message),
});

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new SandboxRequestError("body too large");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new SandboxRequestError("invalid JSON");
  }
}

let firewall = { ok: false, detail: "not installed" };

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://sandboxd");
  const instance = /^\/v1\/instances\/([a-f0-9]{12})(\/wait)?$/.exec(url.pathname);
  if (req.method === "POST" && url.pathname === "/v1/instances") {
    const created = await manager.create((await readJson(req)) as CreateInstance);
    return send(res, 201, created);
  }
  if (req.method === "GET" && instance?.[2]) {
    req.socket.setTimeout(0);
    return send(res, 200, { reason: await manager.wait(instance[1]!) });
  }
  if (req.method === "DELETE" && instance && !instance[2]) {
    await manager.stop(instance[1]!);
    return send(res, 204);
  }
  if (req.method === "POST" && url.pathname === "/v1/reset") return send(res, 200, { stopped: await manager.reset() });
  if (req.method === "GET" && url.pathname === "/v1/health") {
    return send(res, 200, { runtime: manager.runtimeName, image: config.runtimeImage, firewall, instances: manager.size });
  }
  send(res, 404, { error: "not found" });
}

async function main(): Promise<void> {
  if (config.sandboxFirewall) {
    firewall = installSandboxFirewall();
    if (!firewall.ok) {
      console.error(`sandboxd: firewall failed: ${firewall.detail}`);
      console.error("  Run sandboxd with network_mode: host and cap_add: [NET_ADMIN] (see deploy/docker-compose.yml),");
      console.error("  or set ORBIT_SANDBOX_FIREWALL=0 to run deployment code with unrestricted network access.");
      process.exit(1);
    }
  } else {
    firewall = { ok: false, detail: "disabled (ORBIT_SANDBOX_FIREWALL=0)" };
  }
  await manager.init();

  const socketPath = config.sandboxdSocket;
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o711 });
  fs.rmSync(socketPath, { force: true });
  const server = http.createServer((req, res) => {
    route(req, res).catch((err: Error) => {
      const status = err instanceof SandboxRequestError ? 400 : err instanceof LaunchError ? 502 : 500;
      if (status === 500) console.error("[sandboxd]", err);
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 0;
  server.requestTimeout = 0;
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    console.log(
      `Orbit sandboxd · runtime ${manager.runtimeName}${manager.runtimeName === "runsc" ? " (gVisor)" : " (no gVisor: containers share the host kernel)"} · firewall ${firewall.ok ? "on" : "OFF"}: ${firewall.detail} · image ${config.runtimeImage}`,
    );
  });

  const shutdown = () => {
    server.close();
    void manager.reset().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("sandboxd failed to start:", err);
  process.exit(1);
});

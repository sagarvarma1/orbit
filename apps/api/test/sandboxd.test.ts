/**
 * Sandbox containers end to end: a real sandboxd, real Docker, real containers. Needs Linux, root,
 * the Docker socket, the host network namespace and NET_ADMIN, so it only runs with
 * ORBIT_SANDBOXD_TEST=1 (scripts/sandbox-test.sh --containers sets that up in a container).
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEdgeHandler } from "../src/edge/server.js";
import type { DeploymentManifest } from "../src/lib/manifest.js";
import { sandboxFirewallRules } from "../src/sandbox/firewall.js";

describe("sandbox firewall rules", () => {
  it("rejects private ranges and the host, but lets published HTTP(S) through", () => {
    const rules = sandboxFirewallRules().map((r) => r.join(" "));
    expect(rules).toContain("-A ORBIT-SANDBOX -d 10.0.0.0/8 -j REJECT");
    expect(rules).toContain("-A ORBIT-SANDBOX -d 169.254.0.0/16 -j REJECT");
    expect(rules).toContain("-I DOCKER-USER -i orbit-sbx0 -j ORBIT-SANDBOX");
    expect(rules).toContain("-I INPUT -i orbit-sbx0 -j ORBIT-SANDBOX-IN");
    const dnat = rules.findIndex((r) => r.includes("--ctorigdstport 443"));
    expect(dnat).toBeGreaterThan(-1);
    expect(dnat).toBeLessThan(rules.findIndex((r) => r.includes("10.0.0.0/8")));
  });
});

const enabled = process.env.ORBIT_SANDBOXD_TEST === "1";
const DATA = process.env.ORBIT_SANDBOXD_TEST_DIR ?? "/tmp/orbit-sandboxd-test";
const IMAGE = process.env.ORBIT_RUNTIME_IMAGE ?? "orbit-runtime:dev";
const ID = "dpl-sbxtest001";
/** A second deployment: a server-rendered app. */
const SERVER_ID = "dpl-sbxserver1";

const PROBE_JS = `
import fs from "node:fs";
import net from "node:net";
const tryWrite = (p) => { try { fs.writeFileSync(p, "x"); return "ok"; } catch (e) { return e.code; } };
const tryConnect = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 4000 });
  s.once("connect", () => { s.destroy(); resolve("connected"); });
  s.once("timeout", () => { s.destroy(); resolve("timeout"); });
  s.once("error", (e) => resolve(e.code));
});
let counter = 0;
export async function GET(request) {
  const q = new URL(request.url).searchParams;
  if (q.get("oom")) { const a = []; for (;;) a.push(Buffer.alloc(16 * 1024 * 1024, 1)); }
  counter += 1;
  console.log("probe ran " + counter);
  return Response.json({
    uid: process.getuid(),
    counter,
    tmp: tryWrite("/tmp/probe.txt"),
    task: tryWrite("/var/task/probe.txt"),
    etc: tryWrite("/etc/probe.txt"),
    secret: fs.existsSync("/var/run/docker.sock"),
    metadata: await tryConnect("169.254.169.254", 80),
    lan: await tryConnect("10.255.255.1", 80),
    publicNet: q.get("net") ? await tryConnect("1.1.1.1", 443) : null,
    env: process.env.PROBE_VALUE,
  });
}
`;

const PROBE_PY = `
import json, os
from http.server import BaseHTTPRequestHandler

def try_write(p):
    try:
        open(p, "w").write("x")
        return "ok"
    except OSError as e:
        return e.__class__.__name__

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "uid": os.getuid(),
            "tmp": try_write("/tmp/py.txt"),
            "task": try_write("/var/task/py.txt"),
            "path": self.path,
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)
`;

describe.skipIf(!enabled)("sandboxd containers", () => {
  let sandboxd: ChildProcess;
  let edge: http.Server;
  let port: number;
  let handle: ReturnType<typeof createEdgeHandler>;
  const output: string[] = [];
  /** The error page's detail and sandboxd's recent output, for failure messages. */
  const why = (body: string) =>
    `${/<p>([\s\S]*?)<\/p>/.exec(body)?.[1] ?? body}\n--- sandboxd ---\n${output.join("").slice(-3000)}`;

  const get = (urlPath: string, deploymentId = ID) =>
    new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: urlPath, headers: { host: `${deploymentId}.localhost` } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
        })
        .on("error", reject);
    });

  beforeAll(async () => {
    fs.mkdirSync(DATA, { recursive: true });
    for (const entry of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, entry), { recursive: true, force: true });
    const artifact = path.join(DATA, "artifacts", ID);
    fs.mkdirSync(path.join(artifact, "functions", "api"), { recursive: true });
    fs.mkdirSync(path.join(artifact, "static"), { recursive: true });
    fs.writeFileSync(path.join(artifact, "functions", "api", "probe.mjs"), PROBE_JS);
    fs.writeFileSync(path.join(artifact, "functions", "api", "py.py"), PROBE_PY);
    fs.writeFileSync(path.join(artifact, "function-env.json"), JSON.stringify({ PROBE_VALUE: "from-env" }));
    // Shaped like a Next.js standalone server: listens on PORT/HOSTNAME, writes its cache under .next/cache.
    const serverArtifact = path.join(DATA, "artifacts", SERVER_ID);
    const serverDir = path.join(serverArtifact, "server");
    fs.mkdirSync(path.join(serverArtifact, "static"), { recursive: true });
    fs.writeFileSync(path.join(serverArtifact, "function-env.json"), JSON.stringify({ PROBE_VALUE: "from-env" }));
    fs.writeFileSync(
      path.join(serverArtifact, "orbit.json"),
      JSON.stringify({
        version: 1,
        deploymentId: SERVER_ID,
        framework: "nextjs",
        spa: false,
        cleanUrls: false,
        functions: [],
        server: { entry: "server/server.js" },
      }),
    );
    fs.mkdirSync(path.join(serverDir, ".next"), { recursive: true });
    fs.symlinkSync(`../../../../runtime/${SERVER_ID}/cache`, path.join(serverDir, ".next", "cache"));
    fs.writeFileSync(
      path.join(serverDir, "server.js"),
      `const http = require("node:http"), fs = require("node:fs");
       http.createServer((req, res) => {
         fs.writeFileSync(".next/cache/hit.txt", req.url);
         res.setHeader("content-type", "application/json");
         res.end(JSON.stringify({ url: req.url, uid: process.getuid(), cache: fs.readFileSync(".next/cache/hit.txt", "utf8"), env: process.env.PROBE_VALUE }));
       }).listen(Number(process.env.PORT), process.env.HOSTNAME);`,
    );
    const manifest: Partial<DeploymentManifest> = {
      version: 1,
      deploymentId: ID,
      framework: "static",
      spa: false,
      cleanUrls: false,
      functions: [
        { route: "/api/probe", file: "functions/api/probe.mjs", runtime: "node" },
        { route: "/api/oom", file: "functions/api/probe.mjs", runtime: "node", memoryMb: 128 },
        { route: "/api/py", file: "functions/api/py.py", runtime: "python" },
      ],
    };
    fs.writeFileSync(path.join(artifact, "orbit.json"), JSON.stringify(manifest));
    fs.chmodSync(DATA, 0o755);

    sandboxd = spawn(path.resolve("node_modules/.bin/tsx"), ["src/sandboxd.ts"], {
      env: { ...process.env, ORBIT_DATA_DIR: DATA, ORBIT_RUNTIME_IMAGE: IMAGE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    sandboxd.stdout!.on("data", (c) => output.push(String(c)));
    sandboxd.stderr!.on("data", (c) => output.push(String(c)));
    const socket = path.join(DATA, "sandbox", "sandboxd.sock");
    for (let i = 0; i < 200 && !output.join("").includes("Orbit sandboxd"); i++) await new Promise((r) => setTimeout(r, 100));
    expect(output.join("")).toContain("firewall on");
    const expected = process.env.ORBIT_SANDBOXD_EXPECT_RUNTIME;
    if (expected) expect(output.join("")).toContain(`runtime ${expected}`);

    handle = createEdgeHandler({
      rootDomain: "localhost",
      artifactsDir: path.join(DATA, "artifacts"),
      lookup: { resolve: (label) => ({ deploymentId: label, status: "ready" }), sandboxId: () => 7 },
      functionTimeoutMs: 20_000,
      functionMemoryMb: 256,
      functionWarm: { maxIdlePerFunction: 1, maxIdle: 4, idleTimeoutMs: 60_000 },
      sandboxdSocket: socket,
    });
    edge = http.createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => edge.listen(0, "127.0.0.1", r));
    port = (edge.address() as { port: number }).port;
  }, 120_000);

  afterAll(async () => {
    handle?.close();
    edge?.close();
    await new Promise((r) => setTimeout(r, 500));
    sandboxd?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
  });

  it("runs a Node function as the project's user with a read-only filesystem and only /tmp writable", async () => {
    const res = await get("/api/probe?net=1");
    expect(res.status, why(res.body)).toBe(200);
    const probe = JSON.parse(res.body);
    expect(probe.uid).toBe(100_007);
    expect(probe.tmp).toBe("ok");
    expect(probe.task).toBe("EROFS");
    expect(probe.etc).toBe("EROFS");
    expect(probe.secret).toBe(false);
    expect(probe.env).toBe("from-env");
    expect(res.headers["x-orbit-instance"]).toBe("cold");
  }, 60_000);

  it("blocks private networks and the metadata endpoint, but reaches the internet", async () => {
    const probe = JSON.parse((await get("/api/probe?net=1")).body);
    expect(probe.metadata).not.toBe("connected");
    expect(probe.lan).not.toBe("connected");
    expect(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]).toContain(probe.metadata);
    if (process.env.ORBIT_SANDBOXD_TEST_OFFLINE !== "1") expect(probe.publicNet).toBe("connected");
  }, 60_000);

  it("keeps the instance warm between requests", async () => {
    const res = await get("/api/probe");
    expect(res.headers["x-orbit-instance"]).toBe("warm");
    expect(JSON.parse(res.body).counter).toBeGreaterThan(1);
    // Function output reaches sandboxd's log, labeled with the deployment and function.
    await new Promise((r) => setTimeout(r, 300));
    expect(output.join("")).toMatch(new RegExp(`\\[${ID} /api/probe.mjs\\] probe ran`));
  }, 60_000);

  it("enforces the memory limit", async () => {
    const res = await get("/api/oom?oom=1");
    expect(res.status).toBe(500);
    expect(res.body).toMatch(/out of memory|exited unexpectedly/i);
  }, 60_000);

  it("runs an app server in a sandbox, reached through its socket, with a writable cache", async () => {
    const res = await get("/some/page?x=1", SERVER_ID);
    expect(res.status, why(res.body)).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: "/some/page?x=1", uid: 100_007, cache: "/some/page?x=1", env: "from-env" });
  }, 60_000);

  it("runs Python functions in the same sandbox", async () => {
    const res = await get("/api/py?x=1");
    expect(res.status, why(res.body)).toBe(200);
    const probe = JSON.parse(res.body);
    expect(probe).toMatchObject({ uid: 100_007, tmp: "ok", task: "OSError", path: "/api/py?x=1" });
  }, 60_000);
});

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FunctionPool } from "../src/edge/functions.js";
import { ServerPool } from "../src/edge/servers.js";
import {
  firewallRules,
  installFirewall,
  lockArtifact,
  lockDataDir,
  prepareArtifact,
  sandboxAvailable,
  type SandboxIdentity,
} from "../src/lib/sandbox.js";

describe("sandbox firewall rules", () => {
  it("allows replies and Docker's DNS, then rejects private networks and metadata", () => {
    const rules = firewallRules(false).map((r) => r.join(" "));
    const established = rules.findIndex((r) => r.includes("ESTABLISHED"));
    const dns = rules.findIndex((r) => r.includes("127.0.0.11/32 -j RETURN"));
    const loopback = rules.findIndex((r) => r.includes("127.0.0.0/8 -j REJECT"));
    expect(established).toBeGreaterThan(-1);
    expect(dns).toBeGreaterThan(established);
    expect(loopback).toBeGreaterThan(dns);
    for (const net of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]) {
      expect(rules).toContain(`-A ORBIT_SANDBOX -d ${net} -j REJECT`);
    }
    // Re-running replaces the jump instead of stacking duplicates.
    expect(rules.at(-2)).toMatch(/^-D OUTPUT -m owner --uid-owner 100000-\d+ -j ORBIT_SANDBOX$/);
    expect(rules.at(-1)).toMatch(/^-I OUTPUT/);
    expect(firewallRules(true).map((r) => r.join(" "))).toContain("-A ORBIT_SANDBOX -d fc00::/7 -j REJECT");
  });

  it("is off where it can't work", () => {
    if (process.platform !== "linux" || process.getuid?.() !== 0) expect(sandboxAvailable()).toBe(false);
  });
});

/**
 * The real thing: needs Linux and root (CI runs this file in a container). Each test checks
 * the OS layer on its own, without Node's permission model, by running plain `node -e` as the
 * sandbox user.
 */
describe.runIf(sandboxAvailable())("sandbox users (Linux, root)", () => {
  const A: SandboxIdentity = { uid: 100_001, gid: 100_001 };
  const B: SandboxIdentity = { uid: 100_002, gid: 100_002 };
  let root: string;
  let data: { dataDir: string; dbPath: string; artifactsDir: string; logsDir: string; buildsDir: string; cacheDir: string };
  let firewall: { ok: boolean; detail: string };
  let rootServer: http.Server;
  let rootPort: number;

  /** Runs a script as a user; returns its stdout, or the error code it printed. */
  const runAs = (id: SandboxIdentity | null, script: string, cwd = root) => {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd,
      uid: id?.uid,
      gid: id?.gid,
      encoding: "utf8",
      timeout: 10_000,
    });
    return (result.stdout + result.stderr).trim();
  };
  const read = (file: string) =>
    `try { process.stdout.write(require("fs").readFileSync(${JSON.stringify(file)}, "utf8")) } catch (e) { process.stdout.write(e.code) }`;

  function artifact(name: string, id: SandboxIdentity) {
    const dir = path.join(data.artifactsDir, name);
    fs.mkdirSync(path.join(dir, "functions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "functions", "secret.txt"), `${name}-code`);
    fs.writeFileSync(path.join(dir, "function-env.json"), JSON.stringify({ TOKEN: `${name}-token` }));
    fs.writeFileSync(
      path.join(dir, "functions", "whoami.mjs"),
      `export function GET() { return Response.json({ uid: process.getuid() }) }`,
    );
    fs.writeFileSync(
      path.join(dir, "server.js"),
      `require("http").createServer((q, s) => s.end(String(process.getuid()))).listen(process.env.PORT, "127.0.0.1")`,
    );
    lockArtifact(dir);
    prepareArtifact(dir, id);
    return dir;
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-sandbox-"));
    fs.chmodSync(root, 0o755);
    const dataDir = path.join(root, "data");
    data = {
      dataDir,
      dbPath: path.join(dataDir, "orbit.db"),
      artifactsDir: path.join(dataDir, "artifacts"),
      logsDir: path.join(dataDir, "logs"),
      buildsDir: path.join(dataDir, "builds"),
      cacheDir: path.join(dataDir, "cache"),
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(data.dbPath, "database");
    lockDataDir(data);
    fs.writeFileSync(path.join(data.logsDir, "build.log"), "log with a secret");
    artifact("dpl-a", A);
    artifact("dpl-b", B);
    firewall = installFirewall();
    rootServer = http.createServer((_q, s) => s.end("internal"));
    await new Promise<void>((r) => rootServer.listen(0, "127.0.0.1", r));
    rootPort = (rootServer.address() as AddressInfo).port;
  });

  afterAll(() => {
    rootServer?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lets a project read its own code, and nothing else", () => {
    const a = path.join(data.artifactsDir, "dpl-a");
    const b = path.join(data.artifactsDir, "dpl-b");
    expect(runAs(A, read(path.join(a, "functions/secret.txt")))).toBe("dpl-a-code");
    expect(runAs(A, read(path.join(b, "functions/secret.txt")))).toBe("EACCES");
    expect(runAs(A, read(path.join(a, "function-env.json")))).toBe("EACCES");
    expect(runAs(A, read(data.dbPath))).toBe("EACCES");
    expect(runAs(A, read(path.join(data.logsDir, "build.log")))).toBe("EACCES");
    expect(
      runAs(
        A,
        `try { require("fs").readdirSync(${JSON.stringify(data.artifactsDir)}) } catch (e) { process.stdout.write(e.code) }`,
      ),
    ).toBe("EACCES");
    // Root (the edge) still reads everything.
    expect(runAs(null, read(path.join(b, "function-env.json")))).toContain("dpl-b-token");
  });

  it("runs functions as the project's user", async () => {
    const pool = new FunctionPool({ maxIdlePerFunction: 1, maxIdle: 2, idleTimeoutMs: 60_000 });
    try {
      const res = await pool.invoke({
        artifactDir: path.join(data.artifactsDir, "dpl-a"),
        route: { route: "/api/whoami", file: "functions/whoami.mjs" },
        params: {},
        request: { method: "GET", url: "https://a.example/api/whoami", headers: {}, body: Buffer.alloc(0) },
        env: {},
        sandbox: A,
        timeoutMs: 10_000,
        memoryMb: 64,
      });
      expect(JSON.parse(res.body.toString())).toEqual({ uid: A.uid });
    } finally {
      pool.close();
    }
  });

  it("runs app servers as the project's user, with a private runtime directory, reachable by the edge", async () => {
    const pool = new ServerPool({ maxServers: 2, idleTimeoutMs: 60_000, memoryMb: 64 });
    const runtimeDir = path.join(data.dataDir, "runtime", "dpl-b");
    try {
      const body = await pool.use(
        {
          deploymentId: "dpl-b",
          entry: path.join(data.artifactsDir, "dpl-b", "server.js"),
          root: path.join(data.artifactsDir, "dpl-b"),
          runtimeDir,
          env: {},
          sandbox: B,
        },
        (port) => fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()),
      );
      expect(body).toBe(String(B.uid));
      const stat = fs.statSync(runtimeDir);
      expect([stat.uid, stat.mode & 0o777]).toEqual([B.uid, 0o700]);
      expect(
        runAs(A, `try { require("fs").readdirSync(${JSON.stringify(runtimeDir)}) } catch (e) { process.stdout.write(e.code) }`),
      ).toBe("EACCES");
    } finally {
      pool.close();
    }
  });

  it("blocks private networks for project users, not for the edge", () => {
    if (!firewall.ok) {
      // Without NET_ADMIN (or iptables) the firewall can't be installed; the rest still holds.
      console.warn(`firewall not testable here: ${firewall.detail}`);
      return;
    }
    const connect = `require("net").connect(${rootPort}, "127.0.0.1").on("connect", () => { process.stdout.write("connected"); process.exit() }).on("error", (e) => process.stdout.write(e.code))`;
    expect(runAs(null, connect)).toBe("connected");
    expect(runAs(A, connect)).toBe("ECONNREFUSED");
    const metadata = `require("net").connect(80, "169.254.169.254").on("connect", () => { process.stdout.write("connected"); process.exit() }).on("error", (e) => { process.stdout.write(e.code); process.exit() }); setTimeout(() => { process.stdout.write("timeout"); process.exit() }, 3000)`;
    expect(runAs(A, metadata)).toBe("ECONNREFUSED");
    // The rules are idempotent: installing twice leaves one jump in OUTPUT.
    expect(installFirewall().ok).toBe(true);
    const output = execFileSync("iptables", ["-S", "OUTPUT"], { encoding: "utf8" });
    expect(output.match(/ORBIT_SANDBOX/g)).toHaveLength(1);
  });
});

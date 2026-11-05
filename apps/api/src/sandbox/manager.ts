import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exitReason, OutputTail, waitForSocket } from "../edge/launcher.js";
import { DEPLOYMENT_ID_RE } from "../lib/ids.js";
import { FUNCTION_ENV_FILE, type FunctionRuntime } from "../lib/manifest.js";
import { prepareArtifact, prepareRuntimeDir, SANDBOX_UID_BASE, type SandboxIdentity, sandboxAvailable } from "../lib/sandbox.js";
import { DockerApi, DockerError } from "./docker-api.js";
import { SANDBOX_BRIDGE, SANDBOX_NETWORK } from "./firewall.js";

export interface SandboxConfig {
  dataDir: string;
  /** The data directory as the Docker daemon sees it (bind mounts use host paths). */
  hostDataDir: string;
  artifactsDir: string;
  image: string;
  /** "auto" uses gVisor (runsc) when the daemon has it. */
  runtime: string;
  maxInstances: number;
  maxMemoryMb: number;
  dockerSocket: string;
  log?: (message: string) => void;
}

export interface CreateInstance {
  kind: "function" | "server";
  runtime: FunctionRuntime;
  deploymentId: string;
  /** Relative to the artifact: "functions/api/x.mjs" or "server/server.js". */
  entry: string;
  memoryMb: number;
  /** The project's sandbox number; the container runs as uid SANDBOX_UID_BASE + this. */
  sandboxId: number;
}

export class SandboxRequestError extends Error {}

interface Running {
  id: string;
  containerId: string | null;
  deploymentId: string;
  exited: Promise<string>;
  stopFollowing: () => void;
  stopped: boolean;
}

/** Vercel gives a function one vCPU per 1,769 MB of memory. */
export const MB_PER_VCPU = 1769;
/** Vercel's /tmp is 500 MB. */
const TMP_SIZE = "512m";
const MOUNT_ROOT = "/orbit";

/**
 * Runs deployment code in containers, one per function instance or app server, the closest a
 * single server gets to Vercel's microVMs: gVisor (when installed) gives each its own kernel,
 * the root filesystem is read-only with only /tmp writable (and cleared with the instance), code
 * is mounted read-only at /var/task, memory, CPU and processes are capped, every capability is
 * dropped, and the network only reaches the public internet (see firewall.ts).
 */
export class SandboxManager {
  readonly docker: DockerApi;
  private readonly instances = new Map<string, Running>();
  runtimeName = "runc";
  private readonly instancesDir: string;
  private readonly resolvConf: string;

  constructor(readonly config: SandboxConfig) {
    this.docker = new DockerApi(config.dockerSocket);
    this.instancesDir = path.join(config.dataDir, "sandbox", "i");
    this.resolvConf = path.join(config.dataDir, "sandbox", "resolv.conf");
  }

  private log(message: string): void {
    this.config.log?.(message);
  }

  /** Host path for a path inside the data directory. */
  private hostPath(p: string): string {
    return path.join(this.config.hostDataDir, path.relative(this.config.dataDir, p));
  }

  /** Picks the runtime, makes the network and image ready, and removes leftovers from a previous run. */
  async init(): Promise<void> {
    const info = await this.docker.request<{ Runtimes?: Record<string, unknown> }>("GET", "/info");
    const available = Object.keys(info.Runtimes ?? {});
    if (this.config.runtime === "auto") this.runtimeName = available.includes("runsc") ? "runsc" : "runc";
    else if (!available.includes(this.config.runtime)) {
      throw new Error(`Docker has no "${this.config.runtime}" runtime (available: ${available.join(", ")})`);
    } else this.runtimeName = this.config.runtime;

    try {
      await this.docker.request("GET", `/networks/${SANDBOX_NETWORK}`);
    } catch (err) {
      if (!(err instanceof DockerError) || err.status !== 404) throw err;
      await this.docker.request("POST", "/networks/create", {
        Name: SANDBOX_NETWORK,
        Driver: "bridge",
        Labels: { "orbit.sandbox": "1" },
        Options: {
          "com.docker.network.bridge.name": SANDBOX_BRIDGE,
          "com.docker.network.bridge.enable_icc": "false",
        },
      });
    }

    try {
      await this.docker.request("GET", `/images/${encodeURIComponent(this.config.image)}/json`);
    } catch (err) {
      if (!(err instanceof DockerError) || err.status !== 404) throw err;
      this.log(`Pulling ${this.config.image}…`);
      const [repo, tag = "latest"] = splitImage(this.config.image);
      await this.docker.request(
        "POST",
        `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
        undefined,
        600_000,
      );
    }

    // Public resolvers, so name lookups never depend on Docker's embedded DNS (which gVisor bypasses)
    // or on resolvers on the private network.
    fs.mkdirSync(path.dirname(this.resolvConf), { recursive: true });
    fs.writeFileSync(this.resolvConf, "nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:2 attempts:2\n", { mode: 0o644 });
    await this.reset();
  }

  /** Stops every sandbox container (on start, and when the edge restarts and forgets its instances). */
  async reset(): Promise<number> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["orbit.sandbox=1"] }));
    const containers = await this.docker.request<{ Id: string }[]>("GET", `/containers/json?all=1&filters=${filters}`);
    await Promise.all(containers.map((c) => this.docker.request("DELETE", `/containers/${c.Id}?force=1`).catch(() => undefined)));
    for (const instance of this.instances.values()) instance.stopFollowing();
    this.instances.clear();
    fs.rmSync(this.instancesDir, { recursive: true, force: true });
    fs.mkdirSync(this.instancesDir, { recursive: true, mode: 0o711 });
    return containers.length;
  }

  get size(): number {
    return this.instances.size;
  }

  private validate(req: CreateInstance): { artifactDir: string; identity: SandboxIdentity } {
    if (req.kind !== "function" && req.kind !== "server") throw new SandboxRequestError("kind must be function or server");
    if (req.runtime !== "node" && req.runtime !== "python") throw new SandboxRequestError("runtime must be node or python");
    if (req.kind === "server" && req.runtime !== "node") throw new SandboxRequestError("servers run on node");
    if (typeof req.deploymentId !== "string" || !DEPLOYMENT_ID_RE.test(req.deploymentId)) {
      throw new SandboxRequestError("invalid deploymentId");
    }
    if (!Number.isInteger(req.sandboxId) || req.sandboxId < 1 || req.sandboxId > 9_999_999) {
      throw new SandboxRequestError("invalid sandboxId");
    }
    if (!Number.isInteger(req.memoryMb) || req.memoryMb < 64 || req.memoryMb > this.config.maxMemoryMb) {
      throw new SandboxRequestError(`memoryMb must be 64-${this.config.maxMemoryMb}`);
    }
    const artifactDir = path.join(this.config.artifactsDir, req.deploymentId);
    const entry = typeof req.entry === "string" ? path.posix.normalize(req.entry) : "";
    const prefix = req.kind === "function" ? "functions/" : "server/";
    if (!entry.startsWith(prefix) || entry.split("/").includes("..") || path.isAbsolute(entry)) {
      throw new SandboxRequestError("invalid entry");
    }
    const real = path.join(artifactDir, entry);
    if (!fs.existsSync(real) || !fs.statSync(real).isFile()) throw new SandboxRequestError(`${entry} not found`);
    if (this.instances.size >= this.config.maxInstances) {
      throw new SandboxRequestError(`At capacity (${this.config.maxInstances} sandboxes running)`);
    }
    const uid = SANDBOX_UID_BASE + req.sandboxId;
    return { artifactDir, identity: { uid, gid: uid } };
  }

  /** Starts a container and resolves once its runtime accepts connections on its socket. */
  async create(req: CreateInstance): Promise<{ id: string; socketPath: string }> {
    const { artifactDir, identity } = this.validate(req);
    // Files readable by the project's group only (they're root-owned otherwise).
    if (sandboxAvailable()) prepareArtifact(artifactDir, identity);

    const id = randomBytes(6).toString("hex");
    const dir = path.join(this.instancesDir, id);
    fs.mkdirSync(dir, { mode: 0o700 });
    if (sandboxAvailable()) fs.chownSync(dir, identity.uid, identity.gid);
    const socketPath = path.join(dir, "s.sock");

    let env: Record<string, string> = {};
    try {
      env = JSON.parse(fs.readFileSync(path.join(artifactDir, FUNCTION_ENV_FILE), "utf8")) as Record<string, string>;
    } catch {
      // no env snapshot
    }
    const heapMb = Math.max(32, Math.floor(req.memoryMb * 0.8));
    const baseEnv: Record<string, string> = {
      ...env,
      NODE_ENV: "production",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
      ORBIT_MEMORY_MB: String(req.memoryMb),
    };
    const binds = [`${this.hostPath(dir)}:${MOUNT_ROOT}/sock`, `${this.hostPath(this.resolvConf)}:/etc/resolv.conf:ro`];
    let cmd: string[];
    let workingDir: string;
    if (req.kind === "function") {
      binds.push(`${this.hostPath(path.join(artifactDir, "functions"))}:/var/task:ro`);
      const file = path.posix.join("/var/task", req.entry.slice("functions/".length));
      cmd =
        req.runtime === "python"
          ? ["python3", "/opt/orbit/python-runner.py", file, `${MOUNT_ROOT}/sock/s.sock`]
          : [
              "node",
              `--max-old-space-size=${heapMb}`,
              "--disable-warning=ExperimentalWarning",
              "/opt/orbit/function-runner.mjs",
              file,
              `${MOUNT_ROOT}/sock/s.sock`,
            ];
      workingDir = "/var/task";
    } else {
      // Mirror the data directory's layout so the server's .next/cache link (relative) resolves.
      const runtimeDir = path.join(this.config.dataDir, "runtime", req.deploymentId);
      fs.mkdirSync(path.join(runtimeDir, "cache"), { recursive: true });
      if (sandboxAvailable()) prepareRuntimeDir(runtimeDir, identity);
      const mountedArtifact = `${MOUNT_ROOT}/artifacts/${req.deploymentId}`;
      binds.push(
        `${this.hostPath(artifactDir)}:${mountedArtifact}:ro`,
        `${this.hostPath(runtimeDir)}:${MOUNT_ROOT}/runtime/${req.deploymentId}`,
      );
      const entry = path.posix.join(mountedArtifact, req.entry);
      cmd = ["node", "/opt/orbit/server-bridge.mjs", entry, `${MOUNT_ROOT}/sock/s.sock`, String(heapMb)];
      workingDir = path.posix.dirname(entry);
    }

    const cpus = Math.min(os.cpus().length, Math.max(0.25, req.memoryMb / MB_PER_VCPU));
    const body = {
      Image: this.config.image,
      Cmd: cmd,
      User: `${identity.uid}:${identity.gid}`,
      WorkingDir: workingDir,
      Env: Object.entries(baseEnv).map(([k, v]) => `${k}=${v}`),
      Labels: { "orbit.sandbox": "1", "orbit.deployment": req.deploymentId, "orbit.instance": id },
      HostConfig: {
        Runtime: this.runtimeName,
        Binds: binds,
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${TMP_SIZE},mode=1777` },
        Memory: req.memoryMb * 1024 * 1024,
        MemorySwap: req.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(cpus * 1e9),
        PidsLimit: 256,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        NetworkMode: SANDBOX_NETWORK,
        Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 4096 }],
        Init: true,
        LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
      },
    };

    const tail = new OutputTail();
    const label = `${req.deploymentId} ${req.kind === "function" ? req.entry.slice("functions".length) : "server"}`;
    const running: Running = {
      id,
      containerId: null,
      deploymentId: req.deploymentId,
      exited: Promise.resolve(""),
      stopFollowing: () => {},
      stopped: false,
    };
    this.instances.set(id, running);
    try {
      const created = await this.docker.request<{ Id: string }>("POST", `/containers/create?name=orbit-${id}`, body);
      running.containerId = created.Id;
      running.exited = this.watch(running, tail);
      await this.docker.request("POST", `/containers/${created.Id}/start`);
      // Following a container that hasn't started ends at once; the log replays from the start anyway.
      running.stopFollowing = this.docker.follow(created.Id, (stream, text) => {
        tail.push(text);
        for (const line of text.split("\n")) if (line.trim()) this.log(`[${label}] ${stream === "stderr" ? "! " : ""}${line}`);
      });
      const started = Date.now();
      await waitForSocket(socketPath, running.exited, 30_000);
      this.log(`[${label}] started (${this.runtimeName}, ${req.memoryMb} MB, ready in ${Date.now() - started}ms)`);
      return { id, socketPath };
    } catch (err) {
      void this.stop(id);
      throw err;
    }
  }

  /** Waits for the container to exit, then removes it and its socket directory. */
  private async watch(running: Running, tail: OutputTail): Promise<string> {
    let reason: string;
    try {
      const result = await this.docker.request<{ StatusCode: number }>(
        "POST",
        `/containers/${running.containerId}/wait?condition=next-exit`,
        undefined,
        2 ** 31 - 1,
      );
      let oom = false;
      try {
        const inspect = await this.docker.request<{ State?: { OOMKilled?: boolean } }>(
          "GET",
          `/containers/${running.containerId}/json`,
        );
        oom = Boolean(inspect.State?.OOMKilled);
      } catch {
        // already removed
      }
      reason = exitReason(running.stopped ? 0 : result.StatusCode, null, tail.toString(), oom || result.StatusCode === 137);
    } catch (err) {
      reason = `Sandbox failed: ${(err as Error).message}`;
    }
    running.stopFollowing();
    this.instances.delete(running.id);
    await this.docker.request("DELETE", `/containers/${running.containerId}?force=1`).catch(() => undefined);
    fs.rmSync(path.join(this.instancesDir, running.id), { recursive: true, force: true });
    return reason;
  }

  /** Resolves with why the instance stopped (immediately if it's unknown). */
  async wait(id: string): Promise<string> {
    const running = this.instances.get(id);
    return running ? running.exited : "Sandbox not found";
  }

  async stop(id: string): Promise<void> {
    const running = this.instances.get(id);
    if (!running) return;
    running.stopped = true;
    if (running.containerId) {
      await this.docker.request("POST", `/containers/${running.containerId}/kill`).catch(() => undefined);
    } else {
      this.instances.delete(id);
      fs.rmSync(path.join(this.instancesDir, id), { recursive: true, force: true });
    }
  }
}

function splitImage(image: string): [string, string | undefined] {
  const at = image.lastIndexOf(":");
  const slash = image.lastIndexOf("/");
  return at > slash ? [image.slice(0, at), image.slice(at + 1)] : [image, undefined];
}

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface ServerPoolOptions {
  /** Servers kept running at once; the least recently used idle one stops to make room. */
  maxServers: number;
  /** Stop a server after this long without requests. */
  idleTimeoutMs: number;
  memoryMb: number;
  /** How long a server may take to start accepting connections. */
  startTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface StartOptions {
  deploymentId: string;
  /** Absolute path of the entry script (e.g. .../artifacts/dpl-x/server/server.js). */
  entry: string;
  /** Read-only root the server may read (the artifact's server/ dir). */
  root: string;
  /** Writable per-deployment directory; the server's .next/cache links into it. */
  runtimeDir: string;
  env: Record<string, string>;
}

export class ServerStartError extends Error {}

interface Running {
  deploymentId: string;
  child: ChildProcess;
  port: number;
  ready: Promise<number>;
  inflight: number;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
  /** Recent output, shown when the server fails to start. */
  output: string[];
  stopped: boolean;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Long-running app servers (Next.js standalone), one per deployment, started on the first request
 * and stopped when idle. Like functions they run under Node's permission model: they can read only
 * their own server directory and write only their runtime directory. A deployment's server never
 * serves another deployment, so rollbacks and previews keep their exact code.
 */
export class ServerPool {
  private readonly servers = new Map<string, Running>();

  constructor(private readonly opts: ServerPoolOptions) {}

  get size(): number {
    return this.servers.size;
  }

  /**
   * Runs `fn` with the port of a ready server for the deployment, starting one if needed.
   * `fn` resolves when the response is finished, so the server isn't stopped mid-request.
   */
  async use<T>(start: StartOptions, fn: (port: number, cold: boolean) => Promise<T>): Promise<T> {
    let server = this.servers.get(start.deploymentId);
    const cold = !server;
    if (!server) server = await this.start(start);
    server.inflight += 1;
    server.lastUsed = Date.now();
    if (server.idleTimer) {
      clearTimeout(server.idleTimer);
      server.idleTimer = null;
    }
    try {
      const port = await server.ready;
      return await fn(port, cold);
    } finally {
      server.inflight -= 1;
      server.lastUsed = Date.now();
      if (server.inflight === 0 && !server.stopped) {
        const s = server;
        s.idleTimer = setTimeout(() => this.stop(s), this.opts.idleTimeoutMs);
        s.idleTimer.unref();
      }
    }
  }

  close(): void {
    for (const server of [...this.servers.values()]) this.stop(server);
  }

  private async start(start: StartOptions): Promise<Running> {
    this.makeRoom();
    const port = await freePort();
    // Another request may have started it while we waited for a port.
    const existing = this.servers.get(start.deploymentId);
    if (existing) return existing;

    fs.mkdirSync(path.join(start.runtimeDir, "cache"), { recursive: true });
    // The permission model checks real paths, so resolve symlinks (macOS: /tmp -> /private/tmp).
    const root = fs.realpathSync(start.root);
    const runtimeDir = fs.realpathSync(start.runtimeDir);
    const entry = fs.realpathSync(start.entry);
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${this.opts.memoryMb}`,
        "--permission",
        `--allow-fs-read=${root}${path.sep}`,
        `--allow-fs-read=${runtimeDir}${path.sep}`,
        `--allow-fs-write=${runtimeDir}${path.sep}`,
        "--disable-warning=ExperimentalWarning",
        entry,
      ],
      {
        cwd: path.dirname(entry),
        env: {
          ...start.env,
          NODE_ENV: "production",
          PATH: process.env.PATH ?? "",
          PORT: String(port),
          HOSTNAME: "127.0.0.1",
          NEXT_TELEMETRY_DISABLED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const server: Running = {
      deploymentId: start.deploymentId,
      child,
      port,
      ready: Promise.resolve(port),
      inflight: 0,
      lastUsed: Date.now(),
      idleTimer: null,
      output: [],
      stopped: false,
    };
    const record = (text: string) => {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        server.output.push(line);
        if (server.output.length > 20) server.output.shift();
        this.opts.log?.(`[server ${start.deploymentId}] ${line}`);
      }
    };
    child.stdout?.setEncoding("utf8").on("data", record);
    child.stderr?.setEncoding("utf8").on("data", record);

    const exited = new Promise<never>((_, reject) => {
      child.on("exit", (code, signal) => {
        server.stopped = true;
        if (this.servers.get(start.deploymentId) === server) this.servers.delete(start.deploymentId);
        if (server.idleTimer) clearTimeout(server.idleTimer);
        const tail = server.output.slice(-5).join("\n");
        reject(new ServerStartError(`The server exited (${signal ?? code})${tail ? `:\n${tail}` : ""}`));
      });
      child.on("error", (err) => reject(new ServerStartError(err.message)));
    });
    exited.catch(() => {});

    server.ready = (async () => {
      const deadline = Date.now() + (this.opts.startTimeoutMs ?? 20_000);
      while (Date.now() < deadline) {
        if (server.stopped) return exited;
        if (await canConnect(port)) return port;
        await Promise.race([new Promise((r) => setTimeout(r, 50)), exited]);
      }
      this.stop(server);
      throw new ServerStartError("The server didn't start listening in time");
    })();
    server.ready.catch(() => this.stop(server));
    this.servers.set(start.deploymentId, server);
    return server;
  }

  /** At the limit, stop the least recently used server that isn't handling a request. */
  private makeRoom(): void {
    while (this.servers.size >= this.opts.maxServers) {
      let oldest: Running | null = null;
      for (const s of this.servers.values()) if (s.inflight === 0 && (!oldest || s.lastUsed < oldest.lastUsed)) oldest = s;
      if (!oldest) return; // all busy: go over the limit rather than fail requests
      this.stop(oldest);
    }
  }

  private stop(server: Running): void {
    if (this.servers.get(server.deploymentId) === server) this.servers.delete(server.deploymentId);
    if (server.idleTimer) clearTimeout(server.idleTimer);
    if (server.stopped) return;
    server.stopped = true;
    server.child.kill("SIGTERM");
    setTimeout(() => server.child.kill("SIGKILL"), 3000).unref();
  }
}

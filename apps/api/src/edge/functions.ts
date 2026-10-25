import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FUNCTIONS_DIR, type FunctionRoute } from "../lib/manifest.js";

const RUNNER = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runtime/function-runner.mjs"));

export interface FunctionRequest {
  method: string;
  /** Absolute URL as the client sees it. */
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface FunctionResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export class FunctionTimeoutError extends Error {}
export class FunctionCrashError extends Error {}

/** Match `/api/users/42` against routes like `/api/users/[id]`. Static segments win. */
export function matchFunction(
  routes: FunctionRoute[],
  urlPath: string,
): { route: FunctionRoute; params: Record<string, string> } | null {
  const parts = urlPath.replace(/\/+$/, "").split("/");
  let best: { route: FunctionRoute; params: Record<string, string>; score: number } | null = null;
  for (const route of routes) {
    const segments = route.route.split("/");
    if (segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let score = 0;
    const ok = segments.every((segment, i) => {
      const dynamic = /^\[(\w+)\]$/.exec(segment);
      if (dynamic) {
        params[dynamic[1]!] = decodeURIComponent(parts[i]!);
        return parts[i] !== "";
      }
      score += 1;
      return segment === parts[i];
    });
    if (ok && (!best || score > best.score)) best = { route, params, score };
  }
  return best ? { route: best.route, params: best.params } : null;
}

export interface InvokeOptions {
  artifactDir: string;
  route: FunctionRoute;
  params: Record<string, string>;
  request: FunctionRequest;
  env: Record<string, string>;
  timeoutMs: number;
  memoryMb: number;
  onLog?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface InvokeResult extends FunctionResponse {
  /** True when an already-running instance served the request. */
  warm: boolean;
}

type RunnerMessage = {
  id: number;
  type: string;
  response?: { status: number; headers: Record<string, string>; body: string };
  message?: string;
};

interface Pending {
  id: number;
  resolve: (res: FunctionResponse) => void;
  reject: (err: Error) => void;
  onLog?: InvokeOptions["onLog"];
  timer: NodeJS.Timeout;
}

/**
 * One function process, using the permission model: it may read only its own bundle and can't
 * write files or spawn processes. It serves one invocation at a time and may serve many in a row.
 */
class Instance {
  private readonly child: ChildProcess;
  private pending: Pending | null = null;
  private nextId = 1;
  dead = false;
  /** When it last finished a request, for the idle timeout. */
  idleSince = Date.now();
  idleTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly key: string,
    functionsDir: string,
    memoryMb: number,
    env: Record<string, string>,
    private readonly onExit: (instance: Instance) => void,
  ) {
    this.child = fork(RUNNER, [], {
      execArgv: [
        `--max-old-space-size=${memoryMb}`,
        "--permission",
        `--allow-fs-read=${functionsDir}${path.sep}`,
        `--allow-fs-read=${RUNNER}`,
        "--disable-warning=ExperimentalWarning",
      ],
      // Like Vercel, the working directory is the function root, so relative reads of included files work.
      cwd: functionsDir,
      env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    this.child.stdout?.setEncoding("utf8").on("data", (t: string) => this.pending?.onLog?.("stdout", t));
    this.child.stderr?.setEncoding("utf8").on("data", (t: string) => this.pending?.onLog?.("stderr", t));
    this.child.on("message", (msg: RunnerMessage) => {
      const pending = this.pending;
      if (!pending || msg.id !== pending.id) return;
      if (msg.type === "response" && msg.response) {
        const { status, headers, body } = msg.response;
        this.settle((p) => p.resolve({ status, headers, body: Buffer.from(body, "base64") }));
      } else {
        this.settle((p) => p.reject(new FunctionCrashError(msg.message ?? "Function crashed")));
      }
    });
    this.child.on("error", (err) => this.die(err));
    this.child.on("exit", (code, sig) =>
      this.die(
        new FunctionCrashError(
          code === 0 || code === 13
            ? "Function finished without returning a response"
            : `Function exited unexpectedly (${sig ?? code})`,
        ),
      ),
    );
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  run(opts: InvokeOptions, file: string): Promise<FunctionResponse> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.settle((p) => p.reject(new FunctionTimeoutError(`Function timed out after ${opts.timeoutMs}ms`)));
        this.kill(); // it may still be running; it can't be reused
      }, opts.timeoutMs);
      this.pending = { id, resolve, reject, onLog: opts.onLog, timer };
      this.setRef(true);
      this.child.send({
        id,
        file,
        request: { ...opts.request, body: opts.request.body.toString("base64") },
        params: opts.params,
      });
    });
  }

  kill(): void {
    if (!this.dead) this.child.kill("SIGKILL");
  }

  /** Idle instances shouldn't keep the edge process alive on shutdown. */
  setRef(ref: boolean): void {
    const channel = this.child.channel as { ref(): void; unref(): void } | null | undefined;
    if (ref) {
      this.child.ref();
      channel?.ref();
    } else {
      this.child.unref();
      channel?.unref();
    }
  }

  private settle(fn: (p: Pending) => void): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    fn(pending);
  }

  private die(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.settle((p) => p.reject(err));
    this.onExit(this);
  }
}

export interface PoolOptions {
  /** Idle instances kept per function (and memory size); 0 = a fresh process for every request. */
  maxIdlePerFunction: number;
  /** Idle instances kept across all functions, oldest stopped first. */
  maxIdle: number;
  idleTimeoutMs: number;
}

/**
 * Keeps function processes warm between requests, like Vercel: the first request to a function
 * starts a process (cold), later ones reuse it (warm), so module-level setup runs once. Each
 * instance handles one request at a time; concurrent requests start more instances, and only a
 * few idle ones are kept, each stopped after `idleTimeoutMs`. Instances are keyed by the bundle
 * path, which includes the deployment ID, so a new deployment never reuses an old process.
 */
export class FunctionPool {
  private readonly idle = new Map<string, Instance[]>();
  private readonly all = new Set<Instance>();

  constructor(private readonly opts: PoolOptions) {}

  /** Running processes (busy and idle). */
  get size(): number {
    return this.all.size;
  }

  async invoke(opts: InvokeOptions): Promise<InvokeResult> {
    // The permission model checks real paths, so resolve symlinks (macOS: /tmp -> /private/tmp).
    const artifactDir = fs.realpathSync(opts.artifactDir);
    const file = path.join(artifactDir, opts.route.file);
    const key = `${file}\0${opts.memoryMb}`;

    let instance = this.takeIdle(key);
    const warm = instance !== undefined;
    if (!instance) {
      instance = new Instance(key, path.join(artifactDir, FUNCTIONS_DIR), opts.memoryMb, opts.env, (i) => this.forget(i));
      this.all.add(instance);
    }
    try {
      const response = await instance.run(opts, file);
      this.release(instance);
      return { ...response, warm };
    } catch (err) {
      instance.kill();
      throw err;
    }
  }

  /** Stops every instance. */
  close(): void {
    for (const instance of this.all) instance.kill();
  }

  private takeIdle(key: string): Instance | undefined {
    const list = this.idle.get(key);
    const instance = list?.pop();
    if (list && list.length === 0) this.idle.delete(key);
    if (instance?.idleTimer) clearTimeout(instance.idleTimer);
    return instance;
  }

  private release(instance: Instance): void {
    if (instance.dead) return;
    const list = this.idle.get(instance.key) ?? [];
    if (list.length >= this.opts.maxIdlePerFunction) return instance.kill();
    list.push(instance);
    this.idle.set(instance.key, list);
    instance.idleSince = Date.now();
    instance.setRef(false);
    instance.idleTimer = setTimeout(() => this.retire(instance), this.opts.idleTimeoutMs);
    instance.idleTimer.unref();

    let idleCount = 0;
    for (const l of this.idle.values()) idleCount += l.length;
    for (; idleCount > this.opts.maxIdle; idleCount--) {
      const oldest = this.oldestIdle();
      if (oldest) this.retire(oldest);
    }
  }

  /** Stops an idle instance; removed right away so it can't be handed out while it exits. */
  private retire(instance: Instance): void {
    this.forget(instance);
    instance.kill();
  }

  private oldestIdle(): Instance | undefined {
    let oldest: Instance | undefined;
    for (const list of this.idle.values()) for (const i of list) if (!oldest || i.idleSince < oldest.idleSince) oldest = i;
    return oldest;
  }

  private forget(instance: Instance): void {
    this.all.delete(instance);
    const list = this.idle.get(instance.key);
    if (!list) return;
    const remaining = list.filter((i) => i !== instance);
    if (remaining.length) this.idle.set(instance.key, remaining);
    else this.idle.delete(instance.key);
  }
}

/** A single cold invocation in a fresh process that exits afterwards. */
export async function invokeFunction(opts: InvokeOptions): Promise<FunctionResponse> {
  const pool = new FunctionPool({ maxIdlePerFunction: 0, maxIdle: 0, idleTimeoutMs: 0 });
  const { warm: _warm, ...response } = await pool.invoke(opts);
  return response;
}

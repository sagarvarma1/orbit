import fs from "node:fs";
import path from "node:path";
import type { FunctionRoute } from "../lib/manifest.js";
import type { SandboxIdentity } from "../lib/sandbox.js";
import { type Launched, type Launcher, LaunchError, ProcessLauncher, requestInstance } from "./launcher.js";

export { deprioritize, SANDBOX_NICE } from "./launcher.js";

export interface FunctionRequest {
  method: string;
  /** Absolute URL as the client sees it. */
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface FunctionResponse {
  status: number;
  /** `set-cookie` may hold several values. */
  headers: Record<string, string | string[]>;
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
  /** The deployment the function belongs to (defaults to the artifact directory's name). */
  deploymentId?: string;
  route: FunctionRoute;
  params: Record<string, string>;
  request: FunctionRequest;
  env: Record<string, string>;
  /** Process mode: run as this OS user (Linux, when the edge is root). */
  sandbox?: SandboxIdentity | null;
  /** The project's sandbox number, for container mode. */
  sandboxId?: number | null;
  timeoutMs: number;
  memoryMb: number;
  onLog?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface InvokeResult extends FunctionResponse {
  /** True when an already-running instance served the request. */
  warm: boolean;
}

/** Headers only the edge may set; anything a client sends with these names is dropped. */
const INTERNAL_HEADERS = ["x-orbit-params", "x-orbit-error"];

/**
 * One function instance (a process or a sandbox container), serving one request at a time like a
 * Vercel instance. Module-level state survives between requests while it stays warm.
 */
class Instance {
  dead = false;
  busy = false;
  /** When it last finished a request, for the idle timeout. */
  idleSince = Date.now();
  idleTimer: NodeJS.Timeout | null = null;
  private onLog: InvokeOptions["onLog"];

  constructor(
    readonly key: string,
    private readonly launched: Launched,
    private readonly onExit: (instance: Instance) => void,
  ) {
    void launched.exited.then(() => {
      this.dead = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.onExit(this);
    });
  }

  log(stream: "stdout" | "stderr", text: string): void {
    this.onLog?.(stream, text);
  }

  async run(opts: InvokeOptions): Promise<FunctionResponse> {
    this.busy = true;
    this.onLog = opts.onLog;
    try {
      try {
        await this.launched.ready;
      } catch (err) {
        throw new FunctionCrashError((err as Error).message);
      }
      const url = new URL(opts.request.url);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(opts.request.headers)) {
        if (!INTERNAL_HEADERS.includes(key.toLowerCase())) headers[key] = value;
      }
      headers["x-forwarded-host"] ??= url.host;
      headers["x-forwarded-proto"] ??= url.protocol.replace(/:$/, "");
      headers["x-orbit-params"] = JSON.stringify(opts.params);
      // Vercel's Python runtime sees dynamic segments in the query string.
      let search = url.search;
      if (opts.route.runtime === "python" && Object.keys(opts.params).length) {
        const query = new URLSearchParams(url.search);
        for (const [k, v] of Object.entries(opts.params)) if (!query.has(k)) query.append(k, v);
        search = `?${query}`;
      }

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.kill(); // it may still be running; it can't be reused
          reject(new FunctionTimeoutError(`Function timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      });
      const crashed = this.launched.exited.then((reason) => {
        throw new FunctionCrashError(reason);
      });
      try {
        const response = await Promise.race([
          requestInstance(this.launched.socketPath, {
            method: opts.request.method,
            path: url.pathname + search,
            headers,
            body: opts.request.body,
          }),
          timeout,
          crashed,
        ]);
        const error = response.headers["x-orbit-error"];
        if (error) {
          // The runtime reported an uncaught error and is exiting; this instance is done.
          this.dead = true;
          throw new FunctionCrashError(Buffer.from(String(error), "base64").toString("utf8"));
        }
        return response;
      } catch (err) {
        if (err instanceof FunctionTimeoutError || err instanceof FunctionCrashError) throw err;
        // The connection broke: the instance died mid-request. Report why if it has exited.
        const reason = await Promise.race([this.launched.exited, new Promise<null>((r) => setTimeout(() => r(null), 500))]);
        throw new FunctionCrashError(reason ?? `Function connection failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.busy = false;
      this.onLog = undefined;
    }
  }

  kill(): void {
    if (this.dead) return;
    this.dead = true;
    this.launched.kill();
  }
}

export interface PoolOptions {
  /** Idle instances kept per function (and memory size); 0 = a fresh instance for every request. */
  maxIdlePerFunction: number;
  /** Idle instances kept across all functions, oldest stopped first. */
  maxIdle: number;
  idleTimeoutMs: number;
  /** How instances are started; local processes by default. */
  launcher?: Launcher;
}

/**
 * Keeps function instances warm between requests, like Vercel: the first request to a function
 * starts an instance (cold), later ones reuse it (warm), so module-level setup runs once. Each
 * instance handles one request at a time; concurrent requests start more instances, and only a
 * few idle ones are kept, each stopped after `idleTimeoutMs`. Instances are keyed by the bundle
 * path, which includes the deployment ID, so a new deployment never reuses an old instance.
 */
export class FunctionPool {
  private readonly idle = new Map<string, Instance[]>();
  private readonly all = new Set<Instance>();
  readonly launcher: Launcher;

  constructor(private readonly opts: PoolOptions) {
    this.launcher = opts.launcher ?? new ProcessLauncher();
  }

  /** Running instances (busy and idle). */
  get size(): number {
    return this.all.size;
  }

  async invoke(opts: InvokeOptions): Promise<InvokeResult> {
    const artifactDir = fs.realpathSync(opts.artifactDir);
    const key = `${path.join(artifactDir, opts.route.file)}\0${opts.memoryMb}\0${opts.sandbox?.uid ?? opts.sandboxId ?? ""}`;

    let instance = this.takeIdle(key);
    const warm = instance !== undefined;
    if (!instance) {
      let created: Instance | null = null;
      const launched = this.launcher.launchFunction(
        {
          deploymentId: opts.deploymentId ?? path.basename(artifactDir),
          runtime: opts.route.runtime ?? "node",
          artifactDir,
          file: opts.route.file,
          memoryMb: opts.memoryMb,
          env: opts.env,
          sandboxId: opts.sandboxId ?? null,
          sandbox: opts.sandbox ?? null,
        },
        (stream, text) => created?.log(stream, text),
      );
      created = new Instance(key, launched, (i) => this.forget(i));
      instance = created;
      this.all.add(instance);
    }
    try {
      const response = await instance.run(opts);
      this.release(instance);
      return { ...response, warm };
    } catch (err) {
      instance.kill();
      this.forget(instance);
      if (err instanceof LaunchError) throw new FunctionCrashError(err.message);
      throw err;
    }
  }

  /** Stops every instance. */
  close(): void {
    for (const instance of this.all) instance.kill();
  }

  private takeIdle(key: string): Instance | undefined {
    const list = this.idle.get(key);
    let instance = list?.pop();
    while (instance?.dead) instance = list?.pop();
    if (list && list.length === 0) this.idle.delete(key);
    if (instance?.idleTimer) clearTimeout(instance.idleTimer);
    return instance;
  }

  private release(instance: Instance): void {
    if (instance.dead) return this.forget(instance);
    const list = this.idle.get(instance.key) ?? [];
    if (list.length >= this.opts.maxIdlePerFunction) {
      this.forget(instance);
      return instance.kill();
    }
    list.push(instance);
    this.idle.set(instance.key, list);
    instance.idleSince = Date.now();
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

/** A single cold invocation in a fresh instance that stops afterwards. */
export async function invokeFunction(opts: InvokeOptions, launcher?: Launcher): Promise<FunctionResponse> {
  const pool = new FunctionPool({ maxIdlePerFunction: 0, maxIdle: 0, idleTimeoutMs: 0, launcher });
  const { warm: _warm, ...response } = await pool.invoke(opts);
  return response;
}

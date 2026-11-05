import http from "node:http";
import { type FunctionSpec, type Launched, type Launcher, LaunchError } from "./launcher.js";

/** A server instance to start in a sandbox (Next.js standalone). */
export interface ServerSpec {
  deploymentId: string;
  /** Entry relative to the artifact, e.g. "server/server.js". */
  entry: string;
  memoryMb: number;
  sandboxId: number | null;
}

function call<T>(socketPath: string, method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          const json = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
          if ((res.statusCode ?? 500) >= 400) reject(new LaunchError(json.error ?? `sandboxd: ${res.statusCode}`));
          else resolve(json);
        });
      },
    );
    req.on("error", (err) =>
      reject(new LaunchError(`The sandbox service isn't reachable (${socketPath}): ${(err as Error).message}`)),
    );
    req.end(payload);
  });
}

/**
 * Production mode: every instance is a sandbox container, started by sandboxd. The edge never
 * touches Docker; it only connects to the instance's socket.
 */
export class ContainerLauncher implements Launcher {
  readonly kind = "container" as const;
  readonly description = "sandbox containers (sandboxd)";

  constructor(private readonly socketPath: string) {}

  /** Stops every sandbox left over from a previous edge process. */
  async reset(): Promise<void> {
    await call(this.socketPath, "POST", "/v1/reset");
  }

  health(): Promise<{ runtime: string; firewall: { ok: boolean; detail: string } }> {
    return call(this.socketPath, "GET", "/v1/health");
  }

  launchFunction(spec: FunctionSpec): Launched {
    if (!spec.sandboxId) throw new LaunchError("This deployment has no sandbox user");
    const runtime = spec.runtime;
    return this.launch({
      kind: "function",
      runtime,
      deploymentId: spec.deploymentId,
      entry: spec.file,
      memoryMb: spec.memoryMb,
      sandboxId: spec.sandboxId,
    });
  }

  launchServer(spec: ServerSpec): Launched {
    if (!spec.sandboxId) throw new LaunchError("This deployment has no sandbox user");
    return this.launch({
      kind: "server",
      runtime: "node",
      deploymentId: spec.deploymentId,
      entry: spec.entry,
      memoryMb: spec.memoryMb,
      sandboxId: spec.sandboxId,
    });
  }

  private launch(body: Record<string, unknown>): Launched {
    let id: string | null = null;
    let killed = false;
    let resolveExit!: (reason: string) => void;
    const exited = new Promise<string>((r) => (resolveExit = r));
    const launched: Launched = {
      socketPath: "",
      ready: Promise.resolve(),
      exited,
      kill: () => {
        killed = true;
        if (id) void call(this.socketPath, "DELETE", `/v1/instances/${id}`).catch(() => undefined);
      },
    };
    launched.ready = call<{ id: string; socketPath: string }>(this.socketPath, "POST", "/v1/instances", body).then(
      (created) => {
        id = created.id;
        launched.socketPath = created.socketPath;
        call<{ reason: string }>(this.socketPath, "GET", `/v1/instances/${created.id}/wait`).then(
          ({ reason }) => resolveExit(reason),
          (err: Error) => resolveExit(err.message),
        );
        if (killed) launched.kill();
      },
      (err: Error) => {
        resolveExit(err.message);
        throw err;
      },
    );
    launched.ready.catch(() => {});
    return launched;
  }
}

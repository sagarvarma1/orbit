import { fork } from "node:child_process";
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

/**
 * One invocation = one fresh Node process using the permission model: it may read only its
 * own bundle, can't write files or spawn processes, and is killed after `timeoutMs`.
 */
export function invokeFunction(opts: InvokeOptions): Promise<FunctionResponse> {
  // The permission model checks real paths, so resolve symlinks (macOS: /tmp -> /private/tmp).
  const artifactDir = fs.realpathSync(opts.artifactDir);
  const file = path.join(artifactDir, opts.route.file);
  const functionsDir = path.join(artifactDir, FUNCTIONS_DIR);
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER, [], {
      execArgv: [
        `--max-old-space-size=${opts.memoryMb}`,
        "--permission",
        `--allow-fs-read=${functionsDir}${path.sep}`,
        `--allow-fs-read=${RUNNER}`,
        "--disable-warning=ExperimentalWarning",
      ],
      env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", ...opts.env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => reject(new FunctionTimeoutError(`Function timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);

    child.stdout?.setEncoding("utf8").on("data", (t: string) => opts.onLog?.("stdout", t));
    child.stderr?.setEncoding("utf8").on("data", (t: string) => opts.onLog?.("stderr", t));
    child.on(
      "message",
      (msg: { type: string; response?: { status: number; headers: Record<string, string>; body: string }; message?: string }) => {
        if (msg.type === "response" && msg.response) {
          const { status, headers, body } = msg.response;
          settle(() => resolve({ status, headers, body: Buffer.from(body, "base64") }));
        } else {
          settle(() => reject(new FunctionCrashError(msg.message ?? "Function crashed")));
        }
      },
    );
    child.on("error", (err) => settle(() => reject(err)));
    child.on("exit", (code, sig) =>
      settle(() =>
        reject(
          new FunctionCrashError(
            code === 0 || code === 13
              ? "Function finished without returning a response"
              : `Function exited unexpectedly (${sig ?? code})`,
          ),
        ),
      ),
    );
    child.send({ file, request: { ...opts.request, body: opts.request.body.toString("base64") }, params: opts.params });
  });
}

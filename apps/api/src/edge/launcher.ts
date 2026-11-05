import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FunctionRuntime } from "../lib/manifest.js";
import type { SandboxIdentity } from "../lib/sandbox.js";

/** Deployment code runs below the edge's priority, so a busy app can't starve request routing. */
export const SANDBOX_NICE = 10;

/** Lowers a child's CPU priority; best effort. */
export function deprioritize(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    os.setPriority(pid, SANDBOX_NICE);
  } catch {
    // Not permitted on this platform; harmless.
  }
}

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runtime");
export const NODE_RUNNER = fs.realpathSync(path.join(RUNTIME_DIR, "function-runner.mjs"));
export const PYTHON_RUNNER = fs.realpathSync(path.join(RUNTIME_DIR, "python-runner.py"));

/** What to start: one function instance. */
export interface FunctionSpec {
  deploymentId: string;
  runtime: FunctionRuntime;
  /** The deployment's artifact directory (as the edge sees it). */
  artifactDir: string;
  /** The function's file relative to the artifact, e.g. "functions/api/hello.mjs". */
  file: string;
  memoryMb: number;
  env: Record<string, string>;
  /** The project's sandbox number (its OS user / container user). */
  sandboxId: number | null;
  /** Process mode: run as this OS user (Linux, when the edge is root). */
  sandbox: SandboxIdentity | null;
}

/** A started instance. Requests go over HTTP on its unix socket. */
export interface Launched {
  socketPath: string;
  /** Resolves when the instance accepts connections; rejects if it exits or fails to start first. */
  ready: Promise<void>;
  /** Resolves with a description when the instance stops, for whatever reason. */
  exited: Promise<string>;
  kill(): void;
}

export interface Launcher {
  readonly kind: "process" | "container";
  readonly description: string;
  launchFunction(spec: FunctionSpec, onLog: (stream: "stdout" | "stderr", text: string) => void): Launched;
}

export class LaunchError extends Error {}

/** Polls a unix socket until it accepts a connection. */
export function connectable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Waits for the socket, or rejects when `stopped` settles first or the deadline passes. */
export async function waitForSocket(socketPath: string, stopped: Promise<string>, timeoutMs: number): Promise<void> {
  let exit: string | null = null;
  void stopped.then((reason) => (exit = reason));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exit !== null) throw new LaunchError(exit);
    if (await connectable(socketPath)) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new LaunchError(`The function didn't start within ${timeoutMs / 1000}s`);
}

/** Recent output lines, so a crash on startup can say why. */
export class OutputTail {
  private readonly lines: string[] = [];
  push(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      this.lines.push(line);
      if (this.lines.length > 20) this.lines.shift();
    }
  }
  toString(): string {
    return this.lines.slice(-8).join("\n");
  }
}

export function exitReason(code: number | null, signal: string | null, tail: string, oomKilled = false): string {
  const what = oomKilled
    ? "Function ran out of memory"
    : code === 0
      ? "Function exited"
      : `Function exited unexpectedly (${signal ?? code})`;
  return tail ? `${what}:\n${tail}` : what;
}

/**
 * Development and fallback mode: each instance is a local process. Node functions run under
 * Node's permission model (reads limited to the bundle, writes to the instance's own temp
 * directory, no child processes). Python has no equivalent, so Python functions only get the
 * per-project OS user and the firewall (Linux, as root). Production uses containers instead.
 */
export class ProcessLauncher implements Launcher {
  readonly kind = "process" as const;
  readonly description: string;

  constructor(private readonly startTimeoutMs = 20_000) {
    this.description = "local processes (Node permission model)";
  }

  launchFunction(spec: FunctionSpec, onLog: (stream: "stdout" | "stderr", text: string) => void): Launched {
    // The permission model checks real paths, so resolve symlinks (macOS: /tmp -> /private/tmp).
    const artifactDir = fs.realpathSync(spec.artifactDir);
    const functionsDir = path.join(artifactDir, "functions");
    const file = path.join(artifactDir, spec.file);
    // Short path: unix socket paths are limited to ~104 bytes.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orbit-fn-")));
    if (spec.sandbox) {
      fs.chownSync(dir, spec.sandbox.uid, spec.sandbox.gid);
      fs.chmodSync(dir, 0o700);
    }
    const socketPath = path.join(dir, "s.sock");
    const env = {
      ...spec.env,
      NODE_ENV: "production",
      PATH: process.env.PATH ?? "",
      TMPDIR: dir,
      HOME: dir,
      ORBIT_MEMORY_MB: String(spec.memoryMb),
    };

    let child: ChildProcess;
    const options = {
      ...(spec.sandbox ? { uid: spec.sandbox.uid, gid: spec.sandbox.gid } : {}),
      // Like Vercel, the working directory is the function root, so relative reads of included files work.
      cwd: functionsDir,
      stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[],
    };
    if (spec.runtime === "python") {
      child = spawn(process.env.ORBIT_PYTHON ?? "python3", [PYTHON_RUNNER, file, socketPath], {
        ...options,
        env: { ...env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" },
      });
    } else {
      child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${spec.memoryMb}`,
          "--permission",
          `--allow-fs-read=${functionsDir}${path.sep}`,
          `--allow-fs-read=${NODE_RUNNER}`,
          `--allow-fs-read=${dir}${path.sep}`,
          `--allow-fs-write=${dir}${path.sep}`,
          "--disable-warning=ExperimentalWarning",
          NODE_RUNNER,
          file,
          socketPath,
        ],
        { ...options, env },
      );
    }
    deprioritize(child.pid);
    const tail = new OutputTail();
    child.stdout?.setEncoding("utf8").on("data", (t: string) => {
      tail.push(t);
      onLog("stdout", t);
    });
    child.stderr?.setEncoding("utf8").on("data", (t: string) => {
      tail.push(t);
      onLog("stderr", t);
    });
    const exited = new Promise<string>((resolve) => {
      child.on("error", (err) => resolve(`Function failed to start: ${err.message}`));
      child.on("exit", (code, signal) => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve(exitReason(code, signal, tail.toString()));
      });
    });
    const ready = waitForSocket(socketPath, exited, this.startTimeoutMs);
    ready.catch(() => child.kill("SIGKILL"));
    return { socketPath, ready, exited, kill: () => child.kill("SIGKILL") };
  }
}

/** Sends one request to an instance and buffers the response. */
export function requestInstance(
  socketPath: string,
  req: { method: string; path: string; headers: Record<string, string>; body: Buffer },
): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const upstream = http.request(
      {
        socketPath,
        method: req.method,
        path: req.path,
        headers: { ...req.headers, "content-length": String(req.body.length), connection: "close" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers[key] = value;
          resolve({ status: res.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    upstream.on("error", reject);
    upstream.end(req.body);
  });
}

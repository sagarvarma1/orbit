import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";

const exec = promisify(execFile);

export interface RunOptions {
  /** Unique, DNS-safe name for this step (used for the container name). */
  name: string;
  /** Host directory containing the checked-out repository. */
  workspaceDir: string;
  /** Project root inside the repository ("." or "apps/web"). */
  rootDirectory: string;
  command: string;
  env: Record<string, string>;
  onOutput: (stream: "stdout" | "stderr", chunk: string) => void;
  signal: AbortSignal;
}

export interface CommandRunner {
  readonly kind: "docker" | "process";
  readonly description: string;
  /** Resolves with the exit code (or null if killed). */
  run(opts: RunOptions): Promise<number | null>;
}

/**
 * Makes `pnpm`/`yarn` work even when only corepack is installed. Shell functions keep this
 * transparent to the user's command.
 */
const PM_SHIMS =
  'command -v pnpm >/dev/null 2>&1 || pnpm() { corepack pnpm "$@"; }; ' +
  'command -v yarn >/dev/null 2>&1 || yarn() { corepack yarn "$@"; }; ';

/** Variables a build may inherit from the host. Everything else (secrets!) is withheld. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "COREPACK_HOME",
];

function pipe(child: ReturnType<typeof spawn>, onOutput: RunOptions["onOutput"]): void {
  child.stdout?.setEncoding("utf8").on("data", (c: string) => onOutput("stdout", c));
  child.stderr?.setEncoding("utf8").on("data", (c: string) => onOutput("stderr", c));
}

/**
 * Fallback runner: a detached process group with a scrubbed environment. Cancel/timeout
 * kills the whole group (npm spawns grandchildren). Not a security boundary; use Docker for that.
 */
export class ProcessRunner implements CommandRunner {
  readonly kind = "process" as const;
  readonly description = "child process (no isolation)";

  run(opts: RunOptions): Promise<number | null> {
    const baseEnv: Record<string, string> = {};
    for (const key of INHERITED_ENV) if (process.env[key]) baseEnv[key] = process.env[key]!;

    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", PM_SHIMS + opts.command], {
        cwd: path.join(opts.workspaceDir, opts.rootDirectory),
        env: { ...baseEnv, ...opts.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      pipe(child, opts.onOutput);

      const kill = () => {
        if (child.pid === undefined || child.exitCode !== null) return;
        try {
          process.kill(-child.pid, "SIGTERM");
          setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              /* already gone */
            }
          }, 5000).unref();
        } catch {
          /* already gone */
        }
      };
      if (opts.signal.aborted) kill();
      opts.signal.addEventListener("abort", kill, { once: true });

      child.on("error", reject);
      child.on("close", (code) => {
        opts.signal.removeEventListener("abort", kill);
        resolve(code);
      });
    });
  }
}

/**
 * Isolated runner: each step runs in a throwaway container with CPU/memory limits and only
 * the repository mounted. The container is killed on cancel/timeout.
 */
export class DockerRunner implements CommandRunner {
  readonly kind = "docker" as const;
  readonly description: string;

  constructor(private readonly config: Config) {
    this.description = `docker (${config.buildImage}, ${config.buildCpus} cpu, ${config.buildMemory})`;
  }

  /** Host path for a path under the data dir (for sibling containers via the Docker socket). */
  private hostPath(p: string): string {
    return path.join(this.config.hostDataDir, path.relative(this.config.dataDir, p));
  }

  run(opts: RunOptions): Promise<number | null> {
    const containerName = `orbit-${opts.name}`;
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    // Files created in the container are root-owned; hand them back so the host can clean up.
    const script = `corepack enable >/dev/null 2>&1 || true; ${PM_SHIMS}${opts.command}; s=$?; chown -R ${uid}:${gid} /workspace 2>/dev/null; exit $s`;
    const envArgs = Object.entries({
      ...opts.env,
      npm_config_cache: "/cache/npm",
      YARN_CACHE_FOLDER: "/cache/yarn",
      COREPACK_HOME: "/cache/corepack",
    }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--cpus",
      this.config.buildCpus,
      "--memory",
      this.config.buildMemory,
      "--pids-limit",
      "1024",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${this.hostPath(opts.workspaceDir)}:/workspace`,
      "-v",
      "orbit-build-cache:/cache",
      "-w",
      path.posix.join("/workspace", opts.rootDirectory),
      ...envArgs,
      this.config.buildImage,
      "sh",
      "-c",
      script,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      pipe(child, opts.onOutput);
      const kill = () => {
        execFile("docker", ["kill", containerName], () => {});
      };
      if (opts.signal.aborted) kill();
      opts.signal.addEventListener("abort", kill, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        opts.signal.removeEventListener("abort", kill);
        resolve(code);
      });
    });
  }
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function createRunner(config: Config): Promise<CommandRunner> {
  const publicInstance = config.rootDomain !== "localhost";
  if (config.builder === "process") {
    if (publicInstance)
      console.warn("WARNING: ORBIT_BUILDER=process runs builds without isolation. Use Docker for anything you didn't write.");
    return new ProcessRunner();
  }
  if (config.builder === "docker") return new DockerRunner(config);
  if (await dockerAvailable()) return new DockerRunner(config);
  // Falling back silently is fine on a laptop, not on a server people can deploy to.
  if (publicInstance) {
    throw new Error(
      "Docker is not reachable, and builds without Docker aren't isolated. Start Docker, or set ORBIT_BUILDER=process to accept the risk.",
    );
  }
  return new ProcessRunner();
}

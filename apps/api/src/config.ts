import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export type BuilderMode = "auto" | "docker" | "process";

const dataDir = path.resolve(str("ORBIT_DATA_DIR", path.join(process.cwd(), "data")));

export const config = {
  /** Root of all persistent state: SQLite DB, artifacts, logs, build workspaces. */
  dataDir,
  dbPath: path.join(dataDir, "orbit.db"),
  artifactsDir: path.join(dataDir, "artifacts"),
  logsDir: path.join(dataDir, "logs"),
  buildsDir: path.join(dataDir, "builds"),
  /** Per-project build cache (node_modules, .next/cache). */
  cacheDir: path.join(dataDir, "cache"),
  /**
   * When the control plane itself runs in a container and launches sibling build
   * containers through the host's Docker socket, bind mounts must use host paths.
   */
  hostDataDir: str("ORBIT_HOST_DATA_DIR", dataDir),

  apiPort: int("API_PORT", 4000),
  edgePort: int("EDGE_PORT", 8080),
  host: str("HOST", "0.0.0.0"),

  /** Deployments are served at <label>.<rootDomain>. `localhost` works with no DNS. */
  rootDomain: str("ORBIT_ROOT_DOMAIN", "localhost").toLowerCase(),
  /** Public scheme/port used when rendering URLs (e.g. https and "" behind Caddy). */
  publicProtocol: str("ORBIT_PUBLIC_PROTOCOL", "http"),
  publicEdgePort: str("ORBIT_PUBLIC_EDGE_PORT", String(int("EDGE_PORT", 8080))),

  builder: str("ORBIT_BUILDER", "auto") as BuilderMode,
  buildImage: str("ORBIT_BUILD_IMAGE", "node:22-bookworm-slim"),
  buildConcurrency: int("BUILD_CONCURRENCY", 2),
  buildTimeoutSeconds: int("BUILD_TIMEOUT_SECONDS", 600),
  buildMemory: str("BUILD_MEMORY", "2g"),
  buildCpus: str("BUILD_CPUS", "2"),
  /** Reuse node_modules between builds when the lockfile is unchanged. BUILD_CACHE=0 turns it off. */
  buildCache: process.env.BUILD_CACHE !== "0",

  functionTimeoutMs: int("FUNCTION_TIMEOUT_MS", 10_000),
  functionMemoryMb: int("FUNCTION_MEMORY_MB", 128),

  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  /** Enables commit statuses and PR preview comments. Needs "Commit statuses" and "Pull requests" write access. */
  githubToken: process.env.GITHUB_TOKEN ?? "",
  githubApiUrl: str("GITHUB_API_URL", "https://api.github.com"),
  /** github.com, or a fake in tests; where the app-creation form is posted. */
  githubWebUrl: str("GITHUB_WEB_URL", "https://github.com"),
  /** The server's public IPv4, shown in DNS instructions. Defaults to what the dashboard's hostname resolves to. */
  publicIp: process.env.ORBIT_PUBLIC_IP ?? "",
  /** Where the dashboard lives, for "Inspect" links posted to GitHub. */
  dashboardUrl: str("ORBIT_DASHBOARD_URL", "http://localhost:3000").replace(/\/$/, ""),
  gitPollIntervalSeconds: int("GIT_POLL_INTERVAL_SECONDS", 0),
  /** Creates the admin account on first boot instead of the setup-code flow (automation, tests). */
  adminEmail: process.env.ORBIT_ADMIN_EMAIL ?? "",
  adminPassword: process.env.ORBIT_ADMIN_PASSWORD ?? "",
  /** Sets a new password for the admin on boot (forgotten password). Remove it afterwards. */
  resetAdminPassword: process.env.ORBIT_RESET_ADMIN_PASSWORD ?? "",
  /** Trust X-Forwarded-* from a reverse proxy (Caddy) for client IPs and protocol. */
  trustProxy: process.env.TRUST_PROXY === "1",
  /** Allow file:// and local path repositories (used by the e2e tests). */
  allowLocalRepos: process.env.ORBIT_ALLOW_LOCAL_REPOS === "1",
} as const;

export type Config = typeof config;

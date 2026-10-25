import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FUNCTION_ENV_FILE, MANIFEST_FILE } from "./manifest.js";

/**
 * OS-level isolation for deployment code (functions and app servers), underneath Node's
 * permission model. On Linux, when Orbit runs as root (as it does in its container):
 *
 * - Each project's code runs as its own unprivileged user. Its artifacts are readable by that
 *   user's group only, so one project can't read another's code, and nothing can read Orbit's
 *   database, build logs, or the env files the edge passes to processes.
 * - A firewall rule stops those users from opening connections to private addresses: Orbit's
 *   API and the Docker network, localhost services, and the cloud metadata endpoint. The public
 *   internet stays reachable.
 *
 * Elsewhere (macOS, local development, non-root) this is off and the permission model alone applies.
 */

/** Project N runs as uid/gid SANDBOX_UID_BASE + N. Far above any real account. */
export const SANDBOX_UID_BASE = 100_000;
const SANDBOX_UID_RANGE = `${SANDBOX_UID_BASE}-${SANDBOX_UID_BASE + 9_999_999}`;
const MARKER = ".sandbox";

export interface SandboxIdentity {
  uid: number;
  gid: number;
}

let disabledReason: string | null = null;

export function sandboxAvailable(): boolean {
  return (
    disabledReason === null && process.platform === "linux" && process.getuid?.() === 0 && process.env.ORBIT_SANDBOX_USERS !== "0"
  );
}

/** Turns sandbox users off for this process (e.g. they couldn't reach the data directory). */
export function disableSandbox(reason: string): void {
  disabledReason = reason;
}

/**
 * The first directory on the way to `dir` that other users can't pass through, or null. Sandbox
 * users need execute permission on every parent of the artifacts directory.
 */
export function blockingParent(dir: string): string | null {
  let current = path.resolve(dir);
  const parents: string[] = [];
  while (path.dirname(current) !== current) {
    current = path.dirname(current);
    parents.unshift(current);
  }
  for (const parent of parents) {
    if ((fs.statSync(parent).mode & 0o001) === 0) return parent;
  }
  return null;
}

/** Run as this project's own user, or null when users aren't available. */
export function sandboxIdentity(uid: number | null | undefined): SandboxIdentity | null {
  if (!uid || !sandboxAvailable()) return null;
  return { uid, gid: uid };
}

function walk(dir: string, visit: (file: string, stat: fs.Stats) => void): void {
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry);
    const stat = fs.lstatSync(file);
    visit(file, stat);
    if (stat.isDirectory()) walk(file, visit);
  }
}

/**
 * Closes a freshly built artifact to everyone but root (the edge), until the edge hands it to the
 * project's user. Called by the build pipeline before the artifact is published.
 */
export function lockArtifact(dir: string): void {
  if (!sandboxAvailable()) return;
  fs.chmodSync(dir, 0o700);
  walk(dir, (file, stat) => {
    if (!stat.isSymbolicLink()) fs.chmodSync(file, stat.mode & 0o770);
  });
}

/**
 * Gives a deployment's files to its project's group, read-only: directories 0750, files 0640,
 * owned by root. The env file and manifest stay root-only. Done once per deployment (a marker
 * records the uid), and again if the uid ever changes.
 */
export function prepareArtifact(dir: string, id: SandboxIdentity): void {
  const marker = path.join(dir, MARKER);
  try {
    if (fs.readFileSync(marker, "utf8") === String(id.uid)) return;
  } catch {
    // Not prepared yet.
  }
  const rootOnly = new Set([path.join(dir, FUNCTION_ENV_FILE), path.join(dir, MANIFEST_FILE), marker]);
  fs.chownSync(dir, 0, id.gid);
  fs.chmodSync(dir, 0o750);
  walk(dir, (file, stat) => {
    if (stat.isSymbolicLink()) return fs.lchownSync(file, 0, id.gid);
    if (rootOnly.has(file)) {
      fs.chownSync(file, 0, 0);
      return fs.chmodSync(file, 0o600);
    }
    fs.chownSync(file, 0, id.gid);
    fs.chmodSync(file, stat.isDirectory() ? 0o750 : 0o640);
  });
  fs.writeFileSync(marker, String(id.uid), { mode: 0o600 });
}

/** The deployment's writable directory (e.g. Next's .next/cache), owned by its user alone. */
export function prepareRuntimeDir(dir: string, id: SandboxIdentity): void {
  fs.mkdirSync(dir, { recursive: true });
  const owned = fs.statSync(dir);
  if (owned.uid === id.uid && (owned.mode & 0o777) === 0o700) return;
  fs.chownSync(dir, id.uid, id.gid);
  fs.chmodSync(dir, 0o700);
  walk(dir, (file, stat) => {
    fs.lchownSync(file, id.uid, id.gid);
    if (!stat.isSymbolicLink()) fs.chmodSync(file, stat.mode & 0o700);
  });
}

/**
 * Locks down the data directory: others may traverse to their own artifact (0711) but not list
 * anything, and the database, logs, build workspaces and caches are root-only.
 */
export function lockDataDir(dirs: {
  dataDir: string;
  dbPath: string;
  artifactsDir: string;
  logsDir: string;
  buildsDir: string;
  cacheDir: string;
}): void {
  if (!sandboxAvailable()) return;
  const runtimeDir = path.join(dirs.dataDir, "runtime");
  for (const dir of [dirs.dataDir, dirs.artifactsDir, runtimeDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o711);
  }
  for (const dir of [dirs.logsDir, dirs.buildsDir, dirs.cacheDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
  }
  // SQLite creates the -wal and -shm files with the database's own mode.
  for (const file of [dirs.dbPath, `${dirs.dbPath}-wal`, `${dirs.dbPath}-shm`]) {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
}

/** Destinations sandboxed users may not connect to. */
export const BLOCKED_V4 = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "0.0.0.0/8",
  "224.0.0.0/4",
];
const BLOCKED_V6 = ["::1/128", "fc00::/7", "fe80::/10", "ff00::/8"];

/** The iptables commands for the firewall, as argument lists (exported for tests). */
export function firewallRules(v6: boolean): string[][] {
  const chain = "ORBIT_SANDBOX";
  const rules: string[][] = [
    ["-N", chain],
    ["-F", chain],
    // Replies on connections someone else opened (the edge proxying to an app server) are fine.
    ["-A", chain, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"],
  ];
  // Docker's embedded DNS server listens on 127.0.0.11; name lookups must keep working.
  if (!v6) rules.push(["-A", chain, "-d", "127.0.0.11/32", "-j", "RETURN"]);
  for (const net of v6 ? BLOCKED_V6 : BLOCKED_V4) {
    rules.push(["-A", chain, "-d", net, "-j", "REJECT"]);
  }
  rules.push(["-D", "OUTPUT", "-m", "owner", "--uid-owner", SANDBOX_UID_RANGE, "-j", chain]);
  rules.push(["-I", "OUTPUT", "-m", "owner", "--uid-owner", SANDBOX_UID_RANGE, "-j", chain]);
  return rules;
}

/**
 * Installs the firewall (needs the NET_ADMIN capability and iptables). Returns what happened,
 * for the log; failing here leaves the network open but everything else still isolated.
 */
export function installFirewall(): { ok: boolean; detail: string } {
  if (!sandboxAvailable()) return { ok: false, detail: "sandbox users are off (not root on Linux)" };
  const apply = (binary: string, v6: boolean) => {
    for (const args of firewallRules(v6)) {
      try {
        execFileSync(binary, ["-w", ...args], { stdio: "pipe" });
      } catch (err) {
        // "-N" on an existing chain and "-D" of a missing rule are expected to fail.
        if (args[0] !== "-N" && args[0] !== "-D") throw err;
      }
    }
  };
  const reason = (err: unknown) =>
    String((err as { stderr?: Buffer }).stderr ?? (err as Error).message)
      .trim()
      .split("\n")[0] || "iptables failed";
  try {
    apply("iptables", false);
  } catch (err) {
    return { ok: false, detail: reason(err) };
  }
  try {
    apply("ip6tables", true);
    return { ok: true, detail: "private networks blocked for deployment code" };
  } catch (err) {
    // Containers without IPv6 can't reach IPv6 private ranges anyway.
    return { ok: true, detail: `private IPv4 networks blocked (IPv6 rules skipped: ${reason(err)})` };
  }
}

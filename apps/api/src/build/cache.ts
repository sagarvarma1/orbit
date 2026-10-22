import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Per-project build cache: `node_modules` keyed by the lockfile, plus framework caches such as
 * `.next/cache` that are reused regardless of the key.
 *
 * Entries are moved, never copied: restore renames the cache into the build workspace and save
 * renames it back, so both are O(1) no matter how large node_modules is. A failed build hands the
 * restored directories back untouched. Everything here is best effort and never fails a build.
 */

const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json"];
/** Framework caches worth carrying between builds, relative to the project root. */
const FRAMEWORK_DIRS = [".next/cache"];
const META_FILE = "meta.json";

export interface CacheMeta {
  key: string;
  deploymentId: string;
  savedAt: number;
  /** How long the install that produced this node_modules took, to report what a hit saves. */
  installMs: number | null;
}

export type CacheKey = { key: string } | { reason: string };

/**
 * Hash of everything that determines what `install` produces. Returns a reason instead when the
 * install isn't safe to skip (no lockfile, workspaces, or a custom install command).
 */
export function computeCacheKey(
  projectDir: string,
  input: { installCommand: string | null; customInstall: boolean; platform: string },
): CacheKey {
  if (!input.installCommand) return { reason: "no install step" };
  if (input.customInstall) return { reason: "custom install command" };
  const lockfile = LOCKFILES.find((f) => fs.existsSync(path.join(projectDir, f)));
  if (!lockfile) return { reason: "no lockfile" };
  let pkg: { workspaces?: unknown } = {};
  const pkgRaw = fs.readFileSync(path.join(projectDir, "package.json"), "utf8");
  try {
    pkg = JSON.parse(pkgRaw) as typeof pkg;
  } catch {
    return { reason: "unreadable package.json" };
  }
  // Workspaces install node_modules in several packages; restoring only the root one would be wrong.
  if (pkg.workspaces || fs.existsSync(path.join(projectDir, "pnpm-workspace.yaml"))) return { reason: "workspaces" };

  const hash = createHash("sha256");
  for (const part of [input.platform, input.installCommand, lockfile, fs.readFileSync(path.join(projectDir, lockfile)), pkgRaw])
    hash.update(part).update("\0");
  return { key: hash.digest("hex").slice(0, 16) };
}

function readMeta(entryDir: string): CacheMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(entryDir, META_FILE), "utf8")) as CacheMeta;
  } catch {
    return null;
  }
}

function move(from: string, to: string): boolean {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

export interface RestoreResult {
  /** node_modules was restored, so install can be skipped. */
  hit: boolean;
  meta: CacheMeta | null;
  /** Framework cache dirs that were restored (e.g. ".next/cache"). */
  restoredDirs: string[];
}

export class BuildCache {
  /** What was moved into the workspace, so it can be handed back if the build fails. */
  private restored: string[] = [];

  constructor(
    /** data/cache/<projectId> */
    private readonly entryDir: string,
    private readonly projectDir: string,
  ) {}

  restore(key: string | null): RestoreResult {
    const meta = readMeta(this.entryDir);
    let hit = false;
    if (key && meta?.key === key && move(path.join(this.entryDir, "node_modules"), path.join(this.projectDir, "node_modules"))) {
      hit = true;
      this.restored.push("node_modules");
    }
    const restoredDirs: string[] = [];
    for (const dir of FRAMEWORK_DIRS) {
      if (fs.existsSync(path.join(this.projectDir, dir))) continue;
      if (move(path.join(this.entryDir, "dirs", dir), path.join(this.projectDir, dir))) {
        restoredDirs.push(dir);
        this.restored.push(dir);
      }
    }
    return { hit, meta, restoredDirs };
  }

  /**
   * Move this build's node_modules and framework caches into a fresh entry, then swap it in.
   * Only called after a successful build. Returns false if nothing could be saved.
   */
  save(key: string | null, deploymentId: string, installMs: number | null): boolean {
    const parent = path.dirname(this.entryDir);
    const staging = path.join(parent, `.staging-${deploymentId}`);
    const old = path.join(parent, `.old-${deploymentId}`);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      let saved = false;
      if (key && move(path.join(this.projectDir, "node_modules"), path.join(staging, "node_modules"))) saved = true;
      for (const dir of FRAMEWORK_DIRS) {
        if (move(path.join(this.projectDir, dir), path.join(staging, "dirs", dir))) saved = true;
      }
      if (!saved) return false;
      const meta: CacheMeta = { key: key ?? "", deploymentId, savedAt: Date.now(), installMs };
      fs.writeFileSync(path.join(staging, META_FILE), JSON.stringify(meta, null, 2));
      if (fs.existsSync(this.entryDir)) fs.renameSync(this.entryDir, old);
      fs.renameSync(staging, this.entryDir);
      this.restored = [];
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(old, { recursive: true, force: true });
    }
  }

  /** The build failed: give back what restore() took, unless a newer entry has appeared since. */
  release(): void {
    for (const rel of this.restored) {
      const target = rel === "node_modules" ? path.join(this.entryDir, rel) : path.join(this.entryDir, "dirs", rel);
      if (!fs.existsSync(target)) move(path.join(this.projectDir, rel), target);
    }
    this.restored = [];
  }
}

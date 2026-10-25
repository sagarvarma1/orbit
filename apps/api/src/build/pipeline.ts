import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { CacheStatus, Deployment, Project } from "../db/repo.js";
import {
  FUNCTION_ENV_FILE,
  FUNCTIONS_DIR,
  MANIFEST_FILE,
  RUNTIME_DIR,
  SERVER_DIR,
  STATIC_DIR,
  type DeploymentManifest,
} from "../lib/manifest.js";
import { hasRoutingRules, parseRoutingConfig, ROUTING_CONFIG_FILE, type RoutingConfig } from "../lib/routing.js";
import { type BuildSettings, findWorkspaceRoot, normalizeRelative, readSnapshot, resolveBuildSettings } from "./detect.js";
import { BuildCache, computeCacheKey } from "./cache.js";
import { bundleFunctions } from "./functions.js";
import { type CommitInfo, shallowCheckout } from "./git.js";
import type { CommandRunner } from "./runner.js";

/** A failure the user caused (bad command, missing output). Shown verbatim, no stack. */
export class BuildError extends Error {}

export interface BuildContext {
  deployment: Deployment;
  project: Project;
  /** Env vars for this deployment's target (production/preview). */
  env: Record<string, string>;
  /** Public URL of the deployment, exposed to the build as ORBIT_URL. */
  url: string;
  runner: CommandRunner;
  /** Access token for cloning a private repository, if any. */
  gitToken?: string;
  config: Config;
  signal: AbortSignal;
  log: {
    system(message: string): void;
    write(stream: "stdout" | "stderr", chunk: string): void;
  };
  onCommit(commit: CommitInfo): void;
  onSettings(settings: BuildSettings): void;
  onCache(status: CacheStatus): void;
}

export interface BuildResult {
  manifest: DeploymentManifest;
}

const seconds = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)}s`;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

/** Copy the build output, skipping things that must never be served from a repo-root output. */
function copyOutput(from: string, to: string, isRepoRoot: boolean): { fileCount: number; totalBytes: number } {
  const blocked = new Set([".git", "node_modules", ...(isRepoRoot ? ["api", ".github", ROUTING_CONFIG_FILE] : [])]);
  let fileCount = 0;
  let totalBytes = 0;
  fs.cpSync(from, to, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const rel = path.relative(from, src);
      if (rel === "") return true;
      const first = rel.split(path.sep)[0]!;
      const base = path.basename(src);
      if (blocked.has(first) || base.startsWith(".env")) return false;
      const stat = fs.lstatSync(src);
      if (stat.isSymbolicLink()) return false; // a symlink could point outside the artifact
      if (stat.isFile()) {
        fileCount += 1;
        totalBytes += stat.size;
      }
      return true;
    },
  });
  return { fileCount, totalBytes };
}

/** Total size of the regular files under a directory (symlinks not followed). */
function dirStats(dir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    fileCount += 1;
    totalBytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return { fileCount, totalBytes };
}

/**
 * The standalone server's entry, relative to `.next/standalone`. In a monorepo Next.js mirrors the
 * repository layout there (e.g. "apps/web/server.js"), so look for the server.js next to a `.next`.
 */
export function findServerEntry(standaloneDir: string): string | null {
  const queue = [""];
  while (queue.length) {
    const rel = queue.shift()!;
    const dir = path.join(standaloneDir, rel);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.name === "server.js" && e.isFile()) && entries.some((e) => e.name === ".next")) {
      return path.posix.join(rel.split(path.sep).join("/"), "server.js");
    }
    for (const e of entries)
      if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".next") queue.push(path.join(rel, e.name));
  }
  return null;
}

/**
 * Packages a Next.js standalone build: the server (with its traced node_modules) goes to server/,
 * `.next/static` and `public/` go to static/ so the edge serves them without touching the server.
 * The server's `.next/cache` becomes a link to a writable per-deployment directory outside the
 * artifact, so the artifact itself never changes.
 */
function collectNextServer(projectDir: string, stagingDir: string, runtimeDir: string, artifactDir: string) {
  const standalone = path.join(projectDir, ".next", "standalone");
  if (!fs.existsSync(standalone)) {
    throw new BuildError(
      "Next.js didn't produce a standalone server (.next/standalone). If next.config sets `output`, remove it or set it to 'standalone'.",
    );
  }
  const entry = findServerEntry(standalone);
  if (!entry) throw new BuildError("Couldn't find server.js in the Next.js standalone output");

  const serverDir = path.join(stagingDir, SERVER_DIR);
  fs.cpSync(standalone, serverDir, { recursive: true, verbatimSymlinks: true });
  const appNextDir = path.join(serverDir, path.posix.dirname(entry), ".next");
  const cacheLink = path.join(appNextDir, "cache");
  fs.rmSync(cacheLink, { recursive: true, force: true });
  // Relative to where the artifact ends up after the staging dir is renamed.
  const finalNextDir = path.join(artifactDir, SERVER_DIR, path.posix.dirname(entry), ".next");
  fs.symlinkSync(path.relative(finalNextDir, path.join(runtimeDir, "cache")), cacheLink);

  const staticDir = path.join(stagingDir, STATIC_DIR);
  fs.mkdirSync(staticDir, { recursive: true });
  const publicDir = path.join(projectDir, "public");
  if (fs.existsSync(publicDir)) copyOutput(publicDir, staticDir, false);
  const nextStatic = path.join(projectDir, ".next", "static");
  if (fs.existsSync(nextStatic)) fs.cpSync(nextStatic, path.join(staticDir, "_next", "static"), { recursive: true });

  return { stats: dirStats(staticDir), server: { entry: path.posix.join(SERVER_DIR, entry) } };
}

/** Routing rules from vercel.json, validated now so a typo fails the build instead of a request. */
function readRoutingConfig(projectDir: string): RoutingConfig | undefined {
  const file = path.join(projectDir, ROUTING_CONFIG_FILE);
  if (!fs.existsSync(file)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new BuildError(`${ROUTING_CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return parseRoutingConfig(json);
  } catch (err) {
    throw new BuildError(`${ROUTING_CONFIG_FILE}: ${(err as Error).message}`);
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * clone -> detect -> install -> build -> bundle functions -> publish an immutable artifact.
 * Throws on failure; the caller owns status transitions.
 */
export async function runBuild(ctx: BuildContext): Promise<BuildResult> {
  const { deployment, project, config, log, signal } = ctx;
  const workspace = path.join(config.buildsDir, deployment.id);
  const artifactDir = path.join(config.artifactsDir, deployment.id);
  const stagingDir = path.join(config.artifactsDir, `.staging-${deployment.id}`);
  const started = Date.now();

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  let cache: BuildCache | null = null;

  try {
    // 1. Clone ---------------------------------------------------------------
    log.system(
      `Cloning ${project.repoUrl} (${deployment.ref === deployment.branch ? `branch: ${deployment.branch}` : `commit: ${deployment.ref.slice(0, 7)}`})`,
    );
    let t = Date.now();
    const commit = await shallowCheckout(project.repoUrl, deployment.ref, workspace, signal, ctx.gitToken).catch((err: Error) => {
      throwIfAborted(signal);
      throw new BuildError(`git clone failed: ${err.message.split("\n").find((l) => l.startsWith("fatal")) ?? err.message}`);
    });
    ctx.onCommit(commit);
    log.system(`Cloned ${commit.sha.slice(0, 7)} "${commit.message}" by ${commit.author} in ${seconds(t)}`);
    throwIfAborted(signal);

    // 2. Detect --------------------------------------------------------------
    const rootDirectory = normalizeRelative(project.rootDirectory || ".");
    const projectDir = path.join(workspace, rootDirectory);
    if (!fs.existsSync(projectDir)) throw new BuildError(`Root directory "${rootDirectory}" does not exist in the repository`);

    const snapshot = readSnapshot(projectDir);
    const settings = resolveBuildSettings(
      snapshot,
      {
        framework: project.framework,
        installCommand: project.installCommand,
        buildCommand: project.buildCommand,
        outputDirectory: project.outputDirectory,
      },
      findWorkspaceRoot(workspace, rootDirectory),
    );
    ctx.onSettings(settings);
    log.system(
      `Framework: ${settings.frameworkName}${settings.packageManager ? ` · package manager: ${settings.packageManager}` : ""} · builder: ${ctx.runner.description}`,
    );
    if (settings.workspaceRoot) {
      log.system(
        `Monorepo: installing from ${settings.workspaceRoot === "." ? "the repository root" : `"${settings.workspaceRoot}"`}, building "${rootDirectory}"`,
      );
    }
    if (settings.fromConfig.length) log.system(`Build settings from vercel.json: ${settings.fromConfig.join(", ")}`);
    if (settings.server) log.system("Next.js: server rendering (standalone server, static assets from the edge)");
    for (const warning of settings.warnings) log.system(`Warning: ${warning}`);
    const routing = readRoutingConfig(projectDir);
    if (hasRoutingRules(routing)) {
      log.system(
        `Routing from ${ROUTING_CONFIG_FILE}: ${plural(routing.redirects.length, "redirect")}, ${plural(routing.rewrites.length, "rewrite")}, ${plural(routing.headers.length, "header rule")}`,
      );
    }

    const buildEnv: Record<string, string> = {
      CI: "1",
      ORBIT: "1",
      ORBIT_ENV: deployment.target,
      ORBIT_URL: ctx.url,
      ORBIT_DEPLOYMENT_ID: deployment.id,
      ORBIT_GIT_COMMIT_REF: deployment.branch,
      ORBIT_GIT_COMMIT_SHA: commit.sha,
      ORBIT_GIT_COMMIT_MESSAGE: commit.message,
      // Next.js reads this as the default for `output`, so apps build a standalone server without config changes.
      ...(settings.server ? { NEXT_PRIVATE_STANDALONE: "1", NEXT_TELEMETRY_DISABLED: "1" } : {}),
      ...ctx.env,
    };
    const userKeys = Object.keys(ctx.env);
    log.system(
      userKeys.length
        ? `Environment (${deployment.target}): ${userKeys.join(", ")}`
        : `No environment variables for ${deployment.target}`,
    );

    // 3. Build cache -----------------------------------------------------------
    let cacheKey: string | null = null;
    let cachedInstallMs: number | null = null;
    let skipInstall = false;
    if (!config.buildCache) {
      ctx.onCache("skipped");
      log.system("Build cache disabled (BUILD_CACHE=0)");
    } else if (settings.workspaceRoot) {
      // node_modules is spread across the workspace; restoring only one directory would be wrong.
      ctx.onCache("skipped");
      log.system("Build cache not used for node_modules: monorepo workspace");
    } else {
      // node_modules holds native binaries, so a cache is only valid for the platform that built it.
      const platform =
        ctx.runner.kind === "docker"
          ? `docker:${config.buildImage}`
          : `${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`;
      const computed = computeCacheKey(projectDir, {
        installCommand: settings.installCommand,
        customInstall: Boolean(project.installCommand),
        platform,
      });
      cacheKey = "key" in computed ? computed.key : null;
      cache = new BuildCache(path.join(config.cacheDir, project.id), projectDir);
      if (!deployment.useCache) {
        ctx.onCache("skipped");
        log.system("Build cache not restored (redeploy without cache); a fresh one will be saved");
      } else {
        const restored = cache.restore(cacheKey);
        if (restored.hit) {
          skipInstall = true;
          cachedInstallMs = restored.meta?.installMs ?? null;
          ctx.onCache("hit");
          log.system(`Restored build cache from ${restored.meta?.deploymentId} (key ${cacheKey}, lockfile unchanged)`);
        } else {
          ctx.onCache(cacheKey ? "miss" : "skipped");
          log.system(
            cacheKey
              ? `No build cache for key ${cacheKey} (first build or dependencies changed)`
              : `Build cache not used for node_modules: ${"reason" in computed ? computed.reason : ""}`,
          );
        }
        if (restored.restoredDirs.length) log.system(`Restored framework cache: ${restored.restoredDirs.join(", ")}`);
      }
    }

    // 4. Install + build ------------------------------------------------------
    const workspaceDir = settings.workspaceRoot ?? rootDirectory;
    const steps: [string, string | null, string][] = [
      ["install", settings.installCommand, workspaceDir],
      ["build", settings.buildCommand, settings.buildFrom === "workspace" ? workspaceDir : rootDirectory],
    ];
    let installMs: number | null = null;
    for (const [step, command, cwd] of steps) {
      throwIfAborted(signal);
      if (!command) {
        log.system(`Skipping ${step} (no command)`);
        continue;
      }
      if (step === "install" && skipInstall) {
        const saved = cachedInstallMs ? ` (saves ~${(cachedInstallMs / 1000).toFixed(1)}s)` : "";
        log.system(`Skipping install: node_modules restored from build cache${saved}`);
        installMs = cachedInstallMs;
        continue;
      }
      log.system(`Running ${step}: "${command}"`);
      t = Date.now();
      const code = await ctx.runner.run({
        name: `${deployment.id}-${step}`,
        workspaceDir: workspace,
        rootDirectory: cwd,
        command,
        env: buildEnv,
        onOutput: log.write,
        signal,
      });
      throwIfAborted(signal);
      if (code !== 0) throw new BuildError(`Command "${command}" exited with ${code}`);
      if (step === "install") installMs = Date.now() - t;
      log.system(`${step === "install" ? "Installed dependencies" : "Build completed"} in ${seconds(t)}`);
    }

    // 5. Collect output -------------------------------------------------------
    let stats: { fileCount: number; totalBytes: number };
    let server: DeploymentManifest["server"];
    if (settings.server) {
      ({ stats, server } = collectNextServer(
        projectDir,
        stagingDir,
        path.join(config.dataDir, RUNTIME_DIR, deployment.id),
        artifactDir,
      ));
      log.system(
        `Collected Next.js server ${server.entry} and ${stats.fileCount} static assets (${formatBytes(stats.totalBytes)})`,
      );
    } else {
      const outputDir = path.join(projectDir, settings.outputDirectory);
      if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
        throw new BuildError(`Output directory "${settings.outputDirectory}" was not found after the build.`);
      }
      stats = copyOutput(outputDir, path.join(stagingDir, STATIC_DIR), path.resolve(outputDir) === path.resolve(projectDir));
      if (stats.fileCount === 0) throw new BuildError(`Output directory "${settings.outputDirectory}" is empty`);
      log.system(
        `Collected ${stats.fileCount} static files (${formatBytes(stats.totalBytes)}) from "${settings.outputDirectory}"`,
      );
    }

    // 6. Functions --------------------------------------------------------------
    throwIfAborted(signal);
    const vercelFunctions = (snapshot.vercelJson as { functions?: unknown } | undefined)?.functions;
    const bundled = await bundleFunctions(projectDir, path.join(stagingDir, FUNCTIONS_DIR), {
      config: vercelFunctions,
      maxMemoryMb: config.functionMaxMemoryMb,
      maxDurationSeconds: config.functionMaxDurationSeconds,
      warn: (message) => log.system(`Warning: ${message}`),
    }).catch((err: Error) => {
      throw new BuildError(`Bundling functions failed: ${err.message}`);
    });
    const functions = bundled.routes;
    if (functions.length || server) {
      // Like Vercel, a deployment's functions see the env as of build time, so the artifact stays immutable.
      const { CI: _ci, ...runtimeEnv } = buildEnv;
      fs.writeFileSync(path.join(stagingDir, FUNCTION_ENV_FILE), JSON.stringify(runtimeEnv), { mode: 0o600 });
    }
    if (functions.length) log.system(`Bundled ${functions.length} function(s): ${functions.map((f) => f.route).join(", ")}`);
    if (bundled.includedFiles) log.system(`Included ${plural(bundled.includedFiles, "file")} with functions (includeFiles)`);

    // 7. Publish (atomic rename: the artifact appears complete or not at all) ---
    const manifest: DeploymentManifest = {
      version: 1,
      deploymentId: deployment.id,
      projectId: project.id,
      framework: settings.framework,
      spa: settings.spa,
      cleanUrls: settings.cleanUrls,
      functions,
      ...(server ? { server } : {}),
      ...(hasRoutingRules(routing) ? { routing } : {}),
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
      createdAt: Date.now(),
    };
    fs.writeFileSync(path.join(stagingDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    throwIfAborted(signal);
    fs.renameSync(stagingDir, artifactDir);

    // 8. Save the build cache for the next deployment ------------------------------
    if (cache) {
      t = Date.now();
      if (cache.save(cacheKey, deployment.id, installMs)) log.system(`Saved build cache in ${Date.now() - t}ms`);
    }
    log.system(`Deployment ready in ${seconds(started)}`);
    return { manifest };
  } finally {
    cache?.release();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

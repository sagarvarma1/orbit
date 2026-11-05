import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { globToRegExp } from "../lib/glob.js";
import type { FunctionRoute } from "../lib/manifest.js";

const SOURCE_RE = /\.(?:js|mjs|cjs|ts|mts|cts)$/;
const PYTHON_RE = /\.py$/;
/** Where a Python function's installed requirements live, relative to the function root. */
export const PYTHON_PACKAGES_DIR = ".orbit/python";
/** Vercel's limit for a function bundle (uncompressed). */
const MAX_PYTHON_BUNDLE_BYTES = 250 * 1024 * 1024;
/** Never part of a Python function bundle. */
const PYTHON_EXCLUDED = new Set([
  ".git",
  "node_modules",
  ".next",
  ".vercel",
  ".orbit",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
]);

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    // `_helpers.ts` / `_lib/` are shared code, not routes (same convention as Vercel).
    if (entry.name.startsWith("_") || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walk(dir, child));
    else if (
      (SOURCE_RE.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) && !/\.test\./.test(entry.name)) ||
      (PYTHON_RE.test(entry.name) && !/^test_|_test\.py$/.test(entry.name))
    )
      out.push(child);
  }
  return out;
}

/** "users/[id].ts" -> "/api/users/[id]", "index.ts" -> "/api" */
export function routeForFile(relFile: string): string {
  const withoutExt = relFile.replace(SOURCE_RE, "").replace(PYTHON_RE, "");
  const route = withoutExt === "index" ? "" : withoutExt.replace(/\/index$/, "");
  return route ? `/api/${route}` : "/api";
}

/** One entry of vercel.json `functions`, keyed by a glob over source paths like "api/*.js". */
export interface FunctionConfig {
  includeFiles?: string;
  excludeFiles?: string;
  memory?: number;
  maxDuration?: number;
}

export interface BundleOptions {
  /** vercel.json `functions`. */
  config?: unknown;
  maxMemoryMb: number;
  maxDurationSeconds: number;
  warn?: (message: string) => void;
}

export interface BundleResult {
  routes: FunctionRoute[];
  /** Files copied from `includeFiles`. */
  includedFiles: number;
  /** Python functions were found: the project's files were copied, requirements still need installing. */
  python: boolean;
}

function configFor(config: unknown, source: string): FunctionConfig {
  if (!config || typeof config !== "object") return {};
  const merged: FunctionConfig = {};
  for (const [pattern, value] of Object.entries(config as Record<string, unknown>)) {
    if (value && typeof value === "object" && globToRegExp(pattern).test(source)) Object.assign(merged, value);
  }
  return merged;
}

/** Every regular file under the project (no node_modules or .git), as POSIX relative paths. */
function projectFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...projectFiles(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/**
 * Bundles every function in `<projectDir>/api` into a self-contained ESM file (dependencies
 * inlined from the repo's node_modules), so the edge can run it without the build workspace.
 *
 * `outDir` mirrors the project root, like Vercel's /var/task: `api/hello.ts` becomes
 * `api/hello.mjs`, `includeFiles` keep their paths, and the function runs with `outDir` as its
 * working directory. `__dirname` is the bundle's directory, so `path.join(__dirname, "../data")`
 * from a function in api/ finds included files.
 */
export async function bundleFunctions(projectDir: string, outDir: string, opts: BundleOptions): Promise<BundleResult> {
  const empty = { routes: [], includedFiles: 0, python: false };
  const apiDir = path.join(projectDir, "api");
  if (!fs.existsSync(apiDir) || !fs.statSync(apiDir).isDirectory()) return empty;
  const files = walk(apiDir);
  if (files.length === 0) return empty;
  const nodeFiles = files.filter((f) => SOURCE_RE.test(f));
  const pythonFiles = files.filter((f) => PYTHON_RE.test(f));

  // Two files can't serve one route (api/hello.js and api/hello.py).
  const seen = new Map<string, string>();
  for (const f of files) {
    const route = routeForFile(f);
    const other = seen.get(route);
    if (other) throw new Error(`api/${other} and api/${f} both define ${route}`);
    seen.set(route, f);
  }

  if (nodeFiles.length) {
    const entryPoints = Object.fromEntries(nodeFiles.map((f) => [`api/${f.replace(SOURCE_RE, "")}`, path.join(apiDir, f)]));
    await build({
      entryPoints,
      outdir: outDir,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      absWorkingDir: projectDir,
      logLevel: "silent",
      // Bundled CommonJS dependencies may call require(); give ESM output a real one.
      // CommonJS code also expects __dirname and __filename, which ESM doesn't have.
      banner: {
        js: [
          "import { createRequire as __orbitCreateRequire } from 'node:module';",
          "import { fileURLToPath as __orbitFileURLToPath } from 'node:url';",
          "import { dirname as __orbitDirname } from 'node:path';",
          "const require = __orbitCreateRequire(import.meta.url);",
          "const __orbit_filename = __orbitFileURLToPath(import.meta.url);",
          "const __orbit_dirname = __orbitDirname(__orbit_filename);",
        ].join(" "),
      },
      // Only free references are replaced, so code that declares its own __dirname is untouched.
      define: { __dirname: "__orbit_dirname", __filename: "__orbit_filename" },
    });
  }

  const included = new Set<string>();
  let allFiles: string[] | null = null;
  const routes = files.map((f): FunctionRoute => {
    const source = `api/${f}`;
    const config = configFor(opts.config, source);
    const python = PYTHON_RE.test(f);
    const route: FunctionRoute = python
      ? { route: routeForFile(f), file: path.posix.join("functions", source), runtime: "python" }
      : { route: routeForFile(f), file: path.posix.join("functions", `api/${f.replace(SOURCE_RE, "")}.mjs`), runtime: "node" };

    if (typeof config.includeFiles === "string" && !python) {
      allFiles ??= projectFiles(projectDir);
      const re = globToRegExp(config.includeFiles);
      const matched = allFiles.filter((p) => re.test(p));
      if (matched.length === 0) opts.warn?.(`includeFiles "${config.includeFiles}" (${source}) matched no files`);
      for (const p of matched) included.add(p);
    }
    if (typeof config.memory === "number" && config.memory > 0) {
      route.memoryMb = Math.min(Math.round(config.memory), opts.maxMemoryMb);
      if (config.memory > opts.maxMemoryMb)
        opts.warn?.(`${source}: memory ${config.memory} MB is above this server's limit; using ${opts.maxMemoryMb} MB`);
    }
    if (typeof config.maxDuration === "number" && config.maxDuration > 0) {
      route.maxDurationMs = Math.min(config.maxDuration, opts.maxDurationSeconds) * 1000;
      if (config.maxDuration > opts.maxDurationSeconds)
        opts.warn?.(
          `${source}: maxDuration ${config.maxDuration}s is above this server's limit; using ${opts.maxDurationSeconds}s`,
        );
    }
    return route;
  });

  for (const p of included) {
    const target = path.join(outDir, p);
    if (fs.existsSync(target)) continue; // never overwrite a bundle
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(projectDir, p), target);
  }

  // Like Vercel, a Python function bundle is the project's files (Python isn't bundled), minus
  // anything matching a function's `excludeFiles`.
  if (pythonFiles.length) {
    const excludes = pythonFiles
      .map((f) => configFor(opts.config, `api/${f}`).excludeFiles)
      .filter((g): g is string => typeof g === "string")
      .map((g) => globToRegExp(g));
    let bytes = 0;
    for (const p of pythonProjectFiles(projectDir)) {
      if (excludes.some((re) => re.test(p))) continue;
      const target = path.join(outDir, p);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(projectDir, p), target);
      bytes += fs.statSync(target).size;
    }
    if (bytes > MAX_PYTHON_BUNDLE_BYTES) {
      opts.warn?.(
        `Python function files are ${Math.round(bytes / 1024 / 1024)} MB, above Vercel's 250 MB limit; use excludeFiles in vercel.json`,
      );
    }
  }

  return {
    routes: routes.sort((a, b) => a.route.localeCompare(b.route)),
    includedFiles: included.size,
    python: pythonFiles.length > 0,
  };
}

/** The project's files for a Python bundle: no VCS, dependencies, caches, virtualenvs or env files. */
function pythonProjectFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (PYTHON_EXCLUDED.has(entry.name) || entry.name.startsWith(".env")) continue;
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...pythonProjectFiles(dir, child));
    else if (entry.isFile() && !entry.name.endsWith(".pyc")) out.push(child);
  }
  return out;
}

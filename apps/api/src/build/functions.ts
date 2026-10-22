import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { FunctionRoute } from "../lib/manifest.js";

const SOURCE_RE = /\.(?:js|mjs|cjs|ts|mts|cts)$/;

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    // `_helpers.ts` / `_lib/` are shared code, not routes (same convention as Vercel).
    if (entry.name.startsWith("_") || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walk(dir, child));
    else if (SOURCE_RE.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(child);
  }
  return out;
}

/** "users/[id].ts" -> "/api/users/[id]", "index.ts" -> "/api" */
export function routeForFile(relFile: string): string {
  const withoutExt = relFile.replace(SOURCE_RE, "");
  const route = withoutExt === "index" ? "" : withoutExt.replace(/\/index$/, "");
  return route ? `/api/${route}` : "/api";
}

/**
 * Bundles every function in `<projectDir>/api` into a self-contained ESM file (dependencies
 * inlined from the repo's node_modules), so the edge can run it without the build workspace.
 */
export async function bundleFunctions(projectDir: string, outDir: string): Promise<FunctionRoute[]> {
  const apiDir = path.join(projectDir, "api");
  if (!fs.existsSync(apiDir) || !fs.statSync(apiDir).isDirectory()) return [];
  const files = walk(apiDir);
  if (files.length === 0) return [];

  const entryPoints = Object.fromEntries(files.map((f) => [f.replace(SOURCE_RE, ""), path.join(apiDir, f)]));
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
    banner: {
      js: "import { createRequire as __orbitCreateRequire } from 'node:module'; const require = __orbitCreateRequire(import.meta.url);",
    },
  });

  return files
    .map((f) => ({ route: routeForFile(f), file: path.posix.join("functions", `${f.replace(SOURCE_RE, "")}.mjs`) }))
    .sort((a, b) => a.route.localeCompare(b.route));
}

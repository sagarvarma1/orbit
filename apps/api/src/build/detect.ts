import fs from "node:fs";
import path from "node:path";

export type FrameworkId = "nextjs" | "astro" | "create-react-app" | "vite" | "node" | "static";
export type PackageManager = "npm" | "pnpm" | "yarn";

export interface PackageJson {
  name?: string;
  workspaces?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

/** Everything detection needs, read once from disk. Pure input makes detection easy to test. */
export interface RepoSnapshot {
  /** Entries at the project root (files and directories). */
  files: string[];
  packageJson: PackageJson | null;
  /** Contents of next.config.* if present. */
  nextConfig?: string;
}

/**
 * The monorepo root above the project, when the project lives in a workspace (pnpm, yarn or npm
 * workspaces, Turborepo). Dependencies are installed there, not in the project directory.
 */
export interface WorkspaceRoot {
  /** Path of the workspace root relative to the repository root ("." for the repo root). */
  directory: string;
  files: string[];
  packageJson: PackageJson | null;
}

export interface FrameworkPreset {
  id: FrameworkId;
  name: string;
  /** Default output directory relative to the project root. */
  outputDirectory: string;
  /** Unknown paths fall back to /index.html (client-side routing). */
  spa: boolean;
  /** /about serves /about.html. */
  cleanUrls: boolean;
}

export const PRESETS: Record<FrameworkId, FrameworkPreset> = {
  nextjs: { id: "nextjs", name: "Next.js (static export)", outputDirectory: "out", spa: false, cleanUrls: true },
  astro: { id: "astro", name: "Astro", outputDirectory: "dist", spa: false, cleanUrls: true },
  "create-react-app": { id: "create-react-app", name: "Create React App", outputDirectory: "build", spa: true, cleanUrls: false },
  vite: { id: "vite", name: "Vite", outputDirectory: "dist", spa: true, cleanUrls: false },
  node: { id: "node", name: "Other (build script)", outputDirectory: "dist", spa: false, cleanUrls: true },
  static: { id: "static", name: "Static HTML", outputDirectory: ".", spa: false, cleanUrls: true },
};

export interface BuildSettings {
  framework: FrameworkId;
  frameworkName: string;
  packageManager: PackageManager | null;
  /** null means "skip this step" (e.g. plain static sites). */
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string;
  spa: boolean;
  cleanUrls: boolean;
  warnings: string[];
  /** Set for monorepo projects: install (and Turborepo builds) run from here, relative to the repo root. */
  workspaceRoot: string | null;
  /** Where the build command runs: the project directory, or the workspace root (Turborepo). */
  buildFrom: "project" | "workspace";
}

export interface BuildOverrides {
  framework?: FrameworkId | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  outputDirectory?: string | null;
}

function hasDep(pkg: PackageJson | null, name: string): boolean {
  return Boolean(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]);
}

export function detectPackageManager(snapshot: RepoSnapshot): PackageManager | null {
  if (!snapshot.packageJson) return null;
  const declared = snapshot.packageJson.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  const files = new Set(snapshot.files);
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  return "npm";
}

export function detectFrameworkId(snapshot: RepoSnapshot): FrameworkId {
  const pkg = snapshot.packageJson;
  if (!pkg) return "static";
  if (hasDep(pkg, "next")) return "nextjs";
  if (hasDep(pkg, "astro")) return "astro";
  if (hasDep(pkg, "react-scripts")) return "create-react-app";
  if (hasDep(pkg, "vite")) return "vite";
  if (pkg.scripts?.build) return "node";
  return "static";
}

function installCommandFor(pm: PackageManager, files: Set<string>): string {
  switch (pm) {
    case "pnpm":
      return files.has("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "yarn":
      if (files.has(".yarnrc.yml")) return "yarn install --immutable";
      return files.has("yarn.lock") ? "yarn install --frozen-lockfile" : "yarn install";
    case "npm":
      return files.has("package-lock.json") ? "npm ci" : "npm install";
  }
}

/** Detect framework + commands, then apply user overrides (overrides always win). */
export function resolveBuildSettings(
  snapshot: RepoSnapshot,
  overrides: BuildOverrides = {},
  workspace: WorkspaceRoot | null = null,
): BuildSettings {
  const files = new Set(snapshot.files);
  const warnings: string[] = [];
  const framework = overrides.framework ?? detectFrameworkId(snapshot);
  const preset = PRESETS[framework];
  // In a monorepo the lockfile and package manager are declared at the workspace root.
  const installFiles = new Set(workspace ? workspace.files : snapshot.files);
  const pm = workspace
    ? detectPackageManager({ files: workspace.files, packageJson: workspace.packageJson ?? snapshot.packageJson })
    : detectPackageManager(snapshot);

  if (installFiles.has("bun.lockb") || installFiles.has("bun.lock"))
    warnings.push("bun lockfile found; Orbit builds with npm instead.");

  let installCommand: string | null = pm ? installCommandFor(pm, installFiles) : null;
  let buildCommand: string | null = pm && snapshot.packageJson?.scripts?.build ? `${pm} run build` : null;
  let buildFrom: BuildSettings["buildFrom"] = "project";
  // Turborepo builds the project's internal dependencies first; plain `run build` wouldn't.
  if (workspace && buildCommand && installFiles.has("turbo.json") && snapshot.packageJson?.name) {
    buildCommand = `npx turbo run build --filter=${snapshot.packageJson.name}`;
    buildFrom = "workspace";
  }
  let outputDirectory = preset.outputDirectory;

  if (framework === "static" && !files.has("index.html") && files.has("public")) outputDirectory = "public";

  if (framework === "nextjs") {
    const exportsStatically = snapshot.nextConfig && /output\s*:\s*["'`]export["'`]/.test(snapshot.nextConfig);
    if (!exportsStatically) {
      warnings.push("Next.js: Orbit serves static output. Set `output: 'export'` in next.config to produce `out/`.");
    }
  }

  if (overrides.installCommand !== undefined && overrides.installCommand !== null)
    installCommand = overrides.installCommand || null;
  if (overrides.buildCommand !== undefined && overrides.buildCommand !== null) {
    buildCommand = overrides.buildCommand || null;
    buildFrom = "project";
  }
  if (overrides.outputDirectory) outputDirectory = overrides.outputDirectory;

  return {
    framework,
    frameworkName: preset.name,
    packageManager: pm,
    installCommand,
    buildCommand,
    outputDirectory: normalizeRelative(outputDirectory),
    spa: preset.spa,
    cleanUrls: preset.cleanUrls,
    warnings,
    workspaceRoot: workspace?.directory ?? null,
    buildFrom,
  };
}

const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb"];

/**
 * For a project in a subdirectory without its own lockfile, the nearest ancestor (up to the repo
 * root) that has one, or that declares workspaces. null for standalone projects.
 */
export function findWorkspaceRoot(repoDir: string, rootDirectory: string): WorkspaceRoot | null {
  if (rootDirectory === ".") return null;
  const projectDir = path.join(repoDir, rootDirectory);
  if (LOCKFILES.some((f) => fs.existsSync(path.join(projectDir, f)))) return null;
  let rel = path.posix.dirname(rootDirectory);
  for (;;) {
    const dir = path.join(repoDir, rel);
    const snapshot = readSnapshot(dir);
    const declaresWorkspaces = snapshot.files.includes("pnpm-workspace.yaml") || Boolean(snapshot.packageJson?.workspaces);
    if (declaresWorkspaces || LOCKFILES.some((f) => snapshot.files.includes(f))) {
      return { directory: rel, files: snapshot.files, packageJson: snapshot.packageJson };
    }
    if (rel === ".") return null;
    rel = path.posix.dirname(rel);
  }
}

/** Normalizes a user-supplied relative path and refuses anything that escapes the repo. */
export function normalizeRelative(p: string): string {
  const normalized = path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") return ".";
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`Path "${p}" escapes the repository`);
  return normalized;
}

export function readSnapshot(dir: string): RepoSnapshot {
  const files = fs.readdirSync(dir);
  let packageJson: PackageJson | null = null;
  if (files.includes("package.json")) {
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
    } catch {
      packageJson = null;
    }
  }
  const nextConfigFile = files.find((f) => /^next\.config\.(js|mjs|cjs|ts|mts)$/.test(f));
  const nextConfig = nextConfigFile ? fs.readFileSync(path.join(dir, nextConfigFile), "utf8") : undefined;
  return { files, packageJson, nextConfig };
}

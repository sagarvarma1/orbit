import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectFrameworkId,
  detectPackageManager,
  findWorkspaceRoot,
  normalizeRelative,
  resolveBuildSettings,
  type RepoSnapshot,
} from "../src/build/detect.js";

const snap = (packageJson: RepoSnapshot["packageJson"], files: string[] = [], nextConfig?: string): RepoSnapshot => ({
  packageJson,
  files: packageJson ? ["package.json", ...files] : files,
  nextConfig,
});

describe("framework detection", () => {
  it("detects Vite (SPA, dist)", () => {
    const s = resolveBuildSettings(
      snap({ scripts: { build: "vite build" }, devDependencies: { vite: "^7" } }, ["package-lock.json"]),
    );
    expect(s).toMatchObject({
      framework: "vite",
      outputDirectory: "dist",
      spa: true,
      installCommand: "npm ci",
      buildCommand: "npm run build",
    });
  });

  it("detects Next.js and warns when static export is not configured", () => {
    const withoutExport = resolveBuildSettings(
      snap({ scripts: { build: "next build" }, dependencies: { next: "16" } }, [], "export default {}"),
    );
    expect(withoutExport.framework).toBe("nextjs");
    expect(withoutExport.outputDirectory).toBe("out");
    expect(withoutExport.warnings.join()).toMatch(/output: 'export'/);

    const withExport = resolveBuildSettings(
      snap({ scripts: { build: "next build" }, dependencies: { next: "16" } }, [], "module.exports = { output: 'export' }"),
    );
    expect(withExport.warnings).toHaveLength(0);
    expect(withExport.cleanUrls).toBe(true);
  });

  it("detects Create React App (build/, SPA)", () => {
    const s = resolveBuildSettings(
      snap({ scripts: { build: "react-scripts build" }, dependencies: { "react-scripts": "5" } }, ["yarn.lock"]),
    );
    expect(s).toMatchObject({
      framework: "create-react-app",
      outputDirectory: "build",
      spa: true,
      packageManager: "yarn",
      installCommand: "yarn install --frozen-lockfile",
    });
  });

  it("detects Astro", () => {
    expect(detectFrameworkId(snap({ dependencies: { astro: "5" }, scripts: { build: "astro build" } }))).toBe("astro");
  });

  it("prefers the most specific framework (Next.js over React)", () => {
    expect(detectFrameworkId(snap({ dependencies: { next: "16", react: "19", vite: "7" } }))).toBe("nextjs");
  });

  it("falls back to a generic build script", () => {
    const s = resolveBuildSettings(snap({ scripts: { build: "node build.js" } }, ["pnpm-lock.yaml"]));
    expect(s).toMatchObject({
      framework: "node",
      packageManager: "pnpm",
      installCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm run build",
    });
  });

  it("treats a repo without package.json as static HTML with no install/build", () => {
    const s = resolveBuildSettings(snap(null, ["index.html", "styles"]));
    expect(s).toMatchObject({ framework: "static", installCommand: null, buildCommand: null, outputDirectory: "." });
  });

  it("serves public/ for static repos without a root index.html", () => {
    expect(resolveBuildSettings(snap(null, ["public", "README.md"])).outputDirectory).toBe("public");
  });

  it("applies user overrides over detection, including empty = skip", () => {
    const s = resolveBuildSettings(snap({ scripts: { build: "vite build" }, devDependencies: { vite: "7" } }), {
      installCommand: "npm install --legacy-peer-deps",
      buildCommand: "",
      outputDirectory: "./site/",
    });
    expect(s).toMatchObject({ installCommand: "npm install --legacy-peer-deps", buildCommand: null, outputDirectory: "site" });
  });

  it("honors an explicitly chosen framework preset", () => {
    expect(resolveBuildSettings(snap({ dependencies: { vite: "7" } }), { framework: "static" }).framework).toBe("static");
  });
});

describe("vercel.json build settings", () => {
  const withConfig = (vercelJson: unknown, packageJson: RepoSnapshot["packageJson"] = null, files: string[] = []) => ({
    ...snap(packageJson, ["vercel.json", ...files]),
    vercelJson,
  });

  it("uses outputDirectory for a static site (the americantimeuse.com layout)", () => {
    const s = resolveBuildSettings(
      withConfig({ framework: null, outputDirectory: "dist", cleanUrls: true }, null, ["dist", "api"]),
    );
    expect(s).toMatchObject({
      framework: "static",
      outputDirectory: "dist",
      installCommand: null,
      buildCommand: null,
      cleanUrls: true,
    });
    expect(s.fromConfig).toEqual(["outputDirectory", "cleanUrls"]);
  });

  it("takes commands and framework from vercel.json, but dashboard settings still win", () => {
    const config = { framework: "vite", buildCommand: "npm run build:site", installCommand: "", outputDirectory: "site" };
    const pkg = { scripts: { build: "x" } };
    expect(resolveBuildSettings(withConfig(config, pkg, ["package-lock.json"]))).toMatchObject({
      framework: "vite",
      buildCommand: "npm run build:site",
      installCommand: null,
      outputDirectory: "site",
    });
    expect(
      resolveBuildSettings(withConfig(config, pkg, ["package-lock.json"]), { outputDirectory: "out", buildCommand: "make" }),
    ).toMatchObject({ outputDirectory: "out", buildCommand: "make", installCommand: null });
  });

  it("warns about values it can't use instead of failing", () => {
    const s = resolveBuildSettings(withConfig({ framework: "sveltekit", outputDirectory: 42 }));
    expect(s.framework).toBe("static");
    expect(s.outputDirectory).toBe(".");
    expect(s.warnings).toEqual([
      'vercel.json: "outputDirectory" must be a string; ignored.',
      'vercel.json: framework "sveltekit" isn\'t supported; detecting instead.',
    ]);
  });
});

describe("package manager detection", () => {
  it("uses the packageManager field first, then lockfiles", () => {
    expect(detectPackageManager(snap({ packageManager: "pnpm@10.0.0" }, ["package-lock.json"]))).toBe("pnpm");
    expect(detectPackageManager(snap({}, ["yarn.lock"]))).toBe("yarn");
    expect(detectPackageManager(snap({}, ["pnpm-lock.yaml"]))).toBe("pnpm");
    expect(detectPackageManager(snap({}, []))).toBe("npm");
    expect(detectPackageManager(snap(null, ["index.html"]))).toBeNull();
  });
});

describe("normalizeRelative", () => {
  it("normalizes and rejects paths escaping the repo", () => {
    expect(normalizeRelative("./dist/")).toBe("dist");
    expect(normalizeRelative("")).toBe(".");
    expect(normalizeRelative("/apps/web")).toBe("apps/web");
    expect(() => normalizeRelative("../etc")).toThrow();
    expect(() => normalizeRelative("a/../../b")).toThrow();
  });
});

describe("monorepos", () => {
  function repo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-mono-"));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  }

  it("finds the workspace root above a project without its own lockfile", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "root", packageManager: "pnpm@10.0.0" }),
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages: ['apps/*']",
      "apps/web/package.json": JSON.stringify({ name: "web", scripts: { build: "vite build" }, devDependencies: { vite: "7" } }),
      "examples/standalone/package.json": "{}",
      "examples/standalone/package-lock.json": "{}",
    });
    expect(findWorkspaceRoot(dir, "apps/web")).toMatchObject({ directory: "." });
    expect(findWorkspaceRoot(dir, "examples/standalone")).toBeNull(); // has its own lockfile
    expect(findWorkspaceRoot(dir, ".")).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("installs at the root with its package manager and builds the project there", () => {
    const workspace = {
      directory: ".",
      files: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"],
      packageJson: { name: "root", workspaces: undefined },
    };
    const web = snap({ name: "web", scripts: { build: "vite build" }, devDependencies: { vite: "7" } });
    expect(resolveBuildSettings(web, {}, workspace)).toMatchObject({
      framework: "vite",
      packageManager: "pnpm",
      installCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm run build",
      workspaceRoot: ".",
      buildFrom: "project",
    });
  });

  it("uses Turborepo when the workspace has turbo.json, unless the build command is overridden", () => {
    const workspace = {
      directory: ".",
      files: ["package.json", "package-lock.json", "turbo.json"],
      packageJson: { workspaces: ["apps/*"] },
    };
    const web = snap({ name: "@acme/web", scripts: { build: "next build" }, dependencies: { next: "16" } });
    expect(resolveBuildSettings(web, {}, workspace)).toMatchObject({
      installCommand: "npm ci",
      buildCommand: "npx turbo run build --filter=@acme/web",
      buildFrom: "workspace",
    });
    expect(resolveBuildSettings(web, { buildCommand: "npm run build:static" }, workspace)).toMatchObject({
      buildCommand: "npm run build:static",
      buildFrom: "project",
    });
  });
});

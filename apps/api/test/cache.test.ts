import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BuildCache, computeCacheKey } from "../src/build/cache.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-cache-test-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const npm = { installCommand: "npm ci", customInstall: false, platform: "darwin-arm64-node22" };
const keyOf = (dir: string, input = npm) => {
  const result = computeCacheKey(dir, input);
  return "key" in result ? result.key : result.reason;
};

describe("cache key", () => {
  it("is stable for the same lockfile and changes when dependencies or platform change", () => {
    const a = project("a", { "package.json": '{"name":"a"}', "package-lock.json": '{"v":1}' });
    const b = project("b", { "package.json": '{"name":"a"}', "package-lock.json": '{"v":1}' });
    const c = project("c", { "package.json": '{"name":"a"}', "package-lock.json": '{"v":2}' });
    expect(keyOf(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyOf(a)).toBe(keyOf(b));
    expect(keyOf(a)).not.toBe(keyOf(c));
    expect(keyOf(a)).not.toBe(keyOf(a, { ...npm, platform: "docker:node:22" }));
  });
  it("refuses to cache when skipping install would be unsafe", () => {
    expect(keyOf(project("nolock", { "package.json": "{}" }))).toBe("no lockfile");
    expect(keyOf(project("ws", { "package.json": '{"workspaces":["packages/*"]}', "package-lock.json": "{}" }))).toBe(
      "workspaces",
    );
    const plain = project("custom", { "package.json": "{}", "package-lock.json": "{}" });
    expect(keyOf(plain, { ...npm, customInstall: true })).toBe("custom install command");
    expect(keyOf(plain, { ...npm, installCommand: null as unknown as string })).toBe("no install step");
  });
});

describe("BuildCache", () => {
  const entry = () => path.join(tmp, "cache", "prj_1");
  const build = (name: string) => project(name, { "package.json": "{}" });
  const install = (dir: string, marker: string) => {
    fs.mkdirSync(path.join(dir, "node_modules", "react"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "react", "index.js"), marker);
  };

  it("misses on first build, then restores node_modules by moving it when the key matches", () => {
    const first = build("build1");
    const c1 = new BuildCache(entry(), first);
    expect(c1.restore("k1").hit).toBe(false);
    install(first, "v1");
    fs.mkdirSync(path.join(first, ".next/cache/webpack"), { recursive: true });
    expect(c1.save("k1", "dpl-1", 4200)).toBe(true);
    expect(fs.existsSync(path.join(first, "node_modules"))).toBe(false); // moved, not copied

    const second = build("build2");
    const restored = new BuildCache(entry(), second).restore("k1");
    expect(restored).toMatchObject({ hit: true, meta: { deploymentId: "dpl-1", installMs: 4200 } });
    expect(restored.restoredDirs).toEqual([".next/cache"]);
    expect(fs.readFileSync(path.join(second, "node_modules/react/index.js"), "utf8")).toBe("v1");
  });

  it("does not restore node_modules for a different key, but still restores framework caches", () => {
    const first = build("build1");
    install(first, "v1");
    fs.mkdirSync(path.join(first, ".next/cache"), { recursive: true });
    new BuildCache(entry(), first).save("k1", "dpl-1", 1000);

    const second = build("build2");
    const restored = new BuildCache(entry(), second).restore("k2");
    expect(restored.hit).toBe(false);
    expect(restored.restoredDirs).toEqual([".next/cache"]);
    expect(fs.existsSync(path.join(second, "node_modules"))).toBe(false);
  });

  it("gives the cache back when a build fails after restoring it", () => {
    const first = build("build1");
    install(first, "v1");
    new BuildCache(entry(), first).save("k1", "dpl-1", 1000);

    const failing = build("failing");
    const cache = new BuildCache(entry(), failing);
    expect(cache.restore("k1").hit).toBe(true);
    cache.release();
    expect(fs.existsSync(path.join(entry(), "node_modules/react/index.js"))).toBe(true);
    expect(new BuildCache(entry(), build("build3")).restore("k1").hit).toBe(true);
  });

  it("replaces the previous entry when saving a new one", () => {
    const first = build("build1");
    install(first, "v1");
    new BuildCache(entry(), first).save("k1", "dpl-1", 1000);
    const second = build("build2");
    install(second, "v2");
    new BuildCache(entry(), second).save("k2", "dpl-2", 2000);

    const third = build("build3");
    expect(new BuildCache(entry(), third).restore("k1").hit).toBe(false);
    expect(new BuildCache(entry(), third).restore("k2").hit).toBe(true);
    expect(fs.readFileSync(path.join(third, "node_modules/react/index.js"), "utf8")).toBe("v2");
    expect(fs.readdirSync(path.dirname(entry()))).toEqual(["prj_1"]); // no staging leftovers
  });
});

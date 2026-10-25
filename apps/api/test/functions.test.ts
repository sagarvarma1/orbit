import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleFunctions } from "../src/build/functions.js";
import { FunctionPool, invokeFunction } from "../src/edge/functions.js";
import { globToRegExp } from "../src/lib/glob.js";
import type { FunctionRoute } from "../src/lib/manifest.js";

describe("globToRegExp", () => {
  it("handles *, ** and {a,b} like vercel.json", () => {
    const re = globToRegExp("dist/{data.js,engine.js,diaries/**}");
    expect(["dist/data.js", "dist/engine.js", "dist/diaries/2024.bin", "dist/diaries/a/b.bin"].every((p) => re.test(p))).toBe(
      true,
    );
    expect(["dist/app.js", "dist/data.json", "data.js"].some((p) => re.test(p))).toBe(false);
    expect(globToRegExp("api/*.js").test("api/view.js")).toBe(true);
    expect(globToRegExp("api/*.js").test("api/nested/view.js")).toBe(false);
    expect(globToRegExp("api/**/*.ts").test("api/view.ts")).toBe(true);
  });
});

describe("function bundles", () => {
  let dir: string;
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, "project", rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, "project", rel), content);
  };
  const invoke = (route: FunctionRoute, url: string) =>
    invokeFunction({
      artifactDir: path.join(dir, "artifact"),
      route,
      params: {},
      request: { method: "GET", url, headers: {}, body: Buffer.alloc(0) },
      env: {},
      timeoutMs: 10_000,
      memoryMb: route.memoryMb ?? 128,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-fn-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("runs CommonJS handlers that read includeFiles via __dirname and the working directory", async () => {
    // The shape of americantimeuse.com: a shared _service.js loading data from dist/ next to api/.
    write(
      "api/_service.js",
      `const fs = require("node:fs"), path = require("node:path");
       const { label } = require("../dist/engine.js");
       exports.handler = (kind) => (req, res) => {
         const fromDirname = fs.readFileSync(path.join(__dirname, "..", "dist", "data.txt"), "utf8");
         const fromCwd = fs.readFileSync("dist/deep/more.txt", "utf8");
         res.statusCode = kind === "bad" ? 400 : 200;
         res.setHeader("Content-Type", "application/json");
         res.end(JSON.stringify({ label: label(kind), fromDirname, fromCwd, url: req.url }));
       };`,
    );
    write("api/view.js", `module.exports = require("./_service.js").handler("view");`);
    write("api/bad.js", `module.exports = require("./_service.js").handler("bad");`);
    write("dist/engine.js", `exports.label = (k) => "engine:" + k;`);
    write("dist/data.txt", "hello");
    write("dist/deep/more.txt", "world");
    write("dist/index.html", "<h1>not included</h1>");

    const warnings: string[] = [];
    const { routes, includedFiles } = await bundleFunctions(path.join(dir, "project"), path.join(dir, "artifact", "functions"), {
      config: { "api/*.js": { includeFiles: "dist/{data.txt,deep/**}", memory: 4096, maxDuration: 10 } },
      maxMemoryMb: 1024,
      maxDurationSeconds: 60,
      warn: (m) => warnings.push(m),
    });

    expect(routes).toEqual([
      { route: "/api/bad", file: "functions/api/bad.mjs", memoryMb: 1024, maxDurationMs: 10_000 },
      { route: "/api/view", file: "functions/api/view.mjs", memoryMb: 1024, maxDurationMs: 10_000 },
    ]);
    expect(includedFiles).toBe(2);
    expect(fs.existsSync(path.join(dir, "artifact", "functions", "dist", "index.html"))).toBe(false);
    expect(warnings.join("\n")).toMatch(/memory 4096 MB is above this server's limit/);

    const ok = await invoke(routes[1]!, "https://site.example/api/view?day=all");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body.toString())).toEqual({
      label: "engine:view",
      fromDirname: "hello",
      fromCwd: "world",
      url: "/api/view?day=all",
    });

    // Assigning res.statusCode (not calling res.status()) must be honored.
    expect((await invoke(routes[0]!, "https://site.example/api/bad")).status).toBe(400);
  });

  it("keeps a module's own __dirname declaration working", async () => {
    write(
      "api/esm.mjs",
      `import path from "node:path"; import { fileURLToPath } from "node:url";
       const __dirname = path.dirname(fileURLToPath(import.meta.url));
       export function GET() { return Response.json({ dir: path.basename(__dirname) }); }`,
    );
    const { routes } = await bundleFunctions(path.join(dir, "project"), path.join(dir, "artifact", "functions"), {
      maxMemoryMb: 1024,
      maxDurationSeconds: 60,
    });
    const res = await invoke(routes[0]!, "https://site.example/api/esm");
    expect(JSON.parse(res.body.toString())).toEqual({ dir: "api" });
  });
});

describe("warm function instances", () => {
  let dir: string;
  let pool: FunctionPool;
  const fn = (name: string, source: string) => {
    fs.mkdirSync(path.join(dir, "functions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "functions", `${name}.mjs`), source);
    return { route: `/api/${name}`, file: `functions/${name}.mjs` };
  };
  const call = async (route: FunctionRoute, query = "", timeoutMs = 5_000) => {
    const res = await pool.invoke({
      artifactDir: dir,
      route,
      params: {},
      request: { method: "GET", url: `https://site.example${route.route}${query}`, headers: {}, body: Buffer.alloc(0) },
      env: {},
      timeoutMs,
      memoryMb: 64,
    });
    return { ...(JSON.parse(res.body.toString()) as { n: number; pid: number }), warm: res.warm };
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    return check();
  };
  // Module state survives between requests only when the process is reused.
  const COUNTER = `let n = 0;
    export async function GET(req) {
      const q = new URL(req.url).searchParams;
      if (q.has("boom")) throw new Error("boom");
      if (q.has("sleep")) await new Promise((r) => setTimeout(r, Number(q.get("sleep"))));
      return Response.json({ n: ++n, pid: process.pid });
    }`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-warm-"));
    pool = new FunctionPool({ maxIdlePerFunction: 1, maxIdle: 4, idleTimeoutMs: 60_000 });
  });
  afterEach(() => {
    pool.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reuses a process, so setup runs once", async () => {
    const route = fn("counter", COUNTER);
    const first = await call(route);
    const second = await call(route);
    expect(first).toMatchObject({ n: 1, warm: false });
    expect(second).toMatchObject({ n: 2, warm: true, pid: first.pid });
  });

  it("starts more instances for concurrent requests and keeps only the idle limit", async () => {
    const route = fn("counter", COUNTER);
    const [a, b] = await Promise.all([call(route, "?sleep=200"), call(route, "?sleep=200")]);
    expect(a.pid).not.toBe(b.pid);
    expect(await until(() => pool.size === 1)).toBe(true);
    expect(await call(route)).toMatchObject({ n: 2, warm: true });
  });

  it("retires an instance after a crash or timeout", async () => {
    const route = fn("counter", COUNTER);
    await call(route);
    await expect(call(route, "?boom")).rejects.toThrow("boom");
    expect(await call(route)).toMatchObject({ n: 1, warm: false });
    await expect(call(route, "?sleep=5000", 200)).rejects.toThrow(/timed out/);
    expect(await call(route)).toMatchObject({ n: 1, warm: false });
  });

  it("stops idle instances after the timeout and beyond the global limit", async () => {
    pool.close();
    pool = new FunctionPool({ maxIdlePerFunction: 1, maxIdle: 1, idleTimeoutMs: 300 });
    const one = fn("one", COUNTER);
    const two = fn("two", COUNTER);
    await call(one);
    await call(two);
    expect(await until(() => pool.size === 1)).toBe(true);
    expect(await call(one)).toMatchObject({ warm: false }); // evicted as the oldest idle instance
    expect(await until(() => pool.size === 0)).toBe(true);
  });
});

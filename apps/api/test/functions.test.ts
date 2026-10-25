import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleFunctions } from "../src/build/functions.js";
import { invokeFunction } from "../src/edge/functions.js";
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

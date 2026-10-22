import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEdgeHandler } from "../src/edge/server.js";
import type { DeploymentManifest } from "../src/lib/manifest.js";
import { compileRouting, compileSource, parseRoutingConfig, type RoutingConfig } from "../src/lib/routing.js";

describe("source patterns", () => {
  const matches = (pattern: string, p: string) => compileSource(pattern).re.test(p);

  it("matches named params, one segment at a time", () => {
    expect(matches("/blog/:slug", "/blog/hello")).toBe(true);
    expect(matches("/blog/:slug", "/blog/hello/")).toBe(true);
    expect(matches("/blog/:slug", "/blog/a/b")).toBe(false);
    expect(matches("/blog/:slug", "/blog")).toBe(false);
    expect(matches("/Blog/:slug", "/blog/x")).toBe(true); // case-insensitive, like Vercel
  });
  it("supports :path* (zero or more), :path+ (one or more) and :id? segments", () => {
    expect(matches("/docs/:path*", "/docs")).toBe(true);
    expect(matches("/docs/:path*", "/docs/a/b/c")).toBe(true);
    expect(matches("/docs/:path+", "/docs")).toBe(false);
    expect(matches("/docs/:path+", "/docs/a/b")).toBe(true);
    expect(matches("/users/:id?", "/users")).toBe(true);
    expect(matches("/users/:id?", "/users/42")).toBe(true);
  });
  it("supports raw regex groups and custom param patterns", () => {
    expect(matches("/(.*)", "/anything/at/all")).toBe(true);
    expect(matches("/old-(\\d+)", "/old-42")).toBe(true);
    expect(matches("/old-(\\d+)", "/old-x")).toBe(false);
    expect(matches("/post/:id(\\d+)", "/post/7")).toBe(true);
    expect(matches("/post/:id(\\d+)", "/post/seven")).toBe(false);
  });
  it("treats regex metacharacters outside groups literally", () => {
    expect(matches("/file.html", "/file.html")).toBe(true);
    expect(matches("/file.html", "/fileXhtml")).toBe(false);
  });
});

describe("routing rules", () => {
  const routing = compileRouting(
    parseRoutingConfig({
      redirects: [
        { source: "/blog/:slug", destination: "/articles/:slug" },
        { source: "/temp", destination: "/elsewhere", permanent: false },
        { source: "/old-(\\d+)/(.*)", destination: "/new/$1/$2", statusCode: 301 },
        { source: "/gh", destination: "https://github.com/:org", permanent: false },
      ],
      rewrites: [{ source: "/docs/:path*", destination: "/documentation/:path*" }],
      headers: [
        { source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
        { source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=60" }] },
        { source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      ],
    }),
  );
  const url = (p: string) => new URL(p, "http://app.localhost:8080");

  it("redirects with substituted params, the right status and the original query", () => {
    expect(routing.redirect(url("/blog/hello?ref=x"))).toEqual({ status: 308, location: "/articles/hello?ref=x" });
    expect(routing.redirect(url("/temp"))?.status).toBe(307);
    expect(routing.redirect(url("/old-42/a/b"))).toEqual({ status: 301, location: "/new/42/a/b" });
    expect(routing.redirect(url("/gh"))?.location).toBe("https://github.com/:org");
    expect(routing.redirect(url("/other"))).toBeNull();
  });
  it("rewrites to an internal path", () => {
    expect(routing.rewrite(url("/docs/getting-started"))?.pathname).toBe("/documentation/getting-started");
    expect(routing.rewrite(url("/docs"))?.pathname).toBe("/documentation/");
    expect(routing.rewrite(url("/nope"))).toBeNull();
  });
  it("applies every matching header rule, later rules winning", () => {
    expect(routing.headers("/assets/app.js")).toEqual({ "x-frame-options": "SAMEORIGIN", "cache-control": "public, max-age=60" });
  });
  it("rejects invalid config with a readable error", () => {
    expect(() => parseRoutingConfig({ rewrites: [{ source: "/x", destination: "https://evil.example" }] })).toThrow(
      /external rewrites are not supported/,
    );
    expect(() => parseRoutingConfig({ redirects: [{ source: "no-slash", destination: "/" }] })).toThrow(/must start with \//);
    expect(() => parseRoutingConfig({ headers: [{ source: "/(", headers: [{ key: "a", value: "b" }] }] })).toThrow(/unbalanced/);
    expect(parseRoutingConfig({ buildCommand: "x", framework: "vite" })).toEqual({ redirects: [], rewrites: [], headers: [] });
  });
});

describe("edge with vercel.json routing", () => {
  let tmp: string;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-routing-test-"));
    const id = "dpl-route00001";
    const routingConfig: RoutingConfig = parseRoutingConfig({
      redirects: [{ source: "/blog/:slug", destination: "/articles/:slug" }],
      rewrites: [
        { source: "/help", destination: "/docs/index.html" },
        { source: "/hello/:name", destination: "/api/greet?name=:name" },
        { source: "/(.*)", destination: "/index.html" },
      ],
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
    });
    const files: Record<string, string> = {
      "static/index.html": "<h1>home</h1>",
      "static/docs/index.html": "<h1>docs</h1>",
      "static/app.js": "console.log(1)",
      "functions/greet.mjs": "export default (req) => Response.json({ hi: new URL(req.url).searchParams.get('name') });",
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmp, id, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, id, rel), content);
    }
    const manifest: DeploymentManifest = {
      version: 1,
      deploymentId: id,
      projectId: "prj",
      framework: "static",
      spa: false,
      cleanUrls: true,
      functions: [{ route: "/api/greet", file: "functions/greet.mjs" }],
      routing: routingConfig,
      fileCount: 3,
      totalBytes: 0,
      createdAt: Date.now(),
    };
    fs.writeFileSync(path.join(tmp, id, "orbit.json"), JSON.stringify(manifest));

    const handle = createEdgeHandler({
      rootDomain: "localhost",
      artifactsDir: tmp,
      lookup: { resolve: (label) => (label === "site" ? { deploymentId: id, status: "ready" } : null) },
      functionTimeoutMs: 5000,
      functionMemoryMb: 64,
    });
    server = http.createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function get(urlPath: string, method = "GET") {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers: { host: "site.localhost" } }, (res) => {
        let body = "";
        res
          .setEncoding("utf8")
          .on("data", (c) => (body += c))
          .on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("redirects before serving anything", async () => {
    const res = await get("/blog/hello");
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe("/articles/hello");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
  it("serves files on disk ahead of rewrites", async () => {
    const res = await get("/app.js");
    expect(res.body).toBe("console.log(1)");
    expect(res.headers["content-type"]).toMatch(/javascript/);
  });
  it("rewrites to another file without changing the URL", async () => {
    const res = await get("/help");
    expect(res.status).toBe(200);
    expect(res.body).toBe("<h1>docs</h1>");
  });
  it("rewrites to a serverless function with captured params", async () => {
    const res = await get("/hello/sagar");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ hi: "sagar" });
    expect(res.headers["x-orbit-function"]).toBe("/api/greet");
  });
  it("supports the catch-all SPA rewrite and adds custom headers everywhere", async () => {
    const res = await get("/some/client/route");
    expect(res.body).toBe("<h1>home</h1>");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
  it("still rejects writes to static files", async () => {
    expect((await get("/help", "POST")).status).toBe(405);
  });
});

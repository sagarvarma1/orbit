import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchFunction } from "../src/edge/functions.js";
import { createEdgeHandler, labelFromHost, type ResolvedTarget } from "../src/edge/server.js";
import { cacheControl, isImmutableAsset, resolveStatic } from "../src/edge/static.js";
import type { DeploymentManifest } from "../src/lib/manifest.js";

describe("labelFromHost", () => {
  it("extracts a single label under the root domain", () => {
    expect(labelFromHost("dpl-abc123defg.localhost:8080", "localhost")).toBe("dpl-abc123defg");
    expect(labelFromHost("My-App.LOCALHOST", "localhost")).toBe("my-app");
    expect(labelFromHost("app.example.com", "example.com")).toBe("app");
  });
  it("rejects the bare root, nested labels and other domains", () => {
    expect(labelFromHost("localhost:8080", "localhost")).toBeNull();
    expect(labelFromHost("a.b.localhost", "localhost")).toBeNull();
    expect(labelFromHost("app.evil.com", "example.com")).toBeNull();
    expect(labelFromHost(undefined, "localhost")).toBeNull();
  });
});

describe("cache headers", () => {
  it("marks fingerprinted assets immutable", () => {
    expect(isImmutableAsset("/assets/index-BbW3z1aQ.js")).toBe(true);
    expect(isImmutableAsset("/static/js/main.3f4a5b6c.js")).toBe(true);
    expect(isImmutableAsset("/_next/static/chunks/app.js")).toBe(true);
    expect(isImmutableAsset("/_astro/hoisted.js")).toBe(true);
  });
  it("does not mark ordinary files immutable", () => {
    expect(isImmutableAsset("/my-component.js")).toBe(false);
    expect(isImmutableAsset("/favicon-32x32.png")).toBe(false);
    expect(isImmutableAsset("/react-dom.production.min.js")).toBe(false);
    expect(cacheControl("/index.html", "text/html; charset=utf-8")).toBe("public, max-age=0, must-revalidate");
  });
});

describe("function route matching", () => {
  const routes = [
    { route: "/api/hello", file: "functions/hello.mjs" },
    { route: "/api/users/[id]", file: "functions/users/[id].mjs" },
    { route: "/api/users/me", file: "functions/users/me.mjs" },
    { route: "/api", file: "functions/index.mjs" },
  ];
  it("matches static, dynamic and index routes, static segments first", () => {
    expect(matchFunction(routes, "/api/hello")?.route.route).toBe("/api/hello");
    expect(matchFunction(routes, "/api/hello/")?.route.route).toBe("/api/hello");
    expect(matchFunction(routes, "/api/users/42")).toEqual({ route: routes[1], params: { id: "42" } });
    expect(matchFunction(routes, "/api/users/me")?.route.route).toBe("/api/users/me");
    expect(matchFunction(routes, "/api")?.route.route).toBe("/api");
    expect(matchFunction(routes, "/api/nope")).toBeNull();
  });
});

// ---------------------------------------------------------------- full edge

function writeArtifact(root: string, id: string, manifest: Partial<DeploymentManifest>, files: Record<string, string>): void {
  const dir = path.join(root, id);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const full: DeploymentManifest = {
    version: 1,
    deploymentId: id,
    projectId: "prj",
    framework: "vite",
    spa: false,
    cleanUrls: true,
    functions: [],
    fileCount: 0,
    totalBytes: 0,
    createdAt: 0,
    ...manifest,
  };
  fs.writeFileSync(path.join(dir, "orbit.json"), JSON.stringify(full));
}

describe("edge handler", () => {
  let tmp: string;
  let server: http.Server;
  let port: number;
  const targets = new Map<string, ResolvedTarget>();

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-edge-test-"));
    writeArtifact(
      tmp,
      "dpl-spa0000001",
      { spa: true, cleanUrls: false },
      {
        "static/index.html": "<h1>spa</h1>",
        "static/assets/index-BbW3z1aQ.js": `console.log(${JSON.stringify("x".repeat(5000))})`,
      },
    );
    writeArtifact(
      tmp,
      "dpl-site000001",
      { spa: false, cleanUrls: true },
      {
        "static/index.html": "<h1>home</h1>",
        "static/about.html": "<h1>about</h1>",
        "static/docs/index.html": "<h1>docs</h1>",
        "static/404.html": "<h1>custom 404</h1>",
        "static/logo.svg": "<svg/>",
      },
    );
    writeArtifact(
      tmp,
      "dpl-fn00000001",
      {
        spa: true,
        functions: [
          { route: "/api/echo", file: "functions/echo.mjs" },
          { route: "/api/slow", file: "functions/slow.mjs" },
          { route: "/api/cached", file: "functions/cached.mjs" },
          { route: "/api/fresh", file: "functions/fresh.mjs" },
        ],
      },
      {
        "static/index.html": "<h1>fn</h1>",
        "functions/echo.mjs": `export async function POST(req) { return Response.json({ got: await req.json(), env: process.env.GREETING }); }`,
        "functions/slow.mjs": `export default () => new Promise((resolve) => setTimeout(resolve, 60_000));`,
        "functions/cached.mjs": `export function GET(req) { return new Response(String(Math.random()), { headers: { "cache-control": "public, s-maxage=60" } }); }`,
        "functions/fresh.mjs": `export function GET() { return new Response(String(Math.random()), { headers: { "cache-control": "public, max-age=60" } }); }`,
        "function-env.json": JSON.stringify({ GREETING: "hi" }),
      },
    );
    targets.set("dpl-spa0000001", { deploymentId: "dpl-spa0000001", status: "ready" });
    targets.set("dpl-site000001", { deploymentId: "dpl-site000001", status: "ready" });
    targets.set("dpl-fn00000001", { deploymentId: "dpl-fn00000001", status: "ready" });
    targets.set("my-app", { deploymentId: "dpl-site000001", status: "ready" });
    targets.set("dpl-building01", { deploymentId: "dpl-building01", status: "building" });
    targets.set("dpl-failed0001", { deploymentId: "dpl-failed0001", status: "error" });

    const handle = createEdgeHandler({
      rootDomain: "localhost",
      artifactsDir: tmp,
      lookup: { resolve: (label) => targets.get(label) ?? null },
      functionTimeoutMs: 1500,
      functionMemoryMb: 64,
      functionCacheBytes: 1024 * 1024,
      functionWarm: { maxIdlePerFunction: 1, maxIdle: 4, idleTimeoutMs: 60_000 },
    });
    server = http.createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function request(
    host: string,
    urlPath: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: urlPath, method: init.method ?? "GET", headers: { host, ...init.headers } },
        (res) => {
          let body = "";
          res
            .setEncoding("utf8")
            .on("data", (c) => (body += c))
            .on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end(init.body);
    });
  }

  it("routes by Host header: deployment id and alias", async () => {
    expect((await request("dpl-site000001.localhost:8080", "/")).body).toBe("<h1>home</h1>");
    const viaAlias = await request("my-app.localhost:8080", "/");
    expect(viaAlias.body).toBe("<h1>home</h1>");
    expect(viaAlias.headers["x-orbit-deployment"]).toBe("dpl-site000001");
  });

  it("serves clean URLs and directory indexes", async () => {
    expect((await request("my-app.localhost", "/about")).body).toBe("<h1>about</h1>");
    expect((await request("my-app.localhost", "/docs/")).body).toBe("<h1>docs</h1>");
    expect((await request("my-app.localhost", "/docs")).body).toBe("<h1>docs</h1>");
  });

  it("sets content types", async () => {
    expect((await request("my-app.localhost", "/logo.svg")).headers["content-type"]).toBe("image/svg+xml");
    expect((await request("my-app.localhost", "/")).headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("uses the site's own 404.html with a 404 status", async () => {
    const res = await request("my-app.localhost", "/missing");
    expect(res.status).toBe(404);
    expect(res.body).toBe("<h1>custom 404</h1>");
  });

  it("falls back to index.html for SPA navigations but not for missing assets", async () => {
    const nav = await request("dpl-spa0000001.localhost", "/dashboard/settings", { headers: { accept: "text/html" } });
    expect(nav.status).toBe(200);
    expect(nav.body).toBe("<h1>spa</h1>");
    const asset = await request("dpl-spa0000001.localhost", "/assets/missing-AbC12345.js");
    expect(asset.status).toBe(404);
  });

  it("caches hashed assets forever, gzips them and answers conditional requests", async () => {
    const res = await request("dpl-spa0000001.localhost", "/assets/index-BbW3z1aQ.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["content-encoding"]).toBe("gzip");
    const again = await request("dpl-spa0000001.localhost", "/assets/index-BbW3z1aQ.js", {
      headers: { "accept-encoding": "gzip", "if-none-match": String(res.headers.etag) },
    });
    expect(again.status).toBe(304);
  });

  it("blocks path traversal", async () => {
    expect((await request("my-app.localhost", "/..%2f..%2forbit.json")).status).toBe(404);
    expect((await request("my-app.localhost", "/%2e%2e/orbit.json")).body).not.toContain("deploymentId");
  });

  it("renders platform pages for unknown, building and failed deployments", async () => {
    expect((await request("nope.localhost", "/")).status).toBe(404);
    expect((await request("localhost:8080", "/")).status).toBe(404);
    const building = await request("dpl-building01.localhost", "/");
    expect(building.status).toBe(503);
    expect(building.body).toContain("DEPLOYMENT_BUILDING");
    expect((await request("dpl-failed0001.localhost", "/")).status).toBe(502);
  });

  it("rejects non-GET methods on static files", async () => {
    expect((await request("my-app.localhost", "/", { method: "POST" })).status).toBe(405);
  });

  it("invokes functions in an isolated process with the deployment's env", async () => {
    const res = await request("dpl-fn00000001.localhost", "/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ got: { a: 1 }, env: "hi" });
    expect(res.headers["x-orbit-function"]).toBe("/api/echo");
  });

  it("returns 405 for unsupported methods, 404 for unknown API routes and 504 on timeout", async () => {
    expect((await request("dpl-fn00000001.localhost", "/api/echo")).status).toBe(405);
    expect((await request("dpl-fn00000001.localhost", "/api/echo")).headers["x-orbit-cache"]).toBe("MISS");
    expect((await request("dpl-fn00000001.localhost", "/api/unknown")).status).toBe(404);
    const slow = await request("dpl-fn00000001.localhost", "/api/slow");
    expect(slow.status).toBe(504);
    expect(slow.body).toContain("FUNCTION_INVOCATION_TIMEOUT");
  });

  it("caches function responses that send s-maxage, per URL, like Vercel's CDN", async () => {
    const host = "dpl-fn00000001.localhost";
    const [first, second] = await Promise.all([request(host, "/api/cached?a=1"), request(host, "/api/cached?a=1")]);
    expect(first.body).toBe(second.body); // concurrent misses share one invocation
    const hit = await request(host, "/api/cached?a=1");
    expect(hit.body).toBe(first.body);
    expect(hit.headers["x-orbit-cache"]).toBe("HIT");
    expect(hit.headers["age"]).toBe("0");
    expect((await request(host, "/api/cached?a=2")).body).not.toBe(first.body);
    // HEAD is answered from the same entry.
    expect((await request(host, "/api/cached?a=1", { method: "HEAD" })).headers["x-orbit-cache"]).toBe("HIT");
    // Authorized requests always run the function.
    const authed = await request(host, "/api/cached?a=1", { headers: { authorization: "Bearer x" } });
    expect(authed.body).not.toBe(first.body);
    expect(authed.headers["x-orbit-cache"]).toBeUndefined();
    expect(authed.headers["x-orbit-instance"]).toBe("warm");
    // Plain max-age is for browsers: not cached at the edge.
    const fresh = [await request(host, "/api/fresh"), await request(host, "/api/fresh")];
    expect(fresh[0]!.body).not.toBe(fresh[1]!.body);
    expect(fresh[1]!.headers["x-orbit-cache"]).toBe("MISS");
  });

  it("resolveStatic never escapes the static dir", () => {
    const dir = path.join(tmp, "dpl-site000001", "static");
    const r = resolveStatic(dir, "/../orbit.json", { spa: false, cleanUrls: true, isNavigation: false });
    // "/../orbit.json" normalizes to "/orbit.json" inside static/, which doesn't exist -> site 404.
    expect(r).toMatchObject({ kind: "file", relPath: "/404.html", status: 404 });
  });
});

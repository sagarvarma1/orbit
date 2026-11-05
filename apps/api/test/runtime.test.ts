import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FunctionCrashError, FunctionPool, invokeFunction } from "../src/edge/functions.js";
import type { FunctionRoute } from "../src/lib/manifest.js";

let dir: string;
const write = (rel: string, content: string) => {
  const file = path.join(dir, "functions", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

function call(
  route: FunctionRoute,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; params?: Record<string, string> } = {},
) {
  return invokeFunction({
    artifactDir: dir,
    route,
    params: init.params ?? {},
    request: {
      method: init.method ?? "GET",
      url: `https://app.example.com${url}`,
      headers: init.headers ?? {},
      body: Buffer.from(init.body ?? ""),
    },
    env: { GREETING: "hi" },
    timeoutMs: 10_000,
    memoryMb: 128,
  });
}

const json = (res: { body: Buffer }) => JSON.parse(res.body.toString("utf8"));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-rt-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Node.js runtime (Vercel helpers)", () => {
  const node = (name: string): FunctionRoute => ({ route: `/api/${name}`, file: `functions/api/${name}.mjs`, runtime: "node" });

  beforeAll(() => {
    write(
      "api/helpers.mjs",
      `import http from "node:http";
       export default function handler(req, res) {
         res.status(201).json({
           query: req.query,
           cookies: req.cookies,
           body: req.body,
           method: req.method,
           url: req.url,
           incoming: req instanceof http.IncomingMessage,
           env: process.env.GREETING,
         });
       }`,
    );
    write(
      "api/send.mjs",
      `export default function handler(req, res) {
         const kind = req.query.kind;
         if (kind === "buffer") return res.send(Buffer.from([1, 2, 3]));
         if (kind === "text") return res.send("<b>hi</b>");
         if (kind === "redirect") return res.redirect("/elsewhere");
         if (kind === "redirect301") return res.redirect(301, "/moved");
         if (kind === "stream") { req.on("data", (c) => res.write(c)); req.on("end", () => res.end("!")); return; }
         res.send({ ok: true });
       }`,
    );
    write(
      "api/web.mjs",
      `export async function POST(request) {
         const headers = new Headers({ "content-type": "text/plain" });
         headers.append("set-cookie", "a=1; Path=/");
         headers.append("set-cookie", "b=2; Path=/");
         return new Response("got " + (await request.text()) + " at " + new URL(request.url).pathname, { headers });
       }`,
    );
    write(
      "api/later.mjs",
      `let done = [];
       export function GET() {
         const ctx = globalThis[Symbol.for("@vercel/request-context")].get();
         ctx.waitUntil(new Promise((r) => setTimeout(() => { done.push(Date.now()); r(); }, 50)));
         return Response.json({ before: done.length });
       }`,
    );
    write("api/crash.mjs", `export default function handler() { throw new Error("kaboom"); }`);
  });

  it("gives Node.js handlers req.query, req.cookies, req.body and res helpers", async () => {
    const res = await call(node("helpers"), "/api/helpers/42?tag=a&tag=b", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=abc; theme=dark%20mode" },
      body: JSON.stringify({ hello: "world" }),
      params: { id: "42" },
    });
    expect(res.status).toBe(201);
    expect(json(res)).toEqual({
      query: { tag: ["a", "b"], id: "42" },
      cookies: { session: "abc", theme: "dark mode" },
      body: { hello: "world" },
      method: "POST",
      url: "/api/helpers/42?tag=a&tag=b",
      incoming: true,
      env: "hi",
    });
  });

  it("parses form bodies and rejects invalid JSON with 400, like Vercel", async () => {
    const form = await call(node("helpers"), "/api/helpers", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1&b=two",
    });
    expect(json(form).body).toEqual({ a: "1", b: "two" });
    const bad = await call(node("helpers"), "/api/helpers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.toString()).toBe("Invalid JSON");
  });

  it("implements res.send, res.redirect and streaming request bodies", async () => {
    const buffer = await call(node("send"), "/api/send?kind=buffer");
    expect(buffer.headers["content-type"]).toBe("application/octet-stream");
    expect([...buffer.body]).toEqual([1, 2, 3]);
    const text = await call(node("send"), "/api/send?kind=text");
    expect(text.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(json(await call(node("send"), "/api/send"))).toEqual({ ok: true });
    const redirect = await call(node("send"), "/api/send?kind=redirect");
    expect([redirect.status, redirect.headers.location]).toEqual([307, "/elsewhere"]);
    const moved = await call(node("send"), "/api/send?kind=redirect301");
    expect([moved.status, moved.headers.location]).toEqual([301, "/moved"]);
    const echo = await call(node("send"), "/api/send?kind=stream", { method: "POST", body: "abc" });
    expect(echo.body.toString()).toBe("abc!");
  });

  it("runs Web handlers per method, keeping every Set-Cookie", async () => {
    const res = await call(node("web"), "/api/web", { method: "POST", body: "data" });
    expect(res.body.toString()).toBe("got data at /api/web");
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const get = await call(node("web"), "/api/web");
    expect([get.status, get.headers.allow]).toEqual([405, "POST"]);
  });

  it("supports waitUntil from @vercel/functions: work continues after the response", async () => {
    const pool = new FunctionPool({ maxIdlePerFunction: 1, maxIdle: 1, idleTimeoutMs: 10_000 });
    const opts = {
      artifactDir: dir,
      route: node("later"),
      params: {},
      request: { method: "GET", url: "https://x/api/later", headers: {}, body: Buffer.alloc(0) },
      env: {},
      timeoutMs: 5000,
      memoryMb: 128,
    };
    expect(json(await pool.invoke(opts)).before).toBe(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(json(await pool.invoke(opts)).before).toBe(1);
    pool.close();
  });

  it("reports uncaught errors as crashes", async () => {
    await expect(call(node("crash"), "/api/crash")).rejects.toThrow(FunctionCrashError);
    await expect(call(node("crash"), "/api/crash")).rejects.toThrow(/kaboom/);
  });
});

describe("Python runtime", () => {
  const py = (name: string, route = `/api/${name}`): FunctionRoute => ({
    route,
    file: `functions/api/${name}.py`,
    runtime: "python",
  });

  beforeAll(() => {
    write("api/_shared.py", `GREETING = "from a sibling module"\n`);
    write(
      "api/handler.py",
      `import json, os
from http.server import BaseHTTPRequestHandler
from _shared import GREETING
from api._shared import GREETING as G2

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"path": self.path, "greeting": GREETING, "g2": G2, "env": os.environ.get("GREETING")}).encode())

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"posted " + body)
`,
    );
    write(
      "api/wsgi.py",
      `def app(environ, start_response):
    body = environ["wsgi.input"].read(int(environ.get("CONTENT_LENGTH") or 0))
    out = f'{environ["REQUEST_METHOD"]} {environ["PATH_INFO"]}?{environ["QUERY_STRING"]} {environ.get("HTTP_X_TEST")} {body.decode()}'.encode()
    start_response("202 Accepted", [("Content-Type", "text/plain"), ("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")])
    return [out]
`,
    );
    write(
      "api/asgi.py",
      `started = []

async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        message = await receive()
        started.append(True)
        await send({"type": "lifespan.startup.complete"})
        return
    request = await receive()
    body = f'{scope["method"]} {scope["path"]} {scope["query_string"].decode()} {request["body"].decode()} started={len(started)}'.encode()
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": body[:5], "more_body": True})
    await send({"type": "http.response.body", "body": body[5:]})
`,
    );
    write(
      "api/[id].py",
      `def app(environ, start_response):
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [environ["QUERY_STRING"].encode()]
`,
    );
    write("api/broken.py", `import does_not_exist\n`);
    write(
      "api/raises.py",
      `def app(environ, start_response):
    raise ValueError("bad python")
`,
    );
  });

  it("serves BaseHTTPRequestHandler classes, with imports from the project and env", async () => {
    const res = await call(py("handler"), "/api/handler?x=1");
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({
      path: "/api/handler?x=1",
      greeting: "from a sibling module",
      g2: "from a sibling module",
      env: "hi",
    });
    const post = await call(py("handler"), "/api/handler", { method: "POST", body: "data" });
    expect(post.body.toString()).toBe("posted data");
  });

  it("serves WSGI apps", async () => {
    const res = await call(py("wsgi"), "/api/wsgi?q=1", { method: "PUT", headers: { "x-test": "yes" }, body: "b" });
    expect(res.status).toBe(202);
    expect(res.body.toString()).toBe("PUT /api/wsgi?q=1 yes b");
    expect(res.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });

  it("serves ASGI apps, running lifespan startup once", async () => {
    const res = await call(py("asgi"), "/api/asgi?z=9", { method: "POST", body: "hello" });
    expect(res.body.toString()).toBe("POST /api/asgi z=9 hello started=1");
  });

  it("passes dynamic segments in the query string", async () => {
    const res = await call(py("[id]", "/api/[id]"), "/api/42?a=b", { params: { id: "42" } });
    expect(res.body.toString()).toBe("a=b&id=42");
  });

  it("reports import errors and exceptions as crashes", async () => {
    await expect(call(py("broken"), "/api/broken")).rejects.toThrow(/does_not_exist/);
    await expect(call(py("raises"), "/api/raises")).rejects.toThrow(/bad python/);
  });
});

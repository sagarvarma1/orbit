// Orbit's Node.js function runtime, modeled on Vercel's: one process (or sandbox container) per
// function instance, serving one request at a time over HTTP on a unix socket. The module is
// loaded at startup (the cold start), and module-level state survives between requests while the
// instance stays warm.
//
//   node function-runner.mjs <bundle.mjs> <socket>
//
// Handlers, as on Vercel:
//   export default function handler(req, res)   Node.js signature, with Vercel's helpers
//   export function GET(request) / POST / ...     Web signature, one export per method
//   export default { fetch(request) }             Web signature
// `waitUntil` from @vercel/functions works: the work runs on after the response is sent.
//
// The edge adds x-orbit-params (dynamic route segments, JSON) and strips any the client sent.
// An uncaught error is answered with a 500 carrying x-orbit-error, then the instance exits, so a
// half-initialized module is never reused (Vercel recycles crashed instances the same way).
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const [file, socketPath] = process.argv.slice(2);
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const INTERNAL_HEADERS = ["x-orbit-params"];

// ------------------------------------------------------------ request context

/**
 * `waitUntil` from @vercel/functions reads this global. Work passed to it keeps running after
 * the response is sent; the instance takes no new request until it settles.
 */
const CONTEXT = Symbol.for("@vercel/request-context");
let current = null;
globalThis[CONTEXT] = { get: () => current };

// ------------------------------------------------------------------ helpers

function parseQuery(search) {
  const query = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (key in query) query[key] = [].concat(query[key], value);
    else query[key] = value;
  }
  return query;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key || key in cookies) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

class BodyError extends Error {}

/** Vercel's req.body: parsed by content type, on first access. */
function parseBody(raw, contentType) {
  if (!contentType) return undefined;
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "application/json") {
    if (raw.length === 0) return undefined;
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw new BodyError("Invalid JSON");
    }
  }
  if (type === "application/x-www-form-urlencoded") return parseQuery(raw.toString("utf8"));
  if (type === "application/octet-stream") return raw;
  if (type.startsWith("text/")) return raw.toString("utf8");
  return raw;
}

/** A real IncomingMessage carrying the buffered body, so frameworks (Express) see what they expect. */
function nodeRequest(incoming, raw, url, params) {
  const req = new http.IncomingMessage(new net.Socket());
  req.method = incoming.method;
  req.url = url.pathname + url.search;
  req.headers = incoming.headers;
  req.rawHeaders = incoming.rawHeaders;
  req.httpVersion = incoming.httpVersion;
  req.httpVersionMajor = incoming.httpVersionMajor;
  req.httpVersionMinor = incoming.httpVersionMinor;
  if (raw.length) req.push(raw);
  req.push(null);

  // Dynamic route segments appear in the query, as on Vercel.
  const query = { ...parseQuery(url.search), ...params };
  let cookies;
  let body;
  let parsed = false;
  Object.defineProperties(req, {
    query: { value: query, writable: true, enumerable: true, configurable: true },
    cookies: {
      get: () => (cookies ??= parseCookies(req.headers.cookie)),
      set: (v) => (cookies = v),
      enumerable: true,
      configurable: true,
    },
    body: {
      get() {
        if (!parsed) {
          body = parseBody(raw, req.headers["content-type"]);
          parsed = true;
        }
        return body;
      },
      set(v) {
        body = v;
        parsed = true;
      },
      enumerable: true,
      configurable: true,
    },
  });
  return req;
}

/** Vercel's response helpers on the real ServerResponse. */
function addResponseHelpers(res) {
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };
  res.send = function (data) {
    if (data === null || data === undefined) return this.end();
    if (Buffer.isBuffer(data)) {
      if (!this.hasHeader("content-type")) this.setHeader("content-type", "application/octet-stream");
      this.setHeader("content-length", data.length);
      return this.end(data);
    }
    if (typeof data === "object") return this.json(data);
    const text = String(data);
    if (!this.hasHeader("content-type")) this.setHeader("content-type", "text/html; charset=utf-8");
    this.setHeader("content-length", Buffer.byteLength(text));
    return this.end(text);
  };
  res.json = function (data) {
    if (!this.hasHeader("content-type")) this.setHeader("content-type", "application/json; charset=utf-8");
    const text = JSON.stringify(data);
    this.setHeader("content-length", Buffer.byteLength(text));
    return this.end(text);
  };
  res.redirect = function (statusOrUrl, url) {
    const [status, location] = typeof statusOrUrl === "number" ? [statusOrUrl, url] : [307, statusOrUrl];
    this.writeHead(status, { location }).end();
    return this;
  };
  return res;
}

function webRequest(incoming, raw, url) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const v of [].concat(value)) headers.append(key, v);
  }
  const init = { method: incoming.method, headers };
  if (incoming.method !== "GET" && incoming.method !== "HEAD" && raw.length) init.body = raw;
  return new Request(url, init);
}

function toResponse(result) {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new Response(null, { status: 204 });
  if (typeof result === "string") return new Response(result, { headers: { "content-type": "text/plain; charset=utf-8" } });
  return Response.json(result);
}

async function sendWebResponse(response, res, method) {
  const headers = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body || method === "HEAD") return void res.end();
  await new Promise((resolve, reject) => {
    Readable.fromWeb(response.body).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
  });
}

// --------------------------------------------------------------------- serve

let mod;
try {
  mod = await import(pathToFileURL(file).href);
} catch (err) {
  console.error(err?.stack ?? String(err));
  process.exit(1);
}

let fn = mod.default;
if (fn && typeof fn === "object" && typeof fn.fetch === "function") fn = fn.fetch.bind(fn);

const background = new Set();

async function handle(incoming, res) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const raw = Buffer.concat(chunks);

  let params = {};
  try {
    params = JSON.parse(incoming.headers["x-orbit-params"] ?? "{}");
  } catch {
    // ignore
  }
  for (const h of INTERNAL_HEADERS) delete incoming.headers[h];
  const proto = incoming.headers["x-forwarded-proto"] ?? "https";
  const host = incoming.headers["x-forwarded-host"] ?? incoming.headers.host ?? "localhost";
  const url = new URL(incoming.url, `${proto}://${host}`);
  const method = incoming.method.toUpperCase();

  current = {
    waitUntil: (promise) => background.add(Promise.resolve(promise).catch((err) => console.error(err))),
    headers: Object.fromEntries(Object.entries(incoming.headers).map(([k, v]) => [k, String(v)])),
    url: url.toString(),
  };

  const handler = typeof mod[method] === "function" ? mod[method] : fn;
  if (typeof handler !== "function") {
    const allowed = METHODS.filter((m) => typeof mod[m] === "function");
    res.writeHead(allowed.length ? 405 : 500, allowed.length ? { allow: allowed.join(", ") } : {});
    return void res.end(allowed.length ? "Method Not Allowed" : "Function has no default export or HTTP method exports");
  }

  // A default export with (req, res) uses the Node.js signature; anything else is a Web handler.
  if (handler === fn && handler.length >= 2) {
    const req = nodeRequest(incoming, raw, url, params);
    addResponseHelpers(res);
    const done = new Promise((resolve) => res.on("finish", resolve).on("close", resolve));
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof BodyError) return void res.writeHead(400).end(err.message);
      throw err;
    }
    await done;
  } else {
    await sendWebResponse(toResponse(await handler(webRequest(incoming, raw, url), { params })), res, method);
  }
}

function fail(res, err) {
  console.error(err?.stack ?? String(err));
  const message = Buffer.from(String(err?.message ?? err)).toString("base64");
  if (!res.headersSent) res.writeHead(500, { "x-orbit-error": message, connection: "close" });
  res.end(() => process.exit(1));
  setTimeout(() => process.exit(1), 1000).unref();
}

const server = http.createServer({ keepAlive: false }, (incoming, res) => {
  handle(incoming, res)
    .catch((err) => fail(res, err))
    .finally(() => {
      current = null;
      // waitUntil work keeps running after the response, like a Vercel instance that stays alive.
      for (const p of background) void p.finally(() => background.delete(p));
    });
});
server.listen(socketPath);

process.on("uncaughtException", (err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));

// Orbit function runner. Runs ONE invocation in a fresh, permission-restricted Node process:
// read-only access to the function bundle, no child processes, no fs writes, capped heap.
// Protocol (IPC): parent sends { file, request, params }, we reply with a serialized Response.
import { pathToFileURL } from "node:url";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

async function serialize(response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers, body: body.toString("base64") };
}

function toResponse(result) {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new Response(null, { status: 204 });
  if (typeof result === "string") return new Response(result, { headers: { "content-type": "text/plain; charset=utf-8" } });
  return Response.json(result);
}

/** Minimal Vercel/Express-style (req, res) shim for Node-style handlers. */
function runNodeStyle(handler, request, body, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const contentType = request.headers["content-type"] ?? "";
    let parsedBody = body.length ? body.toString("utf8") : undefined;
    if (parsedBody && contentType.includes("application/json")) {
      try {
        parsedBody = JSON.parse(parsedBody);
      } catch {
        /* leave as string */
      }
    }
    const req = {
      method: request.method,
      url: url.pathname + url.search,
      headers: request.headers,
      query: { ...Object.fromEntries(url.searchParams), ...params },
      body: parsedBody,
    };
    const headers = new Headers();
    // Handlers set the status either with res.status(code) or by assigning res.statusCode.
    const finish = (payload) => resolve(new Response(payload ?? null, { status: res.statusCode, headers }));
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(key, value) {
        headers.set(key, String(value));
        return this;
      },
      getHeader: (key) => headers.get(key),
      json(data) {
        if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
        finish(JSON.stringify(data));
      },
      send(data) {
        if (typeof data === "object" && data !== null && !Buffer.isBuffer(data)) return this.json(data);
        if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
        finish(data);
      },
      end: (data) => finish(data),
      redirect(codeOrUrl, maybeUrl) {
        res.statusCode = typeof codeOrUrl === "number" ? codeOrUrl : 307;
        headers.set("location", typeof codeOrUrl === "number" ? maybeUrl : codeOrUrl);
        finish(null);
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

process.once("message", async ({ file, request, params }) => {
  try {
    const mod = await import(pathToFileURL(file).href);
    const method = request.method.toUpperCase();
    let handler = mod[method] ?? mod.default;
    if (handler && typeof handler === "object" && typeof handler.fetch === "function") handler = handler.fetch.bind(handler);

    let response;
    if (typeof handler !== "function") {
      const allowed = METHODS.filter((m) => typeof mod[m] === "function");
      response = allowed.length
        ? new Response("Method Not Allowed", { status: 405, headers: { allow: allowed.join(", ") } })
        : new Response("Function has no default export or HTTP method exports", { status: 500 });
    } else {
      const body = Buffer.from(request.body, "base64");
      if (handler.length >= 2) {
        response = await runNodeStyle(handler, request, body, params);
      } else {
        const init = { method, headers: request.headers };
        if (method !== "GET" && method !== "HEAD" && body.length) init.body = body;
        response = toResponse(await handler(new Request(request.url, init), { params }));
      }
    }
    process.send({ type: "response", response: await serialize(response) }, () => process.exit(0));
  } catch (err) {
    process.send({ type: "error", message: err?.message ?? String(err), stack: err?.stack }, () => process.exit(1));
  }
});

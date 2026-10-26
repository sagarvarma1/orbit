import fs from "node:fs";
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { DeploymentStatus } from "../db/repo.js";
import {
  FUNCTION_ENV_FILE,
  MANIFEST_FILE,
  RUNTIME_DIR,
  SERVER_DIR,
  STATIC_DIR,
  type DeploymentManifest,
} from "../lib/manifest.js";
import { compileRouting, type CompiledRouting } from "../lib/routing.js";
import { prepareArtifact, SANDBOX_UID_BASE, type SandboxIdentity, sandboxIdentity } from "../lib/sandbox.js";
import { FunctionCache } from "./function-cache.js";
import { FunctionPool, FunctionTimeoutError, matchFunction } from "./functions.js";
import { platformPage } from "./pages.js";
import { ServerPool, type ServerPoolOptions } from "./servers.js";
import {
  cacheControl,
  contentType,
  etag,
  isCompressible,
  isNavigationRequest,
  type Resolution,
  resolveStatic,
} from "./static.js";

export interface ResolvedTarget {
  deploymentId: string;
  status: DeploymentStatus;
}

/** How the edge finds out what a hostname points at. Backed by SQLite in production, a Map in tests. */
export interface TargetLookup {
  resolve(label: string): ResolvedTarget | null;
  /** Custom domains (anything not under the root domain). */
  resolveDomain?(hostname: string): ResolvedTarget | null;
  /** Whether a hostname is a custom domain of some project, deployed or not. */
  isDomain?(hostname: string): boolean;
  /** The project's sandbox number, so its code runs as its own OS user (see lib/sandbox.ts). */
  sandboxId?(deploymentId: string): number | null;
}

export interface EdgeOptions {
  rootDomain: string;
  artifactsDir: string;
  lookup: TargetLookup;
  functionTimeoutMs: number;
  functionMemoryMb: number;
  /** Warm function instances; omitted = a fresh process per request. */
  functionWarm?: { maxIdlePerFunction: number; maxIdle: number; idleTimeoutMs: number };
  /** Next.js servers (SSR deployments). */
  servers?: Omit<ServerPoolOptions, "log">;
  /** Writable per-deployment state; defaults to <artifactsDir>/../runtime, matching the build. */
  runtimeDir?: string;
  /** Memory for cached function responses (`s-maxage`); 0 turns the cache off. */
  functionCacheBytes?: number;
  /** Max request body for functions (Vercel's limit is 4.5 MB). */
  maxBodyBytes?: number;
  log?: (message: string) => void;
}

/** "Example.com.:443" -> "example.com". */
export function hostnameFromHost(host: string | undefined): string {
  return (host ?? "").replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
}

/** "abc.localhost:8080" -> "abc". Only single labels directly under the root domain route. */
export function labelFromHost(host: string | undefined, rootDomain: string): string | null {
  if (!host) return null;
  const hostname = hostnameFromHost(host);
  const suffix = `.${rootDomain}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) ? label : null;
}

const MANIFEST_CACHE_LIMIT = 500;

const isApi = (urlPath: string) => urlPath === "/api" || urlPath.startsWith("/api/");

interface LoadedDeployment {
  manifest: DeploymentManifest;
  /** Compiled vercel.json rules, or null if the deployment has none. */
  routing: CompiledRouting | null;
}

/**
 * The edge request handler. Stateless apart from a manifest cache and a function response cache,
 * both safe because artifacts are immutable: a deployment id's output can never change.
 */
export function createEdgeHandler(opts: EdgeOptions) {
  const functionCache = opts.functionCacheBytes ? new FunctionCache(opts.functionCacheBytes) : null;
  const functionPool = new FunctionPool(opts.functionWarm ?? { maxIdlePerFunction: 0, maxIdle: 0, idleTimeoutMs: 0 });
  const serverPool = new ServerPool({
    ...(opts.servers ?? { maxServers: 3, idleTimeoutMs: 10 * 60_000, memoryMb: 512 }),
    log: opts.log,
  });
  const runtimeDir = opts.runtimeDir ?? path.join(path.dirname(opts.artifactsDir), RUNTIME_DIR);
  const deployments = new Map<string, LoadedDeployment>();
  const maxBody = opts.maxBodyBytes ?? 4.5 * 1024 * 1024;
  /** For www.<domain> where <domain> is a custom domain and www itself isn't one: the apex. */
  function wwwRedirectTarget(hostname: string): string | null {
    if (!hostname.startsWith("www.") || !opts.lookup.isDomain) return null;
    const apex = hostname.slice(4);
    return opts.lookup.isDomain(apex) && !opts.lookup.isDomain(hostname) ? apex : null;
  }

  /** Deployments whose files have been handed to their sandbox user, by deployment id. */
  const sandboxes = new Map<string, SandboxIdentity | null>();

  /** The OS user a deployment's code runs as (null: same user as the edge, permission model only). */
  function sandboxFor(deploymentId: string): SandboxIdentity | null {
    if (sandboxes.has(deploymentId)) return sandboxes.get(deploymentId)!;
    const n = opts.lookup.sandboxId?.(deploymentId);
    const identity = sandboxIdentity(n ? SANDBOX_UID_BASE + n : null);
    if (identity) prepareArtifact(path.join(opts.artifactsDir, deploymentId), identity);
    if (sandboxes.size >= MANIFEST_CACHE_LIMIT) sandboxes.delete(sandboxes.keys().next().value!);
    sandboxes.set(deploymentId, identity);
    return identity;
  }

  /** Headers from the deployment's vercel.json, merged into whatever response the request ends with. */
  const customHeaders = new WeakMap<ServerResponse, Record<string, string>>();

  function loadDeployment(id: string): LoadedDeployment | null {
    const cached = deployments.get(id);
    if (cached) return cached;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(opts.artifactsDir, id, MANIFEST_FILE), "utf8")) as DeploymentManifest;
      const loaded = { manifest, routing: manifest.routing ? compileRouting(manifest.routing) : null };
      if (deployments.size >= MANIFEST_CACHE_LIMIT) deployments.delete(deployments.keys().next().value!);
      deployments.set(id, loaded);
      return loaded;
    } catch {
      return null;
    }
  }

  function writeHead(res: ServerResponse, status: number, headers: OutgoingHttpHeaders): void {
    res.writeHead(status, { ...headers, ...customHeaders.get(res) });
  }

  function sendPage(
    res: ServerResponse,
    method: string,
    page: Parameters<typeof platformPage>[0],
    extra: Record<string, string> = {},
  ) {
    const body = platformPage(page);
    writeHead(res, page.status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
      ...extra,
    });
    res.end(method === "HEAD" ? undefined : body);
  }

  async function serveFunction(
    req: IncomingMessage,
    res: ServerResponse,
    manifest: DeploymentManifest,
    urlPath: string,
    url: URL,
  ) {
    const match = matchFunction(manifest.functions, urlPath);
    if (!match) return false;

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBody) {
        sendPage(res, req.method!, { status: 413, code: "FUNCTION_PAYLOAD_TOO_LARGE", title: "Request body too large" });
        return true;
      }
      chunks.push(chunk);
    }

    const artifactDir = path.join(opts.artifactsDir, manifest.deploymentId);
    const env = readEnv(artifactDir);
    const sandbox = sandboxFor(manifest.deploymentId);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers))
      if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;

    const started = Date.now();
    let warm: boolean | null = null;
    const invoke = async (method: string) => {
      const result = await functionPool.invoke({
        artifactDir,
        route: match.route,
        params: match.params,
        request: { method, url: url.toString(), headers, body: Buffer.concat(chunks) },
        env,
        sandbox,
        timeoutMs: match.route.maxDurationMs ?? opts.functionTimeoutMs,
        memoryMb: match.route.memoryMb ?? opts.functionMemoryMb,
        onLog: (stream, text) => opts.log?.(`[fn ${manifest.deploymentId}${match.route.route}] ${stream}: ${text.trimEnd()}`),
      });
      warm = result.warm;
      return result;
    };
    // GET and HEAD share one entry (HEAD drops the body). Authorized requests are never shared.
    const cacheable = functionCache && (req.method === "GET" || req.method === "HEAD") && !req.headers.authorization;
    try {
      const {
        response: out,
        hit,
        age,
      } = cacheable
        ? await functionCache.fetch(`${manifest.deploymentId} ${url.host}${url.pathname}${url.search}`, () => invoke("GET"))
        : { response: await invoke(req.method!), hit: false, age: 0 };
      const responseHeaders: Record<string, string> = { "cache-control": "no-store", ...out.headers };
      delete responseHeaders["content-encoding"];
      delete responseHeaders["transfer-encoding"];
      responseHeaders["content-length"] = String(out.body.length);
      responseHeaders["x-orbit-deployment"] = manifest.deploymentId;
      responseHeaders["x-orbit-function"] = match.route.route;
      responseHeaders["x-orbit-duration"] = `${Date.now() - started}ms`;
      if (cacheable) responseHeaders["x-orbit-cache"] = hit ? "HIT" : "MISS";
      if (hit) responseHeaders["age"] = String(age);
      if (warm !== null) responseHeaders["x-orbit-instance"] = warm ? "warm" : "cold";
      writeHead(res, out.status, responseHeaders);
      res.end(req.method === "HEAD" ? undefined : out.body);
    } catch (err) {
      const timeout = err instanceof FunctionTimeoutError;
      opts.log?.(`[fn ${manifest.deploymentId}${match.route.route}] ${(err as Error).message}`);
      sendPage(
        res,
        req.method!,
        {
          status: timeout ? 504 : 500,
          code: timeout ? "FUNCTION_INVOCATION_TIMEOUT" : "FUNCTION_INVOCATION_FAILED",
          title: timeout ? "The function timed out" : "The function crashed",
          detail: (err as Error).message,
        },
        { "x-orbit-deployment": manifest.deploymentId },
      );
    }
    return true;
  }

  /** Env vars snapshotted at build time for this deployment's functions and server. */
  function readEnv(artifactDir: string): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(path.join(artifactDir, FUNCTION_ENV_FILE), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /**
   * Forwards the request to the deployment's own app server (started on demand) and streams the
   * response back, so streaming SSR and React Server Components arrive as they render.
   */
  async function proxyToServer(req: IncomingMessage, res: ServerResponse, manifest: DeploymentManifest, url: URL) {
    const id = manifest.deploymentId;
    const artifactDir = path.join(opts.artifactsDir, id);
    const started = Date.now();
    try {
      await serverPool.use(
        {
          deploymentId: id,
          entry: path.join(artifactDir, manifest.server!.entry),
          root: path.join(artifactDir, SERVER_DIR),
          runtimeDir: path.join(runtimeDir, id),
          env: readEnv(artifactDir),
          sandbox: sandboxFor(id),
        },
        (port, cold) =>
          new Promise<void>((resolve, reject) => {
            const headers: OutgoingHttpHeaders = { ...req.headers };
            headers["x-forwarded-host"] ??= req.headers.host;
            headers["x-forwarded-proto"] ??= "http";
            headers["x-forwarded-for"] ??= req.socket.remoteAddress;
            const upstream = http.request(
              { host: "127.0.0.1", port, method: req.method, path: url.pathname + url.search, headers },
              (response) => {
                writeHead(res, response.statusCode ?? 502, {
                  ...response.headers,
                  "x-orbit-deployment": id,
                  "x-orbit-instance": cold ? "cold" : "warm",
                  "x-orbit-duration": `${Date.now() - started}ms`,
                });
                response.pipe(res);
                response.on("error", reject);
                res.on("close", () => resolve());
              },
            );
            upstream.on("error", reject);
            // No bytes for this long means the app is stuck (streaming responses keep sending).
            upstream.setTimeout(opts.functionTimeoutMs * 6, () =>
              upstream.destroy(new Error("The server took too long to respond")),
            );
            res.on("close", () => {
              if (!res.writableFinished) upstream.destroy();
            });
            req.pipe(upstream);
          }),
      );
    } catch (err) {
      opts.log?.(`[server ${id}] ${(err as Error).message}`);
      if (res.headersSent) return void res.destroy();
      sendPage(res, req.method ?? "GET", {
        status: 502,
        code: "SERVER_ERROR",
        title: "This deployment's server failed to respond",
        detail: (err as Error).message.split("\n")[0],
      });
    }
  }

  async function serveFile(
    req: IncomingMessage,
    res: ServerResponse,
    manifest: DeploymentManifest,
    file: string,
    relPath: string,
    status: number,
  ) {
    const type = contentType(file);
    const stat = fs.statSync(file);
    const gzip = isCompressible(type) && stat.size > 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    const tag = etag(manifest.deploymentId, relPath, gzip ? "gzip" : "identity");
    const headers: Record<string, string | number> = {
      "content-type": type,
      "cache-control": status === 200 ? cacheControl(relPath, type) : "no-store",
      etag: tag,
      vary: "Accept-Encoding",
      "x-orbit-deployment": manifest.deploymentId,
    };
    if (status === 200 && req.headers["if-none-match"] === tag) {
      writeHead(res, 304, headers);
      res.end();
      return;
    }
    if (gzip) headers["content-encoding"] = "gzip";
    else headers["content-length"] = stat.size;
    writeHead(res, status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const source = fs.createReadStream(file);
    try {
      await (gzip ? pipeline(source, createGzip(), res) : pipeline(source, res));
    } catch (err) {
      // The client went away mid-response; nothing left to do.
      if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    res.setHeader("server", "orbit-edge");
    const apex = wwwRedirectTarget(hostnameFromHost(req.headers.host));
    if (apex) {
      // Like Vercel: www.<domain> sends people to <domain> unless www is a domain of its own.
      const proto = String(req.headers["x-forwarded-proto"] ?? "http")
        .split(",")[0]!
        .trim();
      res.writeHead(308, { location: `${proto}://${apex}${req.url ?? "/"}`, "cache-control": "public, max-age=3600" });
      return void res.end();
    }
    const label = labelFromHost(req.headers.host, opts.rootDomain);
    const domain = label ? null : opts.lookup.resolveDomain?.(hostnameFromHost(req.headers.host));
    if (!label && !domain) {
      return sendPage(res, method, {
        status: 404,
        code: "NO_DEPLOYMENT",
        title: "Orbit edge",
        detail: `Deployments are served at <deployment>.${opts.rootDomain} and <project>.${opts.rootDomain}`,
      });
    }

    const target = label ? opts.lookup.resolve(label) : domain!;
    if (!target)
      return sendPage(res, method, { status: 404, code: "DEPLOYMENT_NOT_FOUND", title: "This deployment could not be found" });
    if (target.status === "queued" || target.status === "building") {
      return sendPage(
        res,
        method,
        {
          status: 503,
          code: "DEPLOYMENT_BUILDING",
          title: "This deployment is building",
          detail: "This page refreshes automatically.",
          refresh: 3,
        },
        { "retry-after": "3" },
      );
    }
    if (target.status !== "ready") {
      const canceled = target.status === "canceled";
      return sendPage(res, method, {
        status: canceled ? 410 : 502,
        code: canceled ? "DEPLOYMENT_CANCELED" : "DEPLOYMENT_FAILED",
        title: canceled ? "This deployment was canceled" : "This deployment failed to build",
      });
    }

    const loaded = loadDeployment(target.deploymentId);
    if (!loaded)
      return sendPage(res, method, { status: 404, code: "DEPLOYMENT_NOT_FOUND", title: "This deployment could not be found" });
    const { manifest, routing } = loaded;
    res.setHeader("x-orbit-deployment", manifest.deploymentId);

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const urlPath = url.pathname;
    if (routing) customHeaders.set(res, routing.headers(urlPath));

    // Routing order follows Vercel: redirects, functions, files on disk, rewrites, then SPA fallback / 404.
    const redirect = routing?.redirect(url);
    if (redirect) {
      writeHead(res, redirect.status, { location: redirect.location, "cache-control": "no-store", "content-length": 0 });
      res.end();
      return;
    }

    const hasFunctions = manifest.functions.length > 0;
    const isApiPath = hasFunctions && isApi(urlPath);
    if (isApiPath && (await serveFunction(req, res, manifest, urlPath, url))) return;

    const readOnly = method === "GET" || method === "HEAD";
    const staticDir = path.join(opts.artifactsDir, manifest.deploymentId, STATIC_DIR);
    const resolve = (p: string, fallbacks = true) =>
      resolveStatic(staticDir, p, {
        spa: manifest.spa,
        cleanUrls: manifest.cleanUrls,
        // An unknown /api route is a 404, not the SPA's index.html.
        isNavigation: !isApiPath && isNavigationRequest(urlPath, req.headers.accept),
        fallbacks,
      });
    const respond = (resolution: Resolution) => {
      if (resolution.kind === "bad-request")
        return sendPage(res, method, { status: 400, code: "BAD_REQUEST", title: "Bad request" });
      if (resolution.kind === "not-found")
        return sendPage(res, method, { status: 404, code: "NOT_FOUND", title: "This page could not be found" });
      return serveFile(req, res, manifest, resolution.file, resolution.relPath, resolution.status);
    };
    const methodNotAllowed = () =>
      sendPage(res, method, { status: 405, code: "METHOD_NOT_ALLOWED", title: "Method not allowed" }, { allow: "GET, HEAD" });

    // Server-rendered apps: built assets and public/ files come straight from disk, the app renders the rest.
    if (manifest.server) {
      if (readOnly) {
        const onDisk = resolve(urlPath, false);
        if (onDisk.kind === "file") return respond(onDisk);
      }
      return proxyToServer(req, res, manifest, url);
    }

    if (routing) {
      if (readOnly) {
        const onDisk = resolve(urlPath, false);
        if (onDisk.kind !== "not-found") return respond(onDisk);
      }
      const rewritten = routing.rewrite(url);
      if (rewritten) {
        if (hasFunctions && isApi(rewritten.pathname) && (await serveFunction(req, res, manifest, rewritten.pathname, rewritten)))
          return;
        return readOnly ? respond(resolve(rewritten.pathname)) : methodNotAllowed();
      }
    }

    if (!readOnly) return methodNotAllowed();
    return respond(resolve(urlPath));
  }

  /** Stops function processes and app servers (on shutdown). */
  const close = () => {
    functionPool.close();
    serverPool.close();
  };
  return Object.assign(handle, { close });
}

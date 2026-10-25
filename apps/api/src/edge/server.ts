import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { DeploymentStatus } from "../db/repo.js";
import { FUNCTION_ENV_FILE, MANIFEST_FILE, STATIC_DIR, type DeploymentManifest } from "../lib/manifest.js";
import { compileRouting, type CompiledRouting } from "../lib/routing.js";
import { FunctionTimeoutError, invokeFunction, matchFunction } from "./functions.js";
import { platformPage } from "./pages.js";
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
}

export interface EdgeOptions {
  rootDomain: string;
  artifactsDir: string;
  lookup: TargetLookup;
  functionTimeoutMs: number;
  functionMemoryMb: number;
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
 * The edge request handler. Stateless apart from a manifest cache, which is safe because
 * artifacts are immutable: a deployment id's manifest can never change.
 */
export function createEdgeHandler(opts: EdgeOptions) {
  const deployments = new Map<string, LoadedDeployment>();
  const maxBody = opts.maxBodyBytes ?? 4.5 * 1024 * 1024;
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

  function writeHead(res: ServerResponse, status: number, headers: Record<string, string | number>): void {
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
    let env: Record<string, string> = {};
    try {
      env = JSON.parse(fs.readFileSync(path.join(artifactDir, FUNCTION_ENV_FILE), "utf8")) as Record<string, string>;
    } catch {
      /* no env snapshot */
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers))
      if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;

    const started = Date.now();
    try {
      const out = await invokeFunction({
        artifactDir,
        route: match.route,
        params: match.params,
        request: { method: req.method!, url: url.toString(), headers, body: Buffer.concat(chunks) },
        env,
        timeoutMs: match.route.maxDurationMs ?? opts.functionTimeoutMs,
        memoryMb: match.route.memoryMb ?? opts.functionMemoryMb,
        onLog: (stream, text) => opts.log?.(`[fn ${manifest.deploymentId}${match.route.route}] ${stream}: ${text.trimEnd()}`),
      });
      const responseHeaders: Record<string, string> = { "cache-control": "no-store", ...out.headers };
      delete responseHeaders["content-encoding"];
      delete responseHeaders["transfer-encoding"];
      responseHeaders["content-length"] = String(out.body.length);
      responseHeaders["x-orbit-deployment"] = manifest.deploymentId;
      responseHeaders["x-orbit-function"] = match.route.route;
      responseHeaders["x-orbit-duration"] = `${Date.now() - started}ms`;
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

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    res.setHeader("server", "orbit-edge");
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
  };
}

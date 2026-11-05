import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import { type BlobRecord, blobToken } from "../db/repo.js";
import { hostnameFromHost } from "../edge/server.js";
import { type BlobAuth, BlobApiError, type BlobService, type PutOptions, validatePathname } from "../services/blob.js";

/**
 * Orbit Blob's public HTTP surface on blob.<root>, which the edge forwards here under /blob:
 *
 *   /api...                Vercel Blob's API (VERCEL_BLOB_API_URL = https://blob.<root>/api)
 *   /<store>/<pathname>    the files
 *
 * Requests for any other host are refused, so none of this is reachable on the dashboard's origin.
 */

const flag = (value: unknown) => value === "1" || value === "true";

function putOptions(req: FastifyRequest): PutOptions {
  const h = req.headers;
  const access = String(h["x-vercel-blob-access"] ?? "public");
  if (access !== "public" && access !== "private") {
    throw new BlobApiError(400, "bad_request", 'access must be "private" or "public"');
  }
  const maxAge = h["x-cache-control-max-age"];
  return {
    access,
    addRandomSuffix: flag(h["x-add-random-suffix"]),
    allowOverwrite: flag(h["x-allow-overwrite"]),
    contentType: typeof h["x-content-type"] === "string" ? h["x-content-type"] : undefined,
    cacheControlMaxAge: maxAge === undefined ? undefined : Number(maxAge),
    ifMatch: typeof h["x-if-match"] === "string" ? h["x-if-match"] : undefined,
  };
}

async function readJson<T>(body: Readable): Promise<T> {
  let raw = "";
  for await (const chunk of body) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new BlobApiError(400, "bad_request", "Body too large");
  }
  try {
    return JSON.parse(raw || "null") as T;
  } catch {
    throw new BlobApiError(400, "bad_request", "Invalid JSON body");
  }
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BlobApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
  console.error("[blob]", err);
  return reply.code(500).send({ error: { code: "internal_server_error", message: "Internal error" } });
}

export function blobApiRoutes(app: FastifyInstance, ctx: AppContext, blob: BlobService): void {
  const blobHost = `blob.${ctx.config.rootDomain}`;

  /**
   * Tells the app an upload finished (handleUpload's onUploadCompleted), signed with the store's
   * token like Vercel's callback. Only Orbit's own deployments are called, through the edge, so a
   * client token can't make the control plane fetch arbitrary internal URLs.
   */
  function notifyUploadCompleted(auth: BlobAuth, record: BlobRecord): void {
    const callback = auth.client?.onUploadCompleted;
    if (!callback?.callbackUrl) return;
    let target: URL;
    try {
      target = new URL(callback.callbackUrl);
    } catch {
      return;
    }
    const hostname = target.hostname.toLowerCase();
    const ours = hostname.endsWith(`.${ctx.config.rootDomain}`) || ctx.repo.getDomain(hostname) !== undefined;
    if (!ours || hostname === blobHost) {
      console.warn(`[blob] upload callback skipped: ${hostname} isn't a deployment on this Orbit`);
      return;
    }
    const body = JSON.stringify({
      type: "blob.upload-completed",
      payload: { blob: blob.putResult(record), tokenPayload: callback.tokenPayload ?? null },
    });
    const signature = createHmac("sha256", blobToken(auth.store)).update(body).digest("hex");
    const edge = new URL(ctx.config.edgeInternalUrl);
    const req = http.request(
      {
        host: edge.hostname,
        port: edge.port || 80,
        method: "POST",
        path: target.pathname + target.search,
        headers: {
          host: target.host,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-vercel-signature": signature,
          "x-forwarded-proto": target.protocol.replace(":", ""),
        },
        timeout: 30_000,
      },
      (res) => res.resume(),
    );
    req.on("timeout", () => req.destroy());
    req.on("error", (err) => console.warn(`[blob] upload callback to ${target.host} failed: ${err.message}`));
    req.end(body);
  }

  app.register(
    async (scope) => {
      // Bodies are streamed to disk, never buffered: every content type arrives as the raw stream.
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

      scope.addHook("onRequest", async (req, reply) => {
        if (hostnameFromHost(req.headers.host) !== blobHost) return reply.code(404).send({ error: { code: "not_found" } });
      });

      const api = async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const query = req.query as Record<string, string | undefined>;
          const auth = blob.authenticate(req.headers.authorization);
          const storeId = auth.store.id;
          if (req.method === "GET" && query.url !== undefined) {
            blob.checkClient(auth, null);
            return reply.send(blob.headResult(blob.head(storeId, query.url)));
          }
          if (req.method === "GET") {
            blob.checkClient(auth, null);
            const result = blob.list(storeId, {
              prefix: query.prefix,
              cursor: query.cursor,
              limit: query.limit ? Number(query.limit) : undefined,
              folded: query.mode === "folded",
            });
            return reply.send({
              blobs: result.blobs.map((b) => blob.listResult(b)),
              ...(query.mode === "folded" ? { folders: result.folders } : {}),
              hasMore: result.hasMore,
              ...(result.cursor ? { cursor: result.cursor } : {}),
            });
          }
          if (req.method === "PUT" && query.fromUrl !== undefined) {
            blob.checkClient(auth, null);
            const record = blob.copy(auth, query.fromUrl, validatePathname(query.pathname), putOptions(req));
            return reply.send(blob.putResult(record));
          }
          if (req.method === "PUT") {
            const pathname = validatePathname(query.pathname);
            const record = await blob.put(auth, pathname, req.body as Readable, putOptions(req));
            notifyUploadCompleted(auth, record);
            return reply.send(blob.putResult(record));
          }
          return reply.code(405).send({ error: { code: "bad_request", message: "Method not allowed" } });
        } catch (err) {
          return sendError(reply, err);
        }
      };
      for (const url of ["/api", "/api/"]) {
        scope.get(url, api);
        scope.put(url, api);
      }

      scope.post("/api/delete", async (req, reply) => {
        try {
          const auth = blob.authenticate(req.headers.authorization);
          blob.checkClient(auth, null);
          const body = await readJson<{ urls?: unknown }>(req.body as Readable);
          const urls = Array.isArray(body?.urls) ? body.urls.filter((u): u is string => typeof u === "string") : [];
          const ifMatch = typeof req.headers["x-if-match"] === "string" ? req.headers["x-if-match"] : undefined;
          blob.delete(auth.store.id, urls, ifMatch);
          return reply.send({});
        } catch (err) {
          return sendError(reply, err);
        }
      });

      scope.post("/api/rename", async (req, reply) => {
        try {
          const auth = blob.authenticate(req.headers.authorization);
          blob.checkClient(auth, null);
          const query = req.query as Record<string, string | undefined>;
          const record = blob.copy(auth, query.fromUrl ?? "", validatePathname(query.pathname), putOptions(req), true);
          return reply.send(blob.putResult(record));
        } catch (err) {
          return sendError(reply, err);
        }
      });

      scope.post("/api/mpu", async (req, reply) => {
        try {
          const auth = blob.authenticate(req.headers.authorization);
          const pathname = validatePathname((req.query as Record<string, string>).pathname);
          const action = req.headers["x-mpu-action"];
          const uploadId = String(req.headers["x-mpu-upload-id"] ?? "");
          if (action === "create") return reply.send(blob.createUpload(auth, pathname));
          if (action === "upload") {
            const part = Number(req.headers["x-mpu-part-number"]);
            return reply.send(await blob.uploadPart(auth, pathname, uploadId, part, req.body as Readable));
          }
          if (action === "complete") {
            const parts = await readJson<{ etag: string; partNumber: number }[]>(req.body as Readable);
            if (!Array.isArray(parts) || parts.length === 0) throw new BlobApiError(400, "bad_request", "parts are required");
            const record = await blob.completeUpload(auth, pathname, uploadId, parts, putOptions(req));
            notifyUploadCompleted(auth, record);
            return reply.send(blob.putResult(record));
          }
          throw new BlobApiError(400, "bad_request", "Unknown x-mpu-action");
        } catch (err) {
          return sendError(reply, err);
        }
      });

      for (const url of ["/api/put-optimized", "/api/put-from-url", "/api/signed-token"]) {
        scope.post(url, async (_req, reply) =>
          sendError(reply, new BlobApiError(400, "bad_request", "This operation isn't supported by Orbit Blob yet")),
        );
      }

      // ---------------------------------------------------------------- files

      const serveFile = async (req: FastifyRequest, reply: FastifyReply) => {
        const { store, "*": rest } = req.params as { store: string; "*": string };
        let pathname: string;
        try {
          pathname = rest.split("/").map(decodeURIComponent).join("/");
        } catch {
          return reply.code(400).send("Bad path");
        }
        const record = ctx.repo.getBlob(store, pathname);
        if (!record) return reply.code(404).type("text/plain").send("Not Found");
        if (record.access === "private") {
          try {
            const auth = blob.authenticate(req.headers.authorization);
            if (auth.store.id !== store || auth.client) throw new BlobApiError(403, "forbidden", "Forbidden");
          } catch {
            return reply.code(403).type("text/plain").send("Forbidden");
          }
        }
        const file = blob.objectPath(store, record.object);
        const download = (req.query as Record<string, string>).download === "1";
        const headers: Record<string, string> = {
          "content-type": record.contentType,
          etag: record.etag,
          "last-modified": new Date(record.uploadedAt).toUTCString(),
          "cache-control": blob.cacheControl(record),
          "content-disposition": blob.disposition(record, download),
          "accept-ranges": "bytes",
          "x-content-type-options": "nosniff",
          "access-control-allow-origin": "*",
        };
        if (req.headers["if-none-match"] === record.etag) return reply.code(304).headers(headers).send();

        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
        let start = 0;
        let end = record.size - 1;
        let status = 200;
        if (range && record.size > 0) {
          start = range[1] ? Number(range[1]) : Math.max(0, record.size - Number(range[2]));
          end = range[1] && range[2] ? Math.min(Number(range[2]), record.size - 1) : record.size - 1;
          if (start > end || start >= record.size) {
            return reply.code(416).header("content-range", `bytes */${record.size}`).send();
          }
          status = 206;
          headers["content-range"] = `bytes ${start}-${end}/${record.size}`;
        }
        headers["content-length"] = String(record.size === 0 ? 0 : end - start + 1);
        reply.code(status).headers(headers);
        if (req.method === "HEAD" || record.size === 0) return reply.send();
        return reply.send(fs.createReadStream(file, { start, end }));
      };
      // Fastify answers HEAD with this handler too (and drops the body).
      scope.get("/:store/*", serveFile);
    },
    { prefix: "/blob" },
  );
}

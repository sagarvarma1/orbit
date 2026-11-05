import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import type { Config } from "../config.js";
import { type BlobRecord, type BlobStore, blobToken, type Repo } from "../db/repo.js";
import { contentType as contentTypeFor } from "../edge/static.js";
import { publicUrl } from "../lib/urls.js";

/**
 * Orbit Blob: object storage that speaks Vercel Blob's API, so the @vercel/blob SDK works
 * unchanged (put, list, head, del, copy, rename, multipart and client uploads) with
 * VERCEL_BLOB_API_URL pointing here. Files live on disk under <data>/blob/<store>/, metadata in
 * SQLite. Everything is served from its own host, blob.<root>: the API at /api and files at
 * /<store>/<pathname>, so uploaded content never runs on the dashboard's origin.
 */

/** Vercel's limits. */
export const MAX_PATHNAME_LENGTH = 950;
export const DEFAULT_CACHE_MAX_AGE = 30 * 24 * 60 * 60;
const MIN_CACHE_MAX_AGE = 60;
const MAX_LIST_LIMIT = 1000;

export class BlobApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const badRequest = (message: string) => new BlobApiError(400, "bad_request", message);
const notFound = () => new BlobApiError(404, "not_found", "The requested blob does not exist");
const forbidden = (message = "Access denied, please provide a valid token for this resource.") =>
  new BlobApiError(403, "forbidden", message);

/** What a request may do, from its token. */
export interface BlobAuth {
  store: BlobStore;
  /** A client token's constraints (browser uploads via handleUpload); null for a read-write token. */
  client: ClientTokenPayload | null;
}

export interface ClientTokenPayload {
  pathname: string;
  validUntil: number;
  allowedContentTypes?: string[];
  maximumSizeInBytes?: number;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  cacheControlMaxAge?: number;
  ifMatch?: string;
  onUploadCompleted?: { callbackUrl: string; tokenPayload?: string | null };
}

export interface PutOptions {
  access: "public" | "private";
  addRandomSuffix: boolean;
  allowOverwrite: boolean;
  contentType?: string;
  cacheControlMaxAge?: number;
  ifMatch?: string;
}

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function randomSuffix(length = 30): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => RANDOM_ALPHABET[b % RANDOM_ALPHABET.length]).join("");
}

/** "a/photo.png" -> "a/photo-<random>.png", like Vercel's addRandomSuffix. */
export function withRandomSuffix(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  const suffix = randomSuffix();
  return dot > slash + 1 ? `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}` : `${pathname}-${suffix}`;
}

export function validatePathname(raw: string | null | undefined): string {
  const pathname = (raw ?? "").replace(/^\/+/, "");
  if (!pathname) throw badRequest("pathname is required");
  if (pathname.length > MAX_PATHNAME_LENGTH) throw badRequest(`pathname is too long, maximum length is ${MAX_PATHNAME_LENGTH}`);
  if (pathname.includes("//")) throw badRequest('pathname cannot contain "//", please encode it if needed');
  if (pathname.split("/").some((s) => s === "." || s === "..")) throw badRequest("pathname cannot contain . or .. segments");
  if (/[\u0000-\u001f]/.test(pathname)) throw badRequest("pathname cannot contain control characters");
  return pathname;
}

/** Counts bytes through a stream and stops past a limit. */
function limiter(limit: number, onTooLarge: () => Error): Transform & { bytes: number } {
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      t.bytes += chunk.length;
      if (t.bytes > limit) return cb(onTooLarge());
      cb(null, chunk);
    },
  }) as Transform & { bytes: number };
  t.bytes = 0;
  return t;
}

export class BlobService {
  readonly root: string;

  constructor(
    private readonly repo: Repo,
    private readonly config: Pick<
      Config,
      "dataDir" | "publicProtocol" | "rootDomain" | "publicEdgePort" | "blobMaxUploadMb" | "blobStoreQuotaMb"
    >,
  ) {
    this.root = path.join(config.dataDir, "blob");
  }

  /** https://blob.<root> */
  get origin(): string {
    return publicUrl(this.config, "blob");
  }

  /** What VERCEL_BLOB_API_URL is set to in deployments. */
  get apiUrl(): string {
    return `${this.origin}/api`;
  }

  url(storeId: string, pathname: string): string {
    return `${this.origin}/${storeId}/${pathname.split("/").map(encodeURIComponent).join("/")}`;
  }

  private storeDir(storeId: string): string {
    return path.join(this.root, storeId);
  }

  objectPath(storeId: string, object: string): string {
    return path.join(this.storeDir(storeId), object);
  }

  // ------------------------------------------------------------------- auth

  /** Accepts the store's read-write token, or a client token signed with it (browser uploads). */
  authenticate(header: string | undefined): BlobAuth {
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw forbidden("Missing authorization token");
    const [a, b, kind, storeId = "", ...rest] = token.split("_");
    if (a !== "vercel" || b !== "blob" || (kind !== "rw" && kind !== "client")) throw forbidden();
    const store = this.repo.getBlobStore(storeId);
    if (!store) throw new BlobApiError(404, "store_not_found", "This store does not exist.");
    if (kind === "rw") {
      const expected = Buffer.from(blobToken(store));
      const given = Buffer.from(token);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw forbidden();
      return { store, client: null };
    }
    // vercel_blob_client_<store>_<base64("<hmac hex>.<base64 payload>")>, signed with the read-write token.
    let decoded: string;
    try {
      decoded = Buffer.from(rest.join("_"), "base64").toString("utf8");
    } catch {
      throw forbidden();
    }
    const dot = decoded.indexOf(".");
    const signature = decoded.slice(0, dot);
    const payloadB64 = decoded.slice(dot + 1);
    const expected = createHmac("sha256", blobToken(store)).update(payloadB64).digest("hex");
    if (dot < 0 || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw forbidden();
    }
    let payload: ClientTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as ClientTokenPayload;
    } catch {
      throw forbidden();
    }
    if (typeof payload.validUntil === "number" && payload.validUntil < Date.now()) {
      throw new BlobApiError(400, "client_token_expired", "Token expired");
    }
    return { store, client: payload };
  }

  /** Client tokens may only upload, and only to the pathname they were issued for. */
  checkClient(auth: BlobAuth, pathname: string | null): void {
    if (!auth.client) return;
    if (pathname === null) {
      throw new BlobApiError(403, "client_token_not_allowed", "This operation is not available when using a client token.");
    }
    if (auth.client.pathname !== pathname) {
      throw badRequest(`"pathname" does not match the token payload`);
    }
  }

  // ------------------------------------------------------------------ write

  /** Merges a client token's settings over the request's (the server decided them). */
  effectiveOptions(auth: BlobAuth, requested: PutOptions): PutOptions {
    const c = auth.client;
    if (!c) return requested;
    return {
      ...requested,
      addRandomSuffix: c.addRandomSuffix ?? false,
      allowOverwrite: c.allowOverwrite ?? false,
      cacheControlMaxAge: c.cacheControlMaxAge,
      ifMatch: c.ifMatch ?? requested.ifMatch,
    };
  }

  /** Streams a body to a new object file; resolves with its name and size. */
  async writeObject(storeId: string, body: Readable, maxBytes: number): Promise<{ object: string; size: number }> {
    const dir = this.storeDir(storeId);
    fs.mkdirSync(dir, { recursive: true });
    const object = randomBytes(12).toString("hex");
    const tmp = path.join(dir, `.tmp-${object}`);
    const limit = limiter(
      maxBytes,
      () => new BlobApiError(400, "file_too_large", `the file length cannot be greater than ${maxBytes} bytes`),
    );
    try {
      await pipeline(body, limit, fs.createWriteStream(tmp, { mode: 0o600 }));
      fs.renameSync(tmp, path.join(dir, object));
      return { object, size: limit.bytes };
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  private checkQuota(store: BlobStore, adding: number): void {
    const quota = this.config.blobStoreQuotaMb * 1024 * 1024;
    if (quota > 0 && this.repo.blobUsage(store.id).bytes + adding > quota) {
      throw new BlobApiError(400, "bad_request", `This store is over its ${this.config.blobStoreQuotaMb} MB quota`);
    }
  }

  /** Records an uploaded object at a pathname, applying Vercel's overwrite and precondition rules. */
  commit(auth: BlobAuth, requestedPathname: string, object: { object: string; size: number }, options: PutOptions): BlobRecord {
    const store = auth.store;
    const discard = () => fs.rmSync(this.objectPath(store.id, object.object), { force: true });
    try {
      if (auth.client) {
        const max = auth.client.maximumSizeInBytes;
        if (max !== undefined && object.size > max) {
          throw new BlobApiError(400, "file_too_large", `the file length cannot be greater than ${max} bytes`);
        }
      }
      const folder = requestedPathname.endsWith("/");
      const pathname = options.addRandomSuffix && !folder ? withRandomSuffix(requestedPathname) : requestedPathname;
      const contentType = folder ? "application/x-directory" : options.contentType || contentTypeFor(pathname);
      const allowed = auth.client?.allowedContentTypes;
      if (
        allowed &&
        !allowed.some((t) => (t.endsWith("/*") ? contentType.startsWith(t.slice(0, -1)) : contentType.split(";")[0] === t))
      ) {
        throw badRequest(`contentType ${contentType} is not allowed`);
      }
      const existing = this.repo.getBlob(store.id, pathname);
      if (options.ifMatch && (!existing || existing.etag !== options.ifMatch)) {
        throw new BlobApiError(412, "precondition_failed", "Precondition failed: ETag mismatch.");
      }
      if (existing && !options.allowOverwrite && !options.ifMatch && !folder) {
        throw badRequest(
          "This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename.",
        );
      }
      this.checkQuota(store, object.size - (existing?.size ?? 0));
      const maxAge = Math.max(MIN_CACHE_MAX_AGE, options.cacheControlMaxAge ?? DEFAULT_CACHE_MAX_AGE);
      const record: BlobRecord = {
        storeId: store.id,
        pathname,
        object: object.object,
        size: object.size,
        contentType,
        cacheMaxAge: maxAge,
        access: options.access,
        etag: `"${object.object}"`,
        uploadedAt: Date.now(),
      };
      const replaced = this.repo.putBlob(record);
      if (replaced) fs.rmSync(this.objectPath(store.id, replaced), { force: true });
      return record;
    } catch (err) {
      discard();
      throw err;
    }
  }

  async put(auth: BlobAuth, pathname: string, body: Readable, options: PutOptions): Promise<BlobRecord> {
    this.checkClient(auth, pathname);
    const effective = this.effectiveOptions(auth, options);
    const object = await this.writeObject(auth.store.id, body, this.config.blobMaxUploadMb * 1024 * 1024);
    return this.commit(auth, pathname, object, effective);
  }

  /** The blob a URL or pathname refers to, in this store. */
  resolve(storeId: string, urlOrPathname: string): string | null {
    if (/^https?:\/\//.test(urlOrPathname)) {
      let url: URL;
      try {
        url = new URL(urlOrPathname);
      } catch {
        return null;
      }
      const [, store, ...rest] = url.pathname.split("/");
      if (store !== storeId || rest.length === 0) return null;
      return rest.map(decodeURIComponent).join("/");
    }
    return urlOrPathname.replace(/^\/+/, "");
  }

  head(storeId: string, urlOrPathname: string): BlobRecord {
    const pathname = this.resolve(storeId, urlOrPathname);
    const blob = pathname ? this.repo.getBlob(storeId, pathname) : undefined;
    if (!blob) throw notFound();
    return blob;
  }

  delete(storeId: string, urls: string[], ifMatch?: string): void {
    for (const u of urls) {
      const pathname = this.resolve(storeId, u);
      if (!pathname) continue;
      if (ifMatch) {
        const blob = this.repo.getBlob(storeId, pathname);
        if (!blob || blob.etag !== ifMatch)
          throw new BlobApiError(412, "precondition_failed", "Precondition failed: ETag mismatch.");
      }
      const removed = this.repo.deleteBlob(storeId, pathname);
      if (removed) fs.rmSync(this.objectPath(storeId, removed.object), { force: true });
    }
  }

  copy(auth: BlobAuth, fromUrl: string, toPathname: string, options: PutOptions, remove = false): BlobRecord {
    const source = this.head(auth.store.id, fromUrl);
    const dir = this.storeDir(auth.store.id);
    const object = randomBytes(12).toString("hex");
    fs.copyFileSync(path.join(dir, source.object), path.join(dir, object));
    const record = this.commit(
      auth,
      toPathname,
      { object, size: source.size },
      {
        ...options,
        contentType: options.contentType ?? source.contentType,
        cacheControlMaxAge: options.cacheControlMaxAge ?? source.cacheMaxAge,
      },
    );
    if (remove && record.pathname !== source.pathname) this.delete(auth.store.id, [source.pathname]);
    return record;
  }

  /**
   * Blobs in pathname order. Folded mode (the dashboard's folder view, `mode: "folded"`) lists
   * each folder below `prefix` once instead of its contents.
   */
  list(
    storeId: string,
    opts: { prefix?: string; cursor?: string; limit?: number; folded?: boolean },
  ): { blobs: BlobRecord[]; folders: string[]; cursor?: string; hasMore: boolean } {
    const prefix = opts.prefix ?? "";
    const limit = Math.min(Math.max(1, opts.limit ?? MAX_LIST_LIMIT), MAX_LIST_LIMIT);
    let after = opts.cursor ? Buffer.from(opts.cursor, "base64url").toString("utf8") : null;
    const blobs: BlobRecord[] = [];
    const folders: string[] = [];
    for (;;) {
      const page = this.repo.listBlobs(storeId, { prefix, after, limit: limit + 1 });
      let skipped = false;
      for (const blob of page) {
        if (blobs.length + folders.length === limit) {
          return { blobs, folders, hasMore: true, cursor: Buffer.from(after ?? "").toString("base64url") };
        }
        const rest = blob.pathname.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (opts.folded && rest === "") {
          after = blob.pathname; // the prefix's own folder marker
          continue;
        }
        if (opts.folded && slash >= 0) {
          const folder = prefix + rest.slice(0, slash + 1);
          folders.push(folder);
          after = `${folder}\uffff`; // continue after everything in this folder
          skipped = true;
          break;
        }
        blobs.push(blob);
        after = blob.pathname;
      }
      if (!skipped && page.length <= limit) return { blobs, folders, hasMore: false };
    }
  }

  // -------------------------------------------------------------- multipart

  private uploadDir(storeId: string, uploadId: string): string {
    return path.join(this.storeDir(storeId), ".mpu", uploadId);
  }

  createUpload(auth: BlobAuth, pathname: string): { key: string; uploadId: string } {
    this.checkClient(auth, pathname);
    const uploadId = randomBytes(12).toString("hex");
    fs.mkdirSync(this.uploadDir(auth.store.id, uploadId), { recursive: true });
    this.repo.insertBlobUpload({ id: uploadId, storeId: auth.store.id, pathname });
    return { key: pathname, uploadId };
  }

  async uploadPart(
    auth: BlobAuth,
    pathname: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
  ): Promise<{ etag: string }> {
    this.checkClient(auth, pathname);
    const upload = this.repo.getBlobUpload(uploadId);
    if (!upload || upload.storeId !== auth.store.id || upload.pathname !== pathname) throw notFound();
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw badRequest("invalid part number");
    const file = path.join(this.uploadDir(auth.store.id, uploadId), String(partNumber));
    const limit = limiter(this.config.blobMaxUploadMb * 1024 * 1024, () => badRequest("part too large"));
    await pipeline(body, limit, fs.createWriteStream(file, { mode: 0o600 }));
    return { etag: `"${uploadId}-${partNumber}-${limit.bytes}"` };
  }

  async completeUpload(
    auth: BlobAuth,
    pathname: string,
    uploadId: string,
    parts: { etag: string; partNumber: number }[],
    options: PutOptions,
  ): Promise<BlobRecord> {
    this.checkClient(auth, pathname);
    const upload = this.repo.getBlobUpload(uploadId);
    if (!upload || upload.storeId !== auth.store.id || upload.pathname !== pathname) throw notFound();
    const dir = this.uploadDir(auth.store.id, uploadId);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const object = randomBytes(12).toString("hex");
    const target = this.objectPath(auth.store.id, object);
    let size = 0;
    const out = fs.createWriteStream(target, { mode: 0o600 });
    try {
      for (const part of ordered) {
        const file = path.join(dir, String(part.partNumber));
        if (!fs.existsSync(file)) throw badRequest(`part ${part.partNumber} was not uploaded`);
        size += fs.statSync(file).size;
        await pipeline(fs.createReadStream(file), out, { end: false });
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      fs.rmSync(target, { force: true });
      throw err;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    this.repo.deleteBlobUpload(uploadId);
    return this.commit(auth, pathname, { object, size }, this.effectiveOptions(auth, options));
  }

  // ---------------------------------------------------------------- results

  /** The JSON shape @vercel/blob expects from put/copy and multipart completion. */
  putResult(blob: BlobRecord) {
    const url = this.url(blob.storeId, blob.pathname);
    return {
      url,
      downloadUrl: `${url}?download=1`,
      pathname: blob.pathname,
      contentType: blob.contentType,
      contentDisposition: this.disposition(blob, true),
      etag: blob.etag,
    };
  }

  headResult(blob: BlobRecord) {
    return {
      ...this.putResult(blob),
      size: blob.size,
      cacheControl: this.cacheControl(blob),
      uploadedAt: new Date(blob.uploadedAt).toISOString(),
    };
  }

  listResult(blob: BlobRecord) {
    const url = this.url(blob.storeId, blob.pathname);
    return {
      url,
      downloadUrl: `${url}?download=1`,
      pathname: blob.pathname,
      size: blob.size,
      uploadedAt: new Date(blob.uploadedAt).toISOString(),
      etag: blob.etag,
    };
  }

  disposition(blob: BlobRecord, attachment: boolean): string {
    const name = blob.pathname.split("/").pop() || "download";
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return `${attachment ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  cacheControl(blob: BlobRecord): string {
    return blob.access === "public" ? `public, max-age=${blob.cacheMaxAge}` : "private, no-cache";
  }

  /** Removes a store's files (the rows go with the store). */
  removeStoreFiles(storeId: string): void {
    fs.rmSync(this.storeDir(storeId), { recursive: true, force: true });
  }
}

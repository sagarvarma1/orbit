/**
 * Orbit Blob against the real @vercel/blob SDK: SDK -> edge (blob.localhost) -> control plane.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { copy, del, get, head, list, put, BlobError } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEdgeHandler } from "../src/edge/server.js";
import { adminHeaders, type TestApp, testApp } from "./helpers.js";

let t: TestApp;
let edge: http.Server;
let headers: Record<string, string>;
let token: string;
let storeId: string;
let origin: string;

/** A free port, so blob URLs (which include the public edge port) point at the test edge. */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "::", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

beforeAll(async () => {
  const edgePort = await freePort();
  t = await testApp({ blobStoreQuotaMb: 50, publicEdgePort: String(edgePort), publicProtocol: "http" });
  headers = await adminHeaders(t);
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  const apiPort = (t.app.server.address() as AddressInfo).port;
  const handle = createEdgeHandler({
    rootDomain: "localhost",
    artifactsDir: t.config.artifactsDir,
    lookup: { resolve: () => null },
    functionTimeoutMs: 1000,
    functionMemoryMb: 128,
    blobUpstream: `http://127.0.0.1:${apiPort}`,
  });
  edge = http.createServer((req, res) => void handle(req, res));
  // blob.localhost resolves to ::1 or 127.0.0.1 depending on the OS: listen on both.
  await new Promise<void>((r) => edge.listen(edgePort, "::", r));
  origin = `http://blob.localhost:${(edge.address() as AddressInfo).port}`;
  process.env.VERCEL_BLOB_API_URL = `${origin}/api`;
  process.env.VERCEL_BLOB_RETRIES = "0";

  const created = await t.app.inject({ method: "POST", url: "/api/blob-stores", headers, payload: { name: "Uploads" } });
  expect(created.statusCode).toBe(201);
  token = created.json().store.token;
  storeId = created.json().store.id;
});

afterAll(async () => {
  edge?.close();
  await t?.close();
  delete process.env.VERCEL_BLOB_API_URL;
});

const fetchText = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.text(), headers: res.headers };
};

describe("Orbit Blob with the @vercel/blob SDK", () => {
  it("issues Vercel-format tokens", () => {
    expect(token).toMatch(new RegExp(`^vercel_blob_rw_${storeId}_[A-Za-z0-9]{32}$`));
  });

  it("puts a public blob and serves it from its URL", async () => {
    const result = await put("docs/hello.txt", "Hello, blob!", { access: "public", token });
    expect(result).toMatchObject({
      pathname: "docs/hello.txt",
      contentType: "text/plain; charset=utf-8",
      url: `${origin}/${storeId}/docs/hello.txt`,
      downloadUrl: `${origin}/${storeId}/docs/hello.txt?download=1`,
    });
    const file = await fetchText(result.url);
    expect(file.status).toBe(200);
    expect(file.body).toBe("Hello, blob!");
    expect(file.headers.get("cache-control")).toBe("public, max-age=2592000");
    expect(file.headers.get("content-disposition")).toMatch(/^inline; filename="hello.txt"/);
    expect((await fetchText(result.downloadUrl)).headers.get("content-disposition")).toMatch(/^attachment/);
    const ranged = await fetchText(result.url, { headers: { range: "bytes=7-10" } });
    expect([ranged.status, ranged.body]).toEqual([206, "blob"]);
    const cached = await fetch(result.url, { headers: { "if-none-match": result.etag } });
    expect(cached.status).toBe(304);
  });

  it("refuses to overwrite unless asked, and supports random suffixes", async () => {
    await expect(put("docs/hello.txt", "again", { access: "public", token })).rejects.toThrow(BlobError);
    const overwritten = await put("docs/hello.txt", "Overwritten", { access: "public", token, allowOverwrite: true });
    expect((await fetchText(overwritten.url)).body).toBe("Overwritten");
    const suffixed = await put("images/cat.png", Buffer.from([137, 80, 78, 71]), {
      access: "public",
      token,
      addRandomSuffix: true,
    });
    expect(suffixed.pathname).toMatch(/^images\/cat-[A-Za-z0-9]{30}\.png$/);
    expect(suffixed.contentType).toBe("image/png");
  });

  it("heads, lists (flat and folded), copies and deletes", async () => {
    const info = await head("docs/hello.txt", { token });
    expect(info).toMatchObject({ pathname: "docs/hello.txt", size: 11, cacheControl: "public, max-age=2592000" });
    expect(info.uploadedAt).toBeInstanceOf(Date);
    await expect(head("nope.txt", { token })).rejects.toThrow(/does not exist/i);

    await put("docs/b.txt", "b", { access: "public", token });
    await put("docs/deep/c.txt", "c", { access: "public", token });
    const flat = await list({ token, prefix: "docs/" });
    expect(flat.blobs.map((b) => b.pathname)).toEqual(["docs/b.txt", "docs/deep/c.txt", "docs/hello.txt"]);
    const folded = await list({ token, mode: "folded" });
    expect(folded.folders.sort()).toEqual(["docs/", "images/"]);
    const inDocs = await list({ token, mode: "folded", prefix: "docs/" });
    expect(inDocs.folders).toEqual(["docs/deep/"]);
    expect(inDocs.blobs.map((b) => b.pathname)).toEqual(["docs/b.txt", "docs/hello.txt"]);

    const paged = await list({ token, limit: 2 });
    expect(paged.hasMore).toBe(true);
    const next = await list({ token, limit: 2, cursor: paged.cursor });
    expect(next.blobs[0]!.pathname > paged.blobs[1]!.pathname).toBe(true);

    const copied = await copy(info.url, "archive/hello.txt", { access: "public", token });
    expect((await fetchText(copied.url)).body).toBe("Overwritten");
    await del([copied.url, "docs/b.txt"], { token });
    expect((await fetchText(copied.url)).status).toBe(404);
    await expect(head("docs/b.txt", { token })).rejects.toThrow();
  });

  it("keeps private blobs private, readable with get() and the token", async () => {
    const result = await put("secret/report.json", JSON.stringify({ ok: true }), { access: "private", token });
    expect((await fetch(result.url)).status).toBe(403);
    // get() builds *.blob.vercel-storage.com URLs from bare pathnames, so on Orbit it takes the blob's URL
    // (any URL on VERCEL_BLOB_API_URL's origin is accepted).
    const fetched = await get(result.url, { access: "private", token });
    expect(fetched?.statusCode).toBe(200);
    expect(await new Response(fetched!.stream).json()).toEqual({ ok: true });
  });

  it("supports multipart uploads", async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 7);
    const result = await put("big/file.bin", big, { access: "public", token, multipart: true });
    const info = await head(result.url, { token });
    expect(info.size).toBe(big.length);
  });

  it("accepts client tokens only for their pathname, size and content types", async () => {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname: "avatars/me.png",
      allowedContentTypes: ["image/*"],
      maximumSizeInBytes: 1024,
    });
    const ok = await put("avatars/me.png", Buffer.from([1, 2, 3]), { access: "public", token: clientToken });
    expect(ok.pathname).toBe("avatars/me.png");
    await expect(put("avatars/other.png", "x", { access: "public", token: clientToken })).rejects.toThrow(/pathname/i);
    const textToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname: "avatars/me.txt",
      allowedContentTypes: ["image/*"],
    });
    await expect(put("avatars/me.txt", "x", { access: "public", token: textToken })).rejects.toThrow(/content type/i);
    const tiny = await generateClientTokenFromReadWriteToken({ token, pathname: "avatars/big.png", maximumSizeInBytes: 2 });
    await expect(put("avatars/big.png", "too big", { access: "public", token: tiny })).rejects.toThrow(/file length|too large/i);
    // Client tokens can't list or delete.
    await expect(list({ token: clientToken })).rejects.toThrow();
  });

  it("rejects bad tokens and serves nothing on other hosts", async () => {
    await expect(
      put("x.txt", "x", { access: "public", token: `vercel_blob_rw_${storeId}_wrongsecretwrongsecretwrongsecre` }),
    ).rejects.toThrow();
    const direct = await t.app.inject({ method: "GET", url: `/blob/${storeId}/docs/hello.txt`, headers: { host: "localhost" } });
    expect(direct.statusCode).toBe(404);
  });

  it("enforces the store quota", async () => {
    await expect(put("quota/huge.bin", Buffer.alloc(51 * 1024 * 1024), { access: "public", token })).rejects.toThrow();
  });
});

describe("Blob stores in the dashboard API", () => {
  it("connects a store to a project, which then gets BLOB_READ_WRITE_TOKEN", async () => {
    const owner = t.repo.getUserByEmail("admin@example.com")!;
    t.repo.insertProject({
      id: "prj_blob",
      name: "blob-app",
      repoUrl: "https://github.com/example/blob-app",
      productionBranch: "main",
      framework: null,
      installCommand: null,
      buildCommand: null,
      outputDirectory: null,
      rootDirectory: ".",
      autoPromotePaused: false,
      cronsEnabled: true,
      ownerId: owner.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const connect = await t.app.inject({
      method: "PUT",
      url: `/api/blob-stores/${storeId}/connections/blob-app`,
      headers,
      payload: { targets: ["production"] },
    });
    expect(connect.statusCode).toBe(200);
    expect(t.repo.envFor("prj_blob", "production").BLOB_READ_WRITE_TOKEN).toBe(token);
    expect(t.repo.envFor("prj_blob", "preview").BLOB_READ_WRITE_TOKEN).toBeUndefined();

    const custom = await t.app.inject({
      method: "PUT",
      url: `/api/blob-stores/${storeId}/connections/blob-app`,
      headers,
      payload: { targets: ["production", "preview"], envPrefix: "UPLOADS" },
    });
    expect(custom.statusCode).toBe(200);
    expect(t.repo.envFor("prj_blob", "preview").UPLOADS_READ_WRITE_TOKEN).toBe(token);

    const forProject = await t.app.inject({ method: "GET", url: "/api/projects/blob-app/blob-stores", headers });
    expect(forProject.json().connections).toMatchObject([{ store: { id: storeId, name: "Uploads" }, envPrefix: "UPLOADS" }]);

    const listed = await t.app.inject({ method: "GET", url: "/api/blob-stores", headers });
    const store = listed.json().stores[0];
    expect(store.usage.count).toBeGreaterThan(0);
    expect(store.token).toBeUndefined();
  });

  it("rotates the token and deletes the store with its files", async () => {
    const rotated = await t.app.inject({ method: "POST", url: `/api/blob-stores/${storeId}/rotate-token`, headers });
    const newToken = rotated.json().store.token;
    expect(newToken).not.toBe(token);
    await expect(list({ token })).rejects.toThrow();
    expect((await list({ token: newToken })).blobs.length).toBeGreaterThan(0);

    const removed = await t.app.inject({ method: "DELETE", url: `/api/blob-stores/${storeId}`, headers });
    expect(removed.statusCode).toBe(200);
    expect(t.repo.getBlob(storeId, "docs/hello.txt")).toBeUndefined();
    expect(t.repo.envFor("prj_blob", "production").UPLOADS_READ_WRITE_TOKEN).toBeUndefined();
  });
});

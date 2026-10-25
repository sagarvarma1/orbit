import { describe, expect, it } from "vitest";
import { FunctionCache, sharedMaxAge } from "../src/edge/function-cache.js";
import type { FunctionResponse } from "../src/edge/functions.js";

const res = (headers: Record<string, string>, status = 200, body = "x"): FunctionResponse => ({
  status,
  headers,
  body: Buffer.from(body),
});

describe("sharedMaxAge", () => {
  it("uses s-maxage, or CDN-Cache-Control first", () => {
    expect(sharedMaxAge(res({ "cache-control": "public, max-age=31536000, s-maxage=31536000, immutable" }))).toBe(31536000);
    expect(sharedMaxAge(res({ "cache-control": "s-maxage=10, stale-while-revalidate=59" }))).toBe(10);
    expect(sharedMaxAge(res({ "cache-control": "s-maxage=10", "cdn-cache-control": "max-age=99" }))).toBe(99);
    expect(sharedMaxAge(res({ "cache-control": "s-maxage=10", "cdn-cache-control": "no-store" }))).toBe(0);
  });

  it("refuses browser-only, private, cookie-setting, varying and error responses", () => {
    expect(sharedMaxAge(res({ "cache-control": "public, max-age=60" }))).toBe(0);
    expect(sharedMaxAge(res({}))).toBe(0);
    expect(sharedMaxAge(res({ "cache-control": "private, s-maxage=60" }))).toBe(0);
    expect(sharedMaxAge(res({ "cache-control": "s-maxage=60", "set-cookie": "a=b" }))).toBe(0);
    expect(sharedMaxAge(res({ "cache-control": "s-maxage=60", vary: "Cookie" }))).toBe(0);
    expect(sharedMaxAge(res({ "cache-control": "s-maxage=60", vary: "Accept-Encoding" }))).toBe(60);
    expect(sharedMaxAge(res({ "cache-control": "s-maxage=60" }, 500))).toBe(0);
    expect(sharedMaxAge(res({ "cache-control": "s-maxage=60" }, 404))).toBe(60);
  });
});

describe("FunctionCache", () => {
  const cacheable = (body: string) => res({ "cache-control": "s-maxage=10" }, 200, body);

  it("serves hits until the entry expires", async () => {
    let now = 0;
    const cache = new FunctionCache(1024 * 1024, () => now);
    let calls = 0;
    const produce = async () => cacheable(`v${++calls}`);
    expect((await cache.fetch("k", produce)).hit).toBe(false);
    now = 9_000;
    expect(await cache.fetch("k", produce)).toMatchObject({ hit: true, age: 9 });
    now = 10_000;
    const expired = await cache.fetch("k", produce);
    expect(expired.hit).toBe(false);
    expect(expired.response.body.toString()).toBe("v2");
  });

  it("does not keep failures or uncacheable responses", async () => {
    const cache = new FunctionCache(1024 * 1024);
    await expect(cache.fetch("k", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await cache.fetch("k", async () => res({}));
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entries to stay under its byte budget", async () => {
    const cache = new FunctionCache(8 * 1124); // room for 8 entries of 100 bytes (+1024 overhead)
    const body = "y".repeat(100);
    for (let i = 0; i < 8; i++) await cache.fetch(`k${i}`, async () => cacheable(body));
    await cache.fetch("k0", async () => cacheable(body)); // touch k0
    await cache.fetch("k8", async () => cacheable(body));
    expect(cache.size).toBe(8);
    expect((await cache.fetch("k0", async () => cacheable(body))).hit).toBe(true);
    expect((await cache.fetch("k1", async () => cacheable(body))).hit).toBe(false);
  });
});

import type { FunctionResponse } from "./functions.js";

const CACHEABLE_STATUS = new Set([200, 203, 204, 301, 308, 404, 410]);

/**
 * How long a shared cache may keep this response, in seconds (0 = don't cache). Follows Vercel's
 * CDN: `CDN-Cache-Control` wins, otherwise `s-maxage` in `Cache-Control`. Plain `max-age` is for
 * browsers only, so it doesn't count.
 */
export function sharedMaxAge(res: FunctionResponse): number {
  if (!CACHEABLE_STATUS.has(res.status) || res.headers["set-cookie"]) return 0;
  const vary = res.headers["vary"];
  if (vary && vary.split(",").some((v) => v.trim().toLowerCase() !== "accept-encoding")) return 0;

  const cdn = res.headers["cdn-cache-control"];
  const directives = (cdn ?? res.headers["cache-control"] ?? "").toLowerCase();
  if (/(^|[\s,])(private|no-store|no-cache)([\s,=]|$)/.test(directives)) return 0;
  const match = (cdn ? /(?:^|[\s,])(?:s-maxage|max-age)=(\d+)/ : /(?:^|[\s,])s-maxage=(\d+)/).exec(directives);
  return match ? Number(match[1]) : 0;
}

interface Entry {
  response: FunctionResponse;
  expiresAt: number;
  storedAt: number;
  size: number;
}

export interface CachedResult {
  response: FunctionResponse;
  hit: boolean;
  /** Seconds since it was stored (0 on a miss). */
  age: number;
}

/**
 * In-memory LRU of function responses, bounded by bytes. Keys include the deployment ID, and a
 * deployment never changes, so entries never need invalidating: a new deployment just gets new keys.
 * Concurrent misses for the same key share one invocation.
 */
export class FunctionCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<FunctionResponse>>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  async fetch(key: string, produce: () => Promise<FunctionResponse>): Promise<CachedResult> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) {
      // Re-insert to mark as most recently used.
      this.entries.delete(key);
      this.entries.set(key, entry);
      return { response: entry.response, hit: true, age: Math.floor((this.now() - entry.storedAt) / 1000) };
    }
    if (entry) this.remove(key);

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = produce().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
      void pending.then((response) => this.store(key, response)).catch(() => {});
    }
    return { response: await pending, hit: false, age: 0 };
  }

  private store(key: string, response: FunctionResponse): void {
    const ttl = sharedMaxAge(response);
    if (ttl <= 0) return;
    const size = response.body.length + 1024;
    // One huge response shouldn't flush everything else.
    if (size > this.maxBytes / 8) return;
    const now = this.now();
    this.remove(key);
    this.entries.set(key, { response, expiresAt: now + ttl * 1000, storedAt: now, size });
    this.bytes += size;
    for (const [oldest] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.remove(oldest);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.size;
  }
}

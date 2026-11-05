import type { BlobItem } from "./types";

/**
 * The dashboard talks to a store the way apps do: Orbit Blob's (Vercel Blob's) HTTP API with the
 * store's read-write token. Nothing here goes through the control plane's session API.
 */
export class BlobClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "x-api-version": "13", ...init.headers },
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(data.error?.message ?? `Blob API error (${res.status})`);
    return data;
  }

  list(prefix: string, cursor?: string) {
    const params = new URLSearchParams({ mode: "folded", limit: "100" });
    if (prefix) params.set("prefix", prefix);
    if (cursor) params.set("cursor", cursor);
    return this.call<{ blobs: BlobItem[]; folders: string[]; cursor?: string; hasMore: boolean }>(`?${params}`);
  }

  upload(pathname: string, file: Blob, access: "public" | "private", overwrite: boolean) {
    return this.call<{ url: string; pathname: string }>(`/?${new URLSearchParams({ pathname })}`, {
      method: "PUT",
      body: file,
      headers: {
        "x-vercel-blob-access": access,
        "x-content-type": file.type || "application/octet-stream",
        "x-allow-overwrite": overwrite ? "1" : "0",
      },
    });
  }

  delete(urls: string[]) {
    return this.call<object>("/delete", {
      method: "POST",
      body: JSON.stringify({ urls }),
      headers: { "content-type": "application/json" },
    });
  }

  /** Opens a blob in a new tab, private ones included (fetched with the token). */
  async open(url: string): Promise<void> {
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`Couldn't open the file (${res.status})`);
    const objectUrl = URL.createObjectURL(await res.blob());
    window.open(objectUrl, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

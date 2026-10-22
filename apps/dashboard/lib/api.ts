/**
 * Where the control plane lives. Empty means "same origin" (production, behind Caddy, where
 * /api/* is routed to the API); in development the API runs separately on :4000.
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Absolute API origin, for URLs people copy (e.g. the webhook URL). */
export function apiOrigin(): string {
  return API_URL || (typeof window === "undefined" ? "" : window.location.origin);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Pages that work signed out; a 401 anywhere else sends people to sign in. */
const PUBLIC_PAGES = ["/login", "/setup"];

/** Typed JSON client for the Orbit control plane. Sends the session cookie. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "include",
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 && typeof window !== "undefined" && !PUBLIC_PAGES.includes(window.location.pathname)) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data;
}

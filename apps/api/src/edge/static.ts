import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|wasm)|image\/svg\+xml)/;

export function isCompressible(type: string): boolean {
  return COMPRESSIBLE.test(type);
}

/** A build-tool content hash: 8+ chars, mixing digits and letters or upper and lower case. */
function looksLikeHash(token: string): boolean {
  if (token.length < 8) return false;
  const digits = /\d/.test(token);
  const letters = /[a-zA-Z]/.test(token);
  return (digits && letters) || (/[a-z]/.test(token) && /[A-Z]/.test(token));
}

const IMMUTABLE_DIRS = ["/_next/static/", "/_astro/"];

/**
 * Fingerprinted assets (`index-BbW3z1aQ.js`, `main.3f4a5b6c.css`, `/_next/static/...`) can be
 * cached forever: a content change produces a new filename. Everything else revalidates.
 */
export function isImmutableAsset(urlPath: string): boolean {
  if (IMMUTABLE_DIRS.some((dir) => urlPath.startsWith(dir))) return true;
  const base = path.posix.basename(urlPath);
  if (base.endsWith(".html")) return false;
  // "index-BbW3z1aQ.js" -> ["index", "BbW3z1aQ"]; the first token is the human name.
  const tokens = base
    .split(".")
    .slice(0, -1)
    .flatMap((part) => part.split(/[-_]/));
  return tokens.slice(1).some(looksLikeHash);
}

export function cacheControl(urlPath: string, type: string): string {
  if (!type.startsWith("text/html") && isImmutableAsset(urlPath)) return "public, max-age=31536000, immutable";
  return "public, max-age=0, must-revalidate";
}

/** Content under a deployment id never changes, so (deployment, path, encoding) is a perfect ETag. */
export function etag(deploymentId: string, relPath: string, encoding: string): string {
  return `"${createHash("sha1").update(`${deploymentId}:${relPath}:${encoding}`).digest("base64url").slice(0, 27)}"`;
}

export interface ResolveOptions {
  spa: boolean;
  cleanUrls: boolean;
  /** Whether the client is navigating to a page (vs. fetching an asset). */
  isNavigation: boolean;
  /** Fall back to the SPA index and 404.html (default). Off when only files on disk should match. */
  fallbacks?: boolean;
}

export type Resolution =
  { kind: "file"; file: string; relPath: string; status: 200 | 404 } | { kind: "not-found" } | { kind: "bad-request" };

function fileInside(root: string, rel: string): string | null {
  const full = path.join(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null; // traversal
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/**
 * Map a URL path onto a file in an artifact's static dir:
 * exact file -> clean URL (.html) -> directory index -> SPA fallback -> 404.html -> not found.
 */
export function resolveStatic(staticDir: string, rawPath: string, opts: ResolveOptions): Resolution {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { kind: "bad-request" };
  }
  if (decoded.includes("\0")) return { kind: "bad-request" };
  const urlPath = path.posix.normalize(`/${decoded}`);
  const root = path.resolve(staticDir);

  const candidates = urlPath.endsWith("/")
    ? [`${urlPath}index.html`]
    : [urlPath, ...(opts.cleanUrls ? [`${urlPath}.html`] : []), `${urlPath}/index.html`];

  for (const candidate of candidates) {
    const file = fileInside(root, candidate);
    if (file) return { kind: "file", file, relPath: candidate, status: 200 };
  }
  if (opts.fallbacks === false) return { kind: "not-found" };
  if (opts.spa && opts.isNavigation) {
    const index = fileInside(root, "/index.html");
    if (index) return { kind: "file", file: index, relPath: "/index.html", status: 200 };
  }
  const custom404 = fileInside(root, "/404.html");
  if (custom404) return { kind: "file", file: custom404, relPath: "/404.html", status: 404 };
  return { kind: "not-found" };
}

/** Navigations get the SPA fallback; requests for missing assets (`/x.js`) get a real 404. */
export function isNavigationRequest(urlPath: string, accept: string | undefined): boolean {
  if (accept?.includes("text/html")) return true;
  return path.posix.extname(urlPath) === "";
}

import type { RoutingConfig } from "./routing.js";

/** Written once to data/artifacts/<id>/orbit.json when a deployment is published. Never modified. */
export interface DeploymentManifest {
  version: 1;
  deploymentId: string;
  projectId: string;
  framework: string;
  /** Unknown navigations fall back to /index.html. */
  spa: boolean;
  /** /about serves /about.html. */
  cleanUrls: boolean;
  functions: FunctionRoute[];
  /** A server-rendered app (Next.js): the edge serves files from static/ and proxies everything else here. */
  server?: ServerConfig;
  /** Redirects, rewrites and headers from the repo's vercel.json (absent when it has none). */
  routing?: RoutingConfig;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
}

export interface ServerConfig {
  /** Entry script relative to the artifact dir, e.g. "server/server.js" or "server/apps/web/server.js". */
  entry: string;
}

export interface FunctionRoute {
  /** e.g. "/api/hello" or "/api/users/[id]". */
  route: string;
  /** Bundle path relative to the artifact dir, e.g. "functions/api/hello.mjs". */
  file: string;
  /** From vercel.json `functions` (capped by the server); otherwise the server defaults apply. */
  memoryMb?: number;
  maxDurationMs?: number;
}

export const MANIFEST_FILE = "orbit.json";
export const STATIC_DIR = "static";
export const FUNCTIONS_DIR = "functions";
export const SERVER_DIR = "server";
/** Per-deployment writable state (the Next.js cache), outside the immutable artifact: <dataDir>/runtime/<id>/. */
export const RUNTIME_DIR = "runtime";
/** Env vars snapshotted at build time for functions (env changes apply on the next deployment). */
export const FUNCTION_ENV_FILE = "function-env.json";

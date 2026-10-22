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
  /** Redirects, rewrites and headers from the repo's vercel.json (absent when it has none). */
  routing?: RoutingConfig;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
}

export interface FunctionRoute {
  /** e.g. "/api/hello" or "/api/users/[id]". */
  route: string;
  /** Bundle path relative to the artifact dir, e.g. "functions/hello.mjs". */
  file: string;
}

export const MANIFEST_FILE = "orbit.json";
export const STATIC_DIR = "static";
export const FUNCTIONS_DIR = "functions";
/** Env vars snapshotted at build time for functions (env changes apply on the next deployment). */
export const FUNCTION_ENV_FILE = "function-env.json";

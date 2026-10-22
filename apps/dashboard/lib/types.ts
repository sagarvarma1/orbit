export type DeploymentStatus = "queued" | "building" | "ready" | "error" | "canceled";
export type EnvTarget = "production" | "preview";
export type FrameworkId = "nextjs" | "astro" | "create-react-app" | "vite" | "node" | "static";

export interface Deployment {
  id: string;
  projectId: string;
  target: "production" | "preview";
  branch: string;
  ref: string;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  status: DeploymentStatus;
  trigger: "import" | "redeploy" | "webhook" | "poll" | "manual";
  framework: FrameworkId | null;
  errorMessage: string | null;
  builder: string | null;
  useCache: boolean;
  cacheStatus: "hit" | "miss" | "skipped" | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  url: string;
  isCurrentProduction: boolean;
  durationMs: number | null;
  queuePosition: number | null;
}

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  productionBranch: string;
  framework: FrameworkId | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  rootDirectory: string;
  autoPromotePaused: boolean;
  createdAt: number;
  updatedAt: number;
  productionUrl: string;
  production: Deployment | null;
  latestDeployment: Deployment | null;
}

export interface Alias {
  hostname: string;
  deploymentId: string;
  kind: "production" | "branch";
  url: string;
}

export interface EnvVar {
  key: string;
  value: string;
  targets: EnvTarget[];
  updatedAt: number;
}

export interface LogLine {
  seq: number;
  t: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface FrameworkPreset {
  id: FrameworkId;
  name: string;
  outputDirectory: string;
  spa: boolean;
  cleanUrls: boolean;
}

export interface BuildSettings {
  framework: FrameworkId;
  frameworkName: string;
  packageManager: "npm" | "pnpm" | "yarn" | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string;
  warnings: string[];
}

export interface InspectResult {
  repoUrl: string;
  fullName: string | null;
  suggestedName: string;
  defaultBranch: string;
  branches: string[];
  branch: string;
  commit: { sha: string; message: string; author: string };
  settings: BuildSettings;
  hasFunctions: boolean;
  presets: FrameworkPreset[];
}

export interface PlatformConfig {
  rootDomain: string;
  protocol: string;
  edgePort: string;
  builder: string;
  queue: { running: number; queued: number; concurrency: number };
  webhookConfigured: boolean;
  githubConfigured: boolean;
  buildCache: boolean;
  gitPollIntervalSeconds: number;
  presets: FrameworkPreset[];
}

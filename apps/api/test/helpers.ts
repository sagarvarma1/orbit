import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { LogStore } from "../src/build/logs.js";
import { ProcessRunner } from "../src/build/runner.js";
import { config, type Config } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { AuthService } from "../src/services/auth.js";
import { DeploymentService } from "../src/services/deployments.js";
import { GitSync } from "../src/services/git-sync.js";
import { GitHubApp } from "../src/services/github-app.js";

export interface TestApp {
  app: FastifyInstance;
  repo: Repo;
  auth: AuthService;
  githubApp: GitHubApp;
  config: Config;
  dir: string;
  close(): Promise<void>;
}

/** A real control plane on a throwaway data dir, for app.inject() tests. */
export async function testApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-"));
  const cfg: Config = {
    ...config,
    dataDir: dir,
    dbPath: path.join(dir, "orbit.db"),
    artifactsDir: path.join(dir, "artifacts"),
    logsDir: path.join(dir, "logs"),
    buildsDir: path.join(dir, "builds"),
    cacheDir: path.join(dir, "cache"),
    dashboardUrl: "http://localhost:3000",
    githubToken: "",
    gitPollIntervalSeconds: 0,
    ...overrides,
  };
  const repo = new Repo(openDb(cfg.dbPath));
  const logs = new LogStore(cfg.logsDir);
  const deployments = new DeploymentService(repo, logs, new ProcessRunner(), cfg);
  const auth = new AuthService(repo);
  const githubApp = new GitHubApp(repo, cfg);
  const app = await buildApp({
    config: cfg,
    repo,
    logs,
    deployments,
    git: new GitSync(repo, deployments, githubApp),
    auth,
    githubApp,
  });
  await app.ready();
  return {
    app,
    repo,
    auth,
    githubApp,
    config: cfg,
    dir,
    async close() {
      await app.close();
      await deployments.queue.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The session cookie value from a response's set-cookie header. */
export function sessionFrom(res: { headers: Record<string, unknown> }): string {
  const header = String(res.headers["set-cookie"] ?? "");
  return /orbit_session=([^;]*)/.exec(header)?.[1] ?? "";
}

/** Creates the admin and returns Bearer headers for API calls. */
export async function adminHeaders(t: TestApp): Promise<Record<string, string>> {
  await t.auth.init({ email: "admin@example.com", password: "a-long-password" });
  const user = t.repo.getUserByEmail("admin@example.com")!;
  return { authorization: `Bearer ${t.auth.createApiToken(user.id, "test").token}` };
}

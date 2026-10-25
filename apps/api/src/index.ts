/**
 * Control plane: REST API + SSE, webhook receiver, git poller and the build queue.
 * The edge (src/edge.ts) is a separate process that only reads state and artifacts.
 */
import fs from "node:fs";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { LogStore } from "./build/logs.js";
import { createRunner } from "./build/runner.js";
import { openDb } from "./db/index.js";
import { Repo } from "./db/repo.js";
import { lockDataDir } from "./lib/sandbox.js";
import { DeploymentService } from "./services/deployments.js";
import { GitSync } from "./services/git-sync.js";
import { AuthService } from "./services/auth.js";
import { GitHubNotifier } from "./services/github.js";
import { GitHubApp } from "./services/github-app.js";

async function main(): Promise<void> {
  for (const dir of [config.artifactsDir, config.logsDir, config.buildsDir, config.cacheDir])
    fs.mkdirSync(dir, { recursive: true });

  const repo = new Repo(openDb(config.dbPath));
  // Deployment code runs as unprivileged users on Linux; it must not read the database, logs or caches.
  lockDataDir(config);
  const logs = new LogStore(config.logsDir);
  const runner = await createRunner(config);
  const githubApp = new GitHubApp(repo, config);
  const github = new GitHubNotifier({ token: config.githubToken, apiUrl: config.githubApiUrl, app: githubApp });
  const deployments = new DeploymentService(repo, logs, runner, config, github, githubApp);
  const git = new GitSync(repo, deployments, githubApp);
  const auth = new AuthService(repo);
  const setupCode = await auth.init({
    email: config.adminEmail,
    password: config.adminPassword,
    resetPassword: config.resetAdminPassword,
  });

  const app = await buildApp({ config, repo, logs, deployments, git, auth, githubApp });
  deployments.recover();
  git.startPolling(config.gitPollIntervalSeconds);

  await app.listen({ port: config.apiPort, host: config.host });
  app.log.info(`Orbit control plane on :${config.apiPort} · builder: ${runner.description} · data: ${config.dataDir}`);
  if (config.gitPollIntervalSeconds > 0) app.log.info(`Git poller every ${config.gitPollIntervalSeconds}s`);
  if (githubApp.configured) app.log.info(`GitHub App connected: ${githubApp.credentials!.slug}`);
  else if (github.enabled) app.log.info("GitHub commit statuses and PR comments enabled (personal access token)");
  if (setupCode) {
    // Plain console output so it stands out and install.sh can find it.
    console.log(
      `\n  No admin account yet. Open ${config.dashboardUrl}/setup and enter this setup code:\n\n    ORBIT SETUP CODE: ${setupCode}\n`,
    );
  }

  const shutdown = async () => {
    git.stopPolling();
    await deployments.queue.shutdown();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
import { DeploymentService } from "./services/deployments.js";
import { GitSync } from "./services/git-sync.js";
import { GitHubNotifier } from "./services/github.js";

async function main(): Promise<void> {
  for (const dir of [config.artifactsDir, config.logsDir, config.buildsDir, config.cacheDir])
    fs.mkdirSync(dir, { recursive: true });

  const repo = new Repo(openDb(config.dbPath));
  const logs = new LogStore(config.logsDir);
  const runner = await createRunner(config);
  const github = new GitHubNotifier({ token: config.githubToken, apiUrl: config.githubApiUrl });
  const deployments = new DeploymentService(repo, logs, runner, config, github);
  const git = new GitSync(repo, deployments);

  const app = await buildApp({ config, repo, logs, deployments, git });
  deployments.recover();
  git.startPolling(config.gitPollIntervalSeconds);

  await app.listen({ port: config.apiPort, host: config.host });
  app.log.info(`Orbit control plane on :${config.apiPort} · builder: ${runner.description} · data: ${config.dataDir}`);
  if (config.gitPollIntervalSeconds > 0) app.log.info(`Git poller every ${config.gitPollIntervalSeconds}s`);
  if (github.enabled) app.log.info("GitHub commit statuses and PR comments enabled");

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

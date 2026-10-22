import type { Config } from "../config.js";
import type { Deployment, DeploymentTrigger, Project, Repo } from "../db/repo.js";
import { BuildError, runBuild } from "../build/pipeline.js";
import { BuildCanceledError, BuildInterruptedError, BuildQueue, BuildTimeoutError } from "../build/queue.js";
import type { LogStore } from "../build/logs.js";
import type { GitCredentials } from "../build/git.js";
import type { CommandRunner } from "../build/runner.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { newDeploymentId } from "../lib/ids.js";
import { branchAliasLabel, publicUrl } from "../lib/urls.js";
import type { DeploymentLinks, GitHubNotifier, GitHubState } from "./github.js";

export interface CreateDeploymentInput {
  branch: string;
  /** Branch name, or an exact commit SHA to pin (webhooks, redeploys). Defaults to the branch. */
  ref?: string;
  trigger: DeploymentTrigger;
  commit?: { sha: string; message?: string | null; author?: string | null };
  /** false skips restoring the build cache (the result is still saved for next time). */
  useCache?: boolean;
}

/**
 * Owns the deployment lifecycle: create -> queue -> build -> ready/error/canceled, plus
 * production alias management (auto-assign, promote, instant rollback).
 */
export class DeploymentService {
  readonly queue: BuildQueue;

  constructor(
    private readonly repo: Repo,
    private readonly logs: LogStore,
    private readonly runner: CommandRunner,
    private readonly config: Config,
    private readonly github: GitHubNotifier | null = null,
    private readonly credentials: GitCredentials | null = null,
  ) {
    this.queue = new BuildQueue((id, signal) => this.build(id, signal), config.buildConcurrency, config.buildTimeoutSeconds);
  }

  get builderDescription(): string {
    return this.runner.description;
  }

  create(project: Project, input: CreateDeploymentInput): Deployment {
    const deployment: Deployment = {
      id: newDeploymentId(),
      projectId: project.id,
      target: input.branch === project.productionBranch ? "production" : "preview",
      branch: input.branch,
      ref: input.ref ?? input.branch,
      commitSha: input.commit?.sha ?? null,
      commitMessage: input.commit?.message ?? null,
      commitAuthor: input.commit?.author ?? null,
      status: "queued",
      trigger: input.trigger,
      framework: null,
      errorMessage: null,
      builder: null,
      useCache: input.useCache ?? true,
      cacheStatus: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.repo.insertDeployment(deployment);
    this.repo.touchProject(project.id);
    this.queue.enqueue(deployment.id);
    return deployment;
  }

  /** Rebuild the exact commit of an existing deployment (same branch and target). */
  redeploy(source: Deployment, options: { useCache?: boolean } = {}): Deployment {
    const project = this.requireProject(source.projectId);
    return this.create(project, {
      branch: source.branch,
      ref: source.commitSha ?? source.ref,
      trigger: "redeploy",
      useCache: options.useCache,
      commit: source.commitSha
        ? { sha: source.commitSha, message: source.commitMessage, author: source.commitAuthor }
        : undefined,
    });
  }

  cancel(id: string): Deployment {
    const deployment = this.requireDeployment(id);
    if (deployment.status !== "queued" && deployment.status !== "building") {
      throw new ConflictError(`Deployment is ${deployment.status}; only queued or building deployments can be canceled`);
    }
    const result = this.queue.cancel(id);
    if (result !== "aborted") {
      // Never started (or orphaned): finish it here. A running build finishes in build().
      this.repo.updateDeployment(id, { status: "canceled", finishedAt: Date.now() });
      this.logs.open(id);
      this.logs.system(id, "Build canceled before it started");
      void this.logs.close(id, "canceled");
    }
    return this.requireDeployment(id);
  }

  promote(id: string): Deployment {
    const deployment = this.requireDeployment(id);
    if (deployment.status !== "ready") throw new ConflictError("Only ready deployments can be promoted");
    const project = this.requireProject(deployment.projectId);
    this.repo.switchProduction(project, deployment.id, "promote");
    return deployment;
  }

  /** Point production back at an earlier deployment (default: the one before current). No rebuild. */
  rollback(project: Project, deploymentId?: string): Deployment {
    const current = this.repo.productionDeploymentId(project.id);
    let targetId = deploymentId;
    if (!targetId) {
      const history = this.repo.productionHistory(project.id);
      targetId = history.find((id) => id !== current && this.repo.getDeployment(id)?.status === "ready");
      if (!targetId) throw new ConflictError("There is no previous production deployment to roll back to");
    }
    const target = this.requireDeployment(targetId);
    if (target.projectId !== project.id) throw new NotFoundError("Deployment not found in this project");
    if (target.status !== "ready") throw new ConflictError("Can only roll back to a ready deployment");
    if (target.id === current) throw new ConflictError("That deployment is already serving production");
    this.repo.switchProduction(project, target.id, "rollback");
    return target;
  }

  /** On boot: builds that were running when we died are failed; queued ones run again. */
  recover(): void {
    for (const d of this.repo.listDeploymentsByStatus(["building"])) {
      this.repo.updateDeployment(d.id, {
        status: "error",
        errorMessage: "Interrupted by a control plane restart",
        finishedAt: Date.now(),
      });
    }
    for (const d of this.repo.listDeploymentsByStatus(["queued"])) this.queue.enqueue(d.id);
  }

  private async build(id: string, signal: AbortSignal): Promise<void> {
    const deployment = this.repo.getDeployment(id);
    if (!deployment || deployment.status !== "queued") return;
    const project = this.repo.getProject(deployment.projectId);
    if (!project) return;

    this.logs.open(id);
    this.repo.updateDeployment(id, { status: "building", startedAt: Date.now(), builder: this.runner.kind });
    this.logs.system(id, `Build started for ${project.name} (${deployment.target}) · deployment ${id}`);

    let status: Deployment["status"];
    try {
      await runBuild({
        deployment,
        project,
        env: this.repo.envFor(project.id, deployment.target),
        url: publicUrl(this.config, deployment.id),
        runner: this.runner,
        gitToken: await this.credentials?.tokenFor(project.repoUrl),
        config: this.config,
        signal,
        log: {
          system: (message) => this.logs.system(id, message),
          write: (stream, chunk) => this.logs.write(id, stream, chunk),
        },
        onCommit: (commit) => {
          this.repo.updateDeployment(id, { commitSha: commit.sha, commitMessage: commit.message, commitAuthor: commit.author });
          void this.reportToGitHub(id, "building");
        },
        onSettings: (settings) => this.repo.updateDeployment(id, { framework: settings.framework }),
        onCache: (cacheStatus) => this.repo.updateDeployment(id, { cacheStatus }),
      });
      status = "ready";
      this.repo.updateDeployment(id, { status, finishedAt: Date.now() });
      this.assignAliases(project, this.requireDeployment(id));
    } catch (err) {
      const reason = signal.aborted ? signal.reason : err;
      status = reason instanceof BuildCanceledError ? "canceled" : "error";
      const expected = [BuildError, BuildCanceledError, BuildTimeoutError, BuildInterruptedError].some(
        (cls) => reason instanceof cls,
      );
      const message = expected ? (reason as Error).message : `Internal error: ${(reason as Error)?.message ?? String(reason)}`;
      if (!expected) console.error(`[build ${id}]`, reason);
      this.logs.system(id, status === "canceled" ? "Build canceled" : `Error: ${message}`);
      this.repo.updateDeployment(id, { status, errorMessage: status === "error" ? message : null, finishedAt: Date.now() });
    }
    // Before closing the log, so GitHub problems show up in it. Bounded so GitHub can't hold up a build.
    await Promise.race([this.reportToGitHub(id, status), new Promise((r) => setTimeout(r, 15_000).unref())]);
    await this.logs.close(id, status);
  }

  /** A pull request was opened for a branch that may already be deployed: post its current state. */
  reportPullRequest(project: Project, branch: string): Promise<void> {
    const latest = this.repo.listDeployments(project.id, 50).find((d) => d.branch === branch);
    if (!latest) return Promise.resolve();
    const state: GitHubState = latest.status === "queued" || latest.status === "building" ? "building" : latest.status;
    return this.reportToGitHub(latest.id, state);
  }

  links(project: Project, deployment: Deployment): DeploymentLinks {
    return {
      preview: publicUrl(this.config, deployment.id),
      branch: publicUrl(this.config, branchAliasLabel(project.name, deployment.branch)),
      inspect: `${this.config.dashboardUrl}/${project.name}/deployments/${deployment.id}`,
    };
  }

  private reportToGitHub(id: string, state: GitHubState): Promise<void> {
    if (!this.github?.enabled) return Promise.resolve();
    const deployment = this.repo.getDeployment(id);
    const project = deployment && this.repo.getProject(deployment.projectId);
    if (!deployment || !project) return Promise.resolve();
    const log = (message: string) =>
      this.logs.isActive(id) ? this.logs.system(id, message) : console.log(`[github ${id}] ${message}`);
    return this.github.notify(project, deployment, state, this.links(project, deployment), log);
  }

  private assignAliases(project: Project, deployment: Deployment): void {
    const fresh = this.requireProject(project.id);
    const branchLabel = branchAliasLabel(fresh.name, deployment.branch);
    this.repo.setAlias({ hostname: branchLabel, projectId: fresh.id, deploymentId: deployment.id, kind: "branch" });
    this.logs.system(deployment.id, `Branch alias: ${publicUrl(this.config, branchLabel)}`);

    if (deployment.target !== "production") return;
    const hasProduction = this.repo.productionDeploymentId(fresh.id) !== null;
    if (fresh.autoPromotePaused && hasProduction) {
      this.logs.system(
        deployment.id,
        "Production domain not assigned: auto-promotion is paused after a rollback. Promote manually.",
      );
      return;
    }
    this.repo.switchProduction(fresh, deployment.id, "auto");
    this.logs.system(deployment.id, `Assigned production domain: ${publicUrl(this.config, fresh.name)}`);
  }

  private requireDeployment(id: string): Deployment {
    const d = this.repo.getDeployment(id);
    if (!d) throw new NotFoundError("Deployment not found");
    return d;
  }

  private requireProject(id: string): Project {
    const p = this.repo.getProject(id);
    if (!p) throw new NotFoundError("Project not found");
    return p;
  }
}

import type { Config } from "./config.js";
import type { Deployment, Project, Repo } from "./db/repo.js";
import type { LogStore } from "./build/logs.js";
import type { DeploymentService } from "./services/deployments.js";
import type { Access } from "./services/access.js";
import type { AuthService, PublicUser } from "./services/auth.js";
import type { GitHubApp } from "./services/github-app.js";
import type { GitSync } from "./services/git-sync.js";
import { NotFoundError } from "./lib/errors.js";
import { publicUrl } from "./lib/urls.js";

/** Everything route handlers need, wired once in index.ts. */
export interface AppContext {
  config: Config;
  repo: Repo;
  logs: LogStore;
  deployments: DeploymentService;
  git: GitSync;
  auth: AuthService;
  githubApp: GitHubApp;
  access: Access;
}

/** A project the user may see. Other accounts' projects look exactly like missing ones. */
export function requireProject(ctx: AppContext, idOrName: string, user: PublicUser | null): Project {
  const project = ctx.repo.getProject(idOrName);
  if (!project || !user || !ctx.access.canSee(user, project)) throw new NotFoundError(`Project "${idOrName}" not found`);
  return project;
}

export function requireDeployment(ctx: AppContext, id: string, user: PublicUser | null): Deployment {
  const deployment = ctx.repo.getDeployment(id);
  const project = deployment && ctx.repo.getProject(deployment.projectId);
  if (!deployment || !project || !user || !ctx.access.canSee(user, project)) {
    throw new NotFoundError(`Deployment "${id}" not found`);
  }
  return deployment;
}

export function serializeDeployment(ctx: AppContext, d: Deployment, productionId?: string | null) {
  const prodId = productionId === undefined ? ctx.repo.productionDeploymentId(d.projectId) : productionId;
  return {
    ...d,
    url: publicUrl(ctx.config, d.id),
    isCurrentProduction: prodId === d.id,
    durationMs: d.startedAt ? (d.finishedAt ?? Date.now()) - d.startedAt : null,
    queuePosition: d.status === "queued" ? ctx.deployments.queue.position(d.id) : null,
  };
}

export function serializeProject(ctx: AppContext, p: Project) {
  const productionId = ctx.repo.productionDeploymentId(p.id);
  const production = productionId ? ctx.repo.getDeployment(productionId) : undefined;
  const latest = ctx.repo.listDeployments(p.id, 1)[0];
  return {
    ...p,
    productionUrl: publicUrl(ctx.config, p.name),
    customDomains: ctx.repo
      .listDomains(p.id)
      .map((d) => ({ hostname: d.hostname, branch: d.branch, url: `${ctx.config.publicProtocol}://${d.hostname}` })),
    production: production ? serializeDeployment(ctx, production, productionId) : null,
    latestDeployment: latest ? serializeDeployment(ctx, latest, productionId) : null,
  };
}

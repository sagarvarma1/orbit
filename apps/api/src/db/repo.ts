import type { Db } from "./index.js";
import { transaction } from "./index.js";
import type { FrameworkId } from "../build/detect.js";

export type DeploymentStatus = "queued" | "building" | "ready" | "error" | "canceled";
export type DeploymentTarget = "production" | "preview";
export type DeploymentTrigger = "import" | "redeploy" | "webhook" | "poll" | "manual";
export type EnvTarget = "production" | "preview";
/** hit: node_modules restored and install skipped. miss: installed from scratch. skipped: not cacheable or disabled. */
export type CacheStatus = "hit" | "miss" | "skipped";

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  productionBranch: string;
  /** null = auto-detect at build time. */
  framework: FrameworkId | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  rootDirectory: string;
  autoPromotePaused: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EnvVar {
  key: string;
  value: string;
  targets: EnvTarget[];
  updatedAt: number;
}

export interface Deployment {
  id: string;
  projectId: string;
  target: DeploymentTarget;
  branch: string;
  ref: string;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  framework: string | null;
  errorMessage: string | null;
  builder: string | null;
  /** false for "redeploy without cache". */
  useCache: boolean;
  cacheStatus: CacheStatus | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Alias {
  hostname: string;
  projectId: string;
  deploymentId: string;
  kind: "production" | "branch";
  updatedAt: number;
}

type Row = Record<string, unknown>;

const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  repoUrl: r.repo_url as string,
  productionBranch: r.production_branch as string,
  framework: (r.framework as FrameworkId | null) ?? null,
  installCommand: (r.install_command as string | null) ?? null,
  buildCommand: (r.build_command as string | null) ?? null,
  outputDirectory: (r.output_directory as string | null) ?? null,
  rootDirectory: (r.root_directory as string) ?? "",
  autoPromotePaused: Boolean(r.auto_promote_paused),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toDeployment = (r: Row): Deployment => ({
  id: r.id as string,
  projectId: r.project_id as string,
  target: r.target as DeploymentTarget,
  branch: r.branch as string,
  ref: r.ref as string,
  commitSha: (r.commit_sha as string | null) ?? null,
  commitMessage: (r.commit_message as string | null) ?? null,
  commitAuthor: (r.commit_author as string | null) ?? null,
  status: r.status as DeploymentStatus,
  trigger: r.trigger as DeploymentTrigger,
  framework: (r.framework as string | null) ?? null,
  errorMessage: (r.error_message as string | null) ?? null,
  builder: (r.builder as string | null) ?? null,
  useCache: r.use_cache === undefined ? true : Boolean(r.use_cache),
  cacheStatus: (r.cache_status as CacheStatus | null) ?? null,
  createdAt: Number(r.created_at),
  startedAt: r.started_at == null ? null : Number(r.started_at),
  finishedAt: r.finished_at == null ? null : Number(r.finished_at),
});

const toAlias = (r: Row): Alias => ({
  hostname: r.hostname as string,
  projectId: r.project_id as string,
  deploymentId: r.deployment_id as string,
  kind: r.kind as Alias["kind"],
  updatedAt: Number(r.updated_at),
});

/** Thin, typed data-access layer. All SQL lives here. */
export class Repo {
  constructor(readonly db: Db) {}

  // ---------------------------------------------------------------- projects

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as Row[]).map(toProject);
  }

  getProject(idOrName: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? OR name = ?").get(idOrName, idOrName) as Row | undefined;
    return row ? toProject(row) : undefined;
  }

  insertProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repo_url, production_branch, framework, install_command, build_command,
           output_directory, root_directory, auto_promote_paused, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.name,
        p.repoUrl,
        p.productionBranch,
        p.framework,
        p.installCommand,
        p.buildCommand,
        p.outputDirectory,
        p.rootDirectory,
        p.autoPromotePaused ? 1 : 0,
        p.createdAt,
        p.updatedAt,
      );
  }

  updateProject(id: string, patch: Partial<Omit<Project, "id" | "createdAt">>): void {
    const columns: Record<string, string> = {
      name: "name",
      repoUrl: "repo_url",
      productionBranch: "production_branch",
      framework: "framework",
      installCommand: "install_command",
      buildCommand: "build_command",
      outputDirectory: "output_directory",
      rootDirectory: "root_directory",
      autoPromotePaused: "auto_promote_paused",
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      const value = patch[key as keyof typeof patch];
      sets.push(`${column} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : ((value ?? null) as string | number | null));
    }
    sets.push("updated_at = ?");
    values.push(Date.now());
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  touchProject(id: string): void {
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ---------------------------------------------------------------- env vars

  listEnv(projectId: string): EnvVar[] {
    const rows = this.db.prepare("SELECT * FROM env_vars WHERE project_id = ? ORDER BY key").all(projectId) as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      value: r.value as string,
      targets: String(r.targets).split(",").filter(Boolean) as EnvTarget[],
      updatedAt: Number(r.updated_at),
    }));
  }

  upsertEnv(projectId: string, key: string, value: string, targets: EnvTarget[]): void {
    this.db
      .prepare(
        `INSERT INTO env_vars (project_id, key, value, targets, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, targets = excluded.targets,
           updated_at = excluded.updated_at`,
      )
      .run(projectId, key, value, targets.join(","), Date.now());
  }

  deleteEnv(projectId: string, key: string): boolean {
    return this.db.prepare("DELETE FROM env_vars WHERE project_id = ? AND key = ?").run(projectId, key).changes > 0;
  }

  /** Env vars that apply to a deployment target, as a plain object. */
  envFor(projectId: string, target: DeploymentTarget): Record<string, string> {
    const env: Record<string, string> = {};
    for (const v of this.listEnv(projectId)) if (v.targets.includes(target)) env[v.key] = v.value;
    return env;
  }

  // ------------------------------------------------------------- deployments

  insertDeployment(d: Deployment): void {
    this.db
      .prepare(
        `INSERT INTO deployments (id, project_id, target, branch, ref, commit_sha, commit_message, commit_author,
           status, trigger, framework, error_message, builder, use_cache, cache_status, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.projectId,
        d.target,
        d.branch,
        d.ref,
        d.commitSha,
        d.commitMessage,
        d.commitAuthor,
        d.status,
        d.trigger,
        d.framework,
        d.errorMessage,
        d.builder,
        d.useCache ? 1 : 0,
        d.cacheStatus,
        d.createdAt,
        d.startedAt,
        d.finishedAt,
      );
  }

  getDeployment(id: string): Deployment | undefined {
    const row = this.db.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as Row | undefined;
    return row ? toDeployment(row) : undefined;
  }

  listDeployments(projectId: string, limit = 100): Deployment[] {
    const rows = this.db
      .prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(projectId, limit) as Row[];
    return rows.map(toDeployment);
  }

  listDeploymentsByStatus(statuses: DeploymentStatus[]): Deployment[] {
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM deployments WHERE status IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...statuses) as Row[];
    return rows.map(toDeployment);
  }

  updateDeployment(id: string, patch: Partial<Omit<Deployment, "id" | "projectId">>): void {
    const columns: Record<string, string> = {
      status: "status",
      commitSha: "commit_sha",
      commitMessage: "commit_message",
      commitAuthor: "commit_author",
      framework: "framework",
      errorMessage: "error_message",
      builder: "builder",
      cacheStatus: "cache_status",
      startedAt: "started_at",
      finishedAt: "finished_at",
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push((patch[key as keyof typeof patch] ?? null) as string | number | null);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE deployments SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  // ----------------------------------------------------------------- aliases

  getAlias(hostname: string): Alias | undefined {
    const row = this.db.prepare("SELECT * FROM aliases WHERE hostname = ?").get(hostname) as Row | undefined;
    return row ? toAlias(row) : undefined;
  }

  listAliases(projectId: string): Alias[] {
    return (this.db.prepare("SELECT * FROM aliases WHERE project_id = ?").all(projectId) as Row[]).map(toAlias);
  }

  productionDeploymentId(projectId: string): string | null {
    const row = this.db
      .prepare("SELECT deployment_id FROM aliases WHERE project_id = ? AND kind = 'production'")
      .get(projectId) as Row | undefined;
    return row ? (row.deployment_id as string) : null;
  }

  setAlias(alias: Omit<Alias, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO aliases (hostname, project_id, deployment_id, kind, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(hostname) DO UPDATE SET deployment_id = excluded.deployment_id, updated_at = excluded.updated_at`,
      )
      .run(alias.hostname, alias.projectId, alias.deploymentId, alias.kind, Date.now());
  }

  /**
   * Point the production alias at a deployment and record the event, atomically.
   * This is the whole of "promote" and "instant rollback": one row changes.
   */
  switchProduction(project: Project, deploymentId: string, action: "auto" | "promote" | "rollback"): void {
    transaction(this.db, () => {
      this.setAlias({ hostname: project.name, projectId: project.id, deploymentId, kind: "production" });
      this.db
        .prepare("INSERT INTO alias_events (project_id, deployment_id, action, created_at) VALUES (?, ?, ?, ?)")
        .run(project.id, deploymentId, action, Date.now());
      // Like Vercel: after an instant rollback, new production-branch deployments stop
      // auto-assigning the domain until someone explicitly promotes again.
      if (action === "rollback") this.updateProject(project.id, { autoPromotePaused: true });
      else if (action === "promote") this.updateProject(project.id, { autoPromotePaused: false });
      else this.touchProject(project.id);
    });
  }

  /** Production deployments in the order they were assigned, newest first, de-duplicated. */
  productionHistory(projectId: string): string[] {
    const rows = this.db
      .prepare("SELECT deployment_id FROM alias_events WHERE project_id = ? ORDER BY id DESC")
      .all(projectId) as Row[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
      const id = r.deployment_id as string;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ branch heads

  getBranchHeads(projectId: string): Map<string, string> {
    const rows = this.db.prepare("SELECT branch, sha FROM branch_heads WHERE project_id = ?").all(projectId) as Row[];
    return new Map(rows.map((r) => [r.branch as string, r.sha as string]));
  }

  setBranchHead(projectId: string, branch: string, sha: string): void {
    this.db
      .prepare(
        `INSERT INTO branch_heads (project_id, branch, sha) VALUES (?, ?, ?)
         ON CONFLICT(project_id, branch) DO UPDATE SET sha = excluded.sha`,
      )
      .run(projectId, branch, sha);
  }
}

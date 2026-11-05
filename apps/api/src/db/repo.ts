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
  /** Whether the production deployment's cron jobs run. */
  cronsEnabled: boolean;
  /** The user who owns the project; only they (and admins) can see or change it. */
  ownerId: string | null;
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

export interface Domain {
  hostname: string;
  projectId: string;
  /** null = production; otherwise the latest deployment of this branch. */
  branch: string | null;
  createdAt: number;
}

export type CronRunStatus = "running" | "success" | "error";

export interface CronRun {
  id: number;
  projectId: string;
  deploymentId: string;
  path: string;
  schedule: string;
  trigger: "schedule" | "manual";
  /** The minute the run was for (manual runs: when "Run" was pressed). */
  scheduledAt: number;
  startedAt: number;
  finishedAt: number | null;
  status: CronRunStatus;
  statusCode: number | null;
  durationMs: number | null;
  /** The start of the response body, or the error. */
  output: string | null;
}

export interface BlobStore {
  id: string;
  ownerId: string | null;
  name: string;
  /** The secret half of the read-write token. */
  secret: string;
  createdAt: number;
}

export interface BlobConnection {
  storeId: string;
  projectId: string;
  targets: EnvTarget[];
  envPrefix: string;
  createdAt: number;
}

export interface BlobRecord {
  storeId: string;
  pathname: string;
  /** File name on disk under the store's directory. */
  object: string;
  size: number;
  contentType: string;
  cacheMaxAge: number;
  access: "public" | "private";
  etag: string;
  uploadedAt: number;
}

/** Vercel's read-write token format, so the @vercel/blob SDK finds the store ID in it. */
export const blobToken = (store: Pick<BlobStore, "id" | "secret">) => `vercel_blob_rw_${store.id}_${store.secret}`;

export type UserRole = "admin" | "member";

/** A GitHub user-to-server token (they expire after 8 hours; the refresh token lasts months). */
export interface GitHubUserToken {
  accessToken: string;
  /** null when the GitHub App doesn't expire user tokens. */
  expiresAt: number | null;
  refreshToken: string | null;
}

export interface User {
  id: string;
  email: string;
  /** Empty for accounts that only sign in with GitHub. */
  passwordHash: string;
  role: UserRole;
  githubId: number | null;
  githubLogin: string | null;
  name: string | null;
  avatarUrl: string | null;
  githubToken: GitHubUserToken | null;
  createdAt: number;
}

export interface GitHubProfile {
  githubId: number;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  /** First characters of the token, so people can tell tokens apart. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

type Row = Record<string, unknown>;

const toDomain = (r: Row): Domain => ({
  hostname: r.hostname as string,
  projectId: r.project_id as string,
  branch: (r.branch as string | null) ?? null,
  createdAt: Number(r.created_at),
});

const toUser = (r: Row): User => ({
  id: r.id as string,
  email: r.email as string,
  passwordHash: r.password_hash as string,
  role: r.role === "admin" ? "admin" : "member",
  githubId: r.github_id == null ? null : Number(r.github_id),
  githubLogin: (r.github_login as string | null) ?? null,
  name: (r.name as string | null) ?? null,
  avatarUrl: (r.avatar_url as string | null) ?? null,
  githubToken: r.github_token ? (JSON.parse(r.github_token as string) as GitHubUserToken) : null,
  createdAt: Number(r.created_at),
});

const toApiToken = (r: Row): ApiToken => ({
  id: r.id as string,
  userId: r.user_id as string,
  name: r.name as string,
  prefix: r.prefix as string,
  createdAt: Number(r.created_at),
  lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
});

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
  cronsEnabled: r.crons_enabled === undefined ? true : Boolean(r.crons_enabled),
  ownerId: (r.owner_id as string | null) ?? null,
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

const toCronRun = (r: Row): CronRun => ({
  id: Number(r.id),
  projectId: r.project_id as string,
  deploymentId: r.deployment_id as string,
  path: r.path as string,
  schedule: r.schedule as string,
  trigger: r.trigger as CronRun["trigger"],
  scheduledAt: Number(r.scheduled_at),
  startedAt: Number(r.started_at),
  finishedAt: r.finished_at == null ? null : Number(r.finished_at),
  status: r.status as CronRunStatus,
  statusCode: r.status_code == null ? null : Number(r.status_code),
  durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
  output: (r.output as string | null) ?? null,
});

const toBlobStore = (r: Row): BlobStore => ({
  id: r.id as string,
  ownerId: (r.owner_id as string | null) ?? null,
  name: r.name as string,
  secret: r.secret as string,
  createdAt: Number(r.created_at),
});

const toBlobConnection = (r: Row): BlobConnection => ({
  storeId: r.store_id as string,
  projectId: r.project_id as string,
  targets: String(r.targets).split(",").filter(Boolean) as EnvTarget[],
  envPrefix: r.env_prefix as string,
  createdAt: Number(r.created_at),
});

const toBlob = (r: Row): BlobRecord => ({
  storeId: r.store_id as string,
  pathname: r.pathname as string,
  object: r.object as string,
  size: Number(r.size),
  contentType: r.content_type as string,
  cacheMaxAge: Number(r.cache_max_age),
  access: r.access as BlobRecord["access"],
  etag: r.etag as string,
  uploadedAt: Number(r.uploaded_at),
});

/** Runs kept per project; older ones are deleted. */
const CRON_RUNS_KEPT = 200;

/** Thin, typed data-access layer. All SQL lives here. */
export class Repo {
  constructor(readonly db: Db) {}

  // ---------------------------------------------------------------- projects

  /** Every project, or only one user's. */
  listProjects(ownerId?: string): Project[] {
    const rows = ownerId
      ? this.db.prepare("SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC").all(ownerId)
      : this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all();
    return (rows as Row[]).map(toProject);
  }

  /** The sandbox user number of the project a deployment belongs to. */
  sandboxId(deploymentId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT projects.sandbox_id AS n FROM deployments JOIN projects ON projects.id = deployments.project_id WHERE deployments.id = ?",
      )
      .get(deploymentId) as Row | undefined;
    return row?.n == null ? null : Number(row.n);
  }

  countProjects(ownerId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?").get(ownerId) as Row).n);
  }

  /** Queued or building deployments across a user's projects. */
  countActiveDeployments(ownerId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM deployments JOIN projects ON projects.id = deployments.project_id
         WHERE projects.owner_id = ? AND deployments.status IN ('queued', 'building')`,
      )
      .get(ownerId) as Row;
    return Number(row.n);
  }

  getProject(idOrName: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? OR name = ?").get(idOrName, idOrName) as Row | undefined;
    return row ? toProject(row) : undefined;
  }

  insertProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repo_url, production_branch, framework, install_command, build_command,
           output_directory, root_directory, auto_promote_paused, crons_enabled, owner_id, created_at, updated_at, sandbox_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sandbox_id), 0) + 1 FROM projects))`,
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
        p.cronsEnabled === false ? 0 : 1,
        p.ownerId,
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
      cronsEnabled: "crons_enabled",
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
  /**
   * The env a deployment gets: connected Blob stores' tokens (<prefix>_READ_WRITE_TOKEN, as on
   * Vercel), then the project's own variables, which win on a name clash.
   */
  envFor(projectId: string, target: DeploymentTarget): Record<string, string> {
    const env: Record<string, string> = {};
    for (const c of this.listBlobConnections({ projectId })) {
      if (!c.targets.includes(target)) continue;
      const store = this.getBlobStore(c.storeId);
      if (store) env[`${c.envPrefix}_READ_WRITE_TOKEN`] = blobToken(store);
    }
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

  // ----------------------------------------------------------------- domains

  listDomains(projectId?: string): Domain[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM domains WHERE project_id = ? ORDER BY created_at").all(projectId)
      : this.db.prepare("SELECT * FROM domains ORDER BY created_at").all();
    return (rows as Row[]).map(toDomain);
  }

  getDomain(hostname: string): Domain | undefined {
    const row = this.db.prepare("SELECT * FROM domains WHERE hostname = ?").get(hostname) as Row | undefined;
    return row ? toDomain(row) : undefined;
  }

  insertDomain(d: Domain): void {
    this.db
      .prepare("INSERT INTO domains (hostname, project_id, branch, created_at) VALUES (?, ?, ?, ?)")
      .run(d.hostname, d.projectId, d.branch, d.createdAt);
  }

  deleteDomain(hostname: string): boolean {
    return this.db.prepare("DELETE FROM domains WHERE hostname = ?").run(hostname).changes > 0;
  }

  // ------------------------------------------------------------------- users

  countUsers(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as Row).n);
  }

  firstUser(): User | undefined {
    const row = this.db.prepare("SELECT * FROM users ORDER BY created_at LIMIT 1").get() as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  getUserByEmail(email: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  getUser(id: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  getUserByGithubId(githubId: number): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  /** The earliest admin that hasn't been linked to a GitHub account yet. */
  unlinkedAdmin(): User | undefined {
    const row = this.db
      .prepare("SELECT * FROM users WHERE role = 'admin' AND github_id IS NULL ORDER BY created_at LIMIT 1")
      .get() as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  insertUser(u: User): void {
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, role, github_id, github_login, name, avatar_url, github_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.id,
        u.email,
        u.passwordHash,
        u.role,
        u.githubId,
        u.githubLogin,
        u.name,
        u.avatarUrl,
        u.githubToken ? JSON.stringify(u.githubToken) : null,
        u.createdAt,
      );
  }

  /** Links (or refreshes) a user's GitHub identity, as of their latest sign-in. */
  updateUserGithub(id: string, profile: GitHubProfile, token: GitHubUserToken | null): void {
    this.db
      .prepare("UPDATE users SET github_id = ?, github_login = ?, name = ?, avatar_url = ?, github_token = ? WHERE id = ?")
      .run(profile.githubId, profile.githubLogin, profile.name, profile.avatarUrl, token ? JSON.stringify(token) : null, id);
  }

  updateUserGithubToken(id: string, token: GitHubUserToken | null): void {
    this.db.prepare("UPDATE users SET github_token = ? WHERE id = ?").run(token ? JSON.stringify(token) : null, id);
  }

  updateUserPassword(id: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  }

  insertSession(tokenHash: string, userId: string, expiresAt: number): void {
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, userId, Date.now(), expiresAt);
  }

  /** The user behind a live session, or undefined. Expired sessions are swept as a side effect. */
  sessionUser(tokenHash: string): User | undefined {
    const now = Date.now();
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    const row = this.db
      .prepare("SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ?")
      .get(tokenHash) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteUserSessions(userId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  listApiTokens(userId: string): ApiToken[] {
    const rows = this.db.prepare("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Row[];
    return rows.map(toApiToken);
  }

  insertApiToken(t: ApiToken & { tokenHash: string }): void {
    this.db
      .prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.id, t.userId, t.name, t.tokenHash, t.prefix, t.createdAt);
  }

  /** The user an API token belongs to, recording when it was last used. */
  apiTokenUser(tokenHash: string): User | undefined {
    const row = this.db
      .prepare(
        "SELECT users.*, api_tokens.id AS token_id FROM api_tokens JOIN users ON users.id = api_tokens.user_id WHERE token_hash = ?",
      )
      .get(tokenHash) as Row | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.token_id as string);
    return toUser(row);
  }

  deleteApiToken(userId: string, id: string): boolean {
    return this.db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  }

  // --------------------------------------------------------------- cron runs

  /** Records a run as started. Returns null for a scheduled run that already exists (same job and minute). */
  startCronRun(run: Omit<CronRun, "id" | "finishedAt" | "status" | "statusCode" | "durationMs" | "output">): CronRun | null {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO cron_runs (project_id, deployment_id, path, schedule, trigger, scheduled_at, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(run.projectId, run.deploymentId, run.path, run.schedule, run.trigger, run.scheduledAt, run.startedAt);
    if (result.changes === 0) return null;
    return this.getCronRun(Number(result.lastInsertRowid))!;
  }

  finishCronRun(id: number, result: { status: CronRunStatus; statusCode: number | null; output: string | null }): CronRun {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE cron_runs SET status = ?, status_code = ?, output = ?, finished_at = ?, duration_ms = ? - started_at WHERE id = ?`,
      )
      .run(result.status, result.statusCode, result.output, now, now, id);
    const run = this.getCronRun(id)!;
    this.db
      .prepare(
        `DELETE FROM cron_runs WHERE project_id = ? AND id NOT IN
           (SELECT id FROM cron_runs WHERE project_id = ? ORDER BY id DESC LIMIT ${CRON_RUNS_KEPT})`,
      )
      .run(run.projectId, run.projectId);
    return run;
  }

  getCronRun(id: number): CronRun | undefined {
    const row = this.db.prepare("SELECT * FROM cron_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toCronRun(row) : undefined;
  }

  listCronRuns(projectId: string, limit = 50): CronRun[] {
    return (
      this.db.prepare("SELECT * FROM cron_runs WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit) as Row[]
    ).map(toCronRun);
  }

  /** Runs left "running" by a control plane that stopped mid-request. */
  failInterruptedCronRuns(): number {
    const now = Date.now();
    return Number(
      this.db
        .prepare(
          `UPDATE cron_runs SET status = 'error', output = 'Interrupted: Orbit restarted while the job was running',
             finished_at = ?, duration_ms = ? - started_at WHERE status = 'running'`,
        )
        .run(now, now).changes,
    );
  }

  // ------------------------------------------------------------- blob stores

  listBlobStores(ownerId?: string): BlobStore[] {
    const rows = ownerId
      ? this.db.prepare("SELECT * FROM blob_stores WHERE owner_id = ? ORDER BY created_at DESC").all(ownerId)
      : this.db.prepare("SELECT * FROM blob_stores ORDER BY created_at DESC").all();
    return (rows as Row[]).map(toBlobStore);
  }

  getBlobStore(id: string): BlobStore | undefined {
    const row = this.db.prepare("SELECT * FROM blob_stores WHERE id = ?").get(id) as Row | undefined;
    return row ? toBlobStore(row) : undefined;
  }

  insertBlobStore(store: BlobStore): void {
    this.db
      .prepare("INSERT INTO blob_stores (id, owner_id, name, secret, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(store.id, store.ownerId, store.name, store.secret, store.createdAt);
  }

  updateBlobStore(id: string, patch: { name?: string; secret?: string }): void {
    if (patch.name !== undefined) this.db.prepare("UPDATE blob_stores SET name = ? WHERE id = ?").run(patch.name, id);
    if (patch.secret !== undefined) this.db.prepare("UPDATE blob_stores SET secret = ? WHERE id = ?").run(patch.secret, id);
  }

  deleteBlobStore(id: string): void {
    this.db.prepare("DELETE FROM blob_stores WHERE id = ?").run(id);
  }

  listBlobConnections(filter: { storeId?: string; projectId?: string }): BlobConnection[] {
    const rows = filter.storeId
      ? this.db.prepare("SELECT * FROM blob_store_projects WHERE store_id = ? ORDER BY created_at").all(filter.storeId)
      : this.db.prepare("SELECT * FROM blob_store_projects WHERE project_id = ? ORDER BY created_at").all(filter.projectId!);
    return (rows as Row[]).map(toBlobConnection);
  }

  upsertBlobConnection(c: Omit<BlobConnection, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO blob_store_projects (store_id, project_id, targets, env_prefix, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(store_id, project_id) DO UPDATE SET targets = excluded.targets, env_prefix = excluded.env_prefix`,
      )
      .run(c.storeId, c.projectId, c.targets.join(","), c.envPrefix, Date.now());
  }

  deleteBlobConnection(storeId: string, projectId: string): boolean {
    return (
      this.db.prepare("DELETE FROM blob_store_projects WHERE store_id = ? AND project_id = ?").run(storeId, projectId).changes > 0
    );
  }

  getBlob(storeId: string, pathname: string): BlobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM blobs WHERE store_id = ? AND pathname = ?").get(storeId, pathname) as
      Row | undefined;
    return row ? toBlob(row) : undefined;
  }

  /** Inserts or replaces a blob; returns the object it replaced, if any (to delete from disk). */
  putBlob(blob: BlobRecord): string | null {
    return transaction(this.db, () => {
      const previous = this.getBlob(blob.storeId, blob.pathname);
      this.db
        .prepare(
          `INSERT INTO blobs (store_id, pathname, object, size, content_type, cache_max_age, access, etag, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(store_id, pathname) DO UPDATE SET object = excluded.object, size = excluded.size,
             content_type = excluded.content_type, cache_max_age = excluded.cache_max_age, access = excluded.access,
             etag = excluded.etag, uploaded_at = excluded.uploaded_at`,
        )
        .run(
          blob.storeId,
          blob.pathname,
          blob.object,
          blob.size,
          blob.contentType,
          blob.cacheMaxAge,
          blob.access,
          blob.etag,
          blob.uploadedAt,
        );
      return previous && previous.object !== blob.object ? previous.object : null;
    });
  }

  deleteBlob(storeId: string, pathname: string): BlobRecord | undefined {
    const blob = this.getBlob(storeId, pathname);
    if (blob) this.db.prepare("DELETE FROM blobs WHERE store_id = ? AND pathname = ?").run(storeId, pathname);
    return blob;
  }

  /** Blobs in pathname order after `cursor`, with `prefix`. One extra row tells whether there are more. */
  listBlobs(storeId: string, opts: { prefix: string; after: string | null; limit: number }): BlobRecord[] {
    // Pathnames starting with the prefix sort between prefix and prefix + U+FFFF.
    const rows = this.db
      .prepare(
        `SELECT * FROM blobs WHERE store_id = ? AND pathname >= ? AND pathname < ? AND pathname > ?
         ORDER BY pathname LIMIT ?`,
      )
      .all(storeId, opts.prefix, `${opts.prefix}\uffff`, opts.after ?? "", opts.limit) as Row[];
    return rows.map(toBlob);
  }

  blobUsage(storeId: string): { count: number; bytes: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE store_id = ?")
      .get(storeId) as Row;
    return { count: Number(row.n), bytes: Number(row.bytes) };
  }

  insertBlobUpload(upload: { id: string; storeId: string; pathname: string }): void {
    this.db
      .prepare("INSERT INTO blob_uploads (id, store_id, pathname, created_at) VALUES (?, ?, ?, ?)")
      .run(upload.id, upload.storeId, upload.pathname, Date.now());
  }

  getBlobUpload(id: string): { id: string; storeId: string; pathname: string; createdAt: number } | undefined {
    const row = this.db.prepare("SELECT * FROM blob_uploads WHERE id = ?").get(id) as Row | undefined;
    return row
      ? {
          id: row.id as string,
          storeId: row.store_id as string,
          pathname: row.pathname as string,
          createdAt: Number(row.created_at),
        }
      : undefined;
  }

  deleteBlobUpload(id: string): void {
    this.db.prepare("DELETE FROM blob_uploads WHERE id = ?").run(id);
  }

  // ---------------------------------------------------------------- settings

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row ? (JSON.parse(row.value as string) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}

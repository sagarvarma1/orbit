import type { Config } from "../config.js";
import type { Project, Repo } from "../db/repo.js";
import { lsRemote, parseRepoUrl } from "../build/git.js";
import { HttpError } from "../lib/errors.js";
import { ForbiddenError, type PublicUser, UnauthorizedError } from "./auth.js";
import type { GitHubApp, GitHubInstallation, GitHubRepository } from "./github-app.js";

/**
 * What each account may see and do. Members see only their own projects and can deploy only
 * repositories they can push to (or public ones); admins see everything and have no limits.
 */
export class Access {
  private readonly refreshing = new Map<string, Promise<string | null>>();

  constructor(
    private readonly repo: Repo,
    private readonly githubApp: GitHubApp,
    private readonly config: Pick<Config, "maxProjectsPerUser" | "maxActiveBuildsPerUser" | "allowLocalRepos">,
  ) {}

  canSee(user: PublicUser, project: Project): boolean {
    return user.role === "admin" || project.ownerId === user.id;
  }

  /** The user's GitHub token, refreshed when it's about to expire; null if there's no usable one. */
  async githubToken(userId: string): Promise<string | null> {
    const token = this.repo.getUser(userId)?.githubToken;
    if (!token) return null;
    if (token.expiresAt === null || token.expiresAt - Date.now() > 5 * 60_000) return token.accessToken;
    if (!token.refreshToken) return null;
    // Refresh tokens are single-use, so concurrent requests share one refresh.
    let pending = this.refreshing.get(userId);
    if (!pending) {
      pending = this.githubApp
        .refreshUserToken(token.refreshToken)
        .then((next) => {
          this.repo.updateUserGithubToken(userId, next);
          return next.accessToken;
        })
        .catch(() => {
          this.repo.updateUserGithubToken(userId, null);
          return null;
        })
        .finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, pending);
    }
    return pending;
  }

  /** Repositories to offer on the import page. */
  async repositories(user: PublicUser): Promise<GitHubRepository[]> {
    const token = await this.githubToken(user.id);
    if (token) return this.githubApp.userRepositories(token);
    return user.role === "admin" ? this.githubApp.repositories() : [];
  }

  async installations(user: PublicUser): Promise<GitHubInstallation[]> {
    const token = await this.githubToken(user.id);
    if (token) return this.githubApp.userInstallations(token);
    return user.role === "admin" ? this.githubApp.installations() : [];
  }

  /**
   * Members may deploy a repository they can push to, or a public one that nobody installed the
   * Orbit app on. Orbit clones with the app's installation token, so without this check anyone
   * could deploy (and read, through build logs) another account's private repository.
   */
  async assertCanImport(user: PublicUser, repoUrl: string): Promise<void> {
    if (user.role === "admin") return;
    const { url, fullName } = parseRepoUrl(repoUrl, this.config.allowLocalRepos);
    if (fullName) {
      const token = await this.githubToken(user.id);
      if (!token) throw new UnauthorizedError("Your GitHub sign-in expired. Sign out and sign in again.");
      const permission = await this.githubApp.userRepoPermission(token, fullName);
      if (permission === "admin" || permission === "push") return;
      if (this.githubApp.configured && (await this.githubApp.installationFor(fullName)) !== null) {
        throw new ForbiddenError(`You need push access to ${fullName} on GitHub to deploy it`);
      }
    }
    // Anything else must be public: cloneable without credentials.
    await lsRemote(url).catch(() => {
      throw new ForbiddenError(
        "Orbit can't reach that repository. If it's private, install the Orbit GitHub App on it (Settings → GitHub).",
      );
    });
  }

  assertCanCreateProject(user: PublicUser): void {
    if (user.role === "admin") return;
    const max = this.config.maxProjectsPerUser;
    if (this.repo.countProjects(user.id) >= max) {
      throw new ForbiddenError(`Accounts can have up to ${max} projects. Delete one to import another.`);
    }
  }

  assertCanBuild(user: PublicUser): void {
    if (user.role === "admin") return;
    const max = this.config.maxActiveBuildsPerUser;
    if (this.repo.countActiveDeployments(user.id) >= max) {
      throw new HttpError(429, `You already have ${max} builds queued or running. Try again when one finishes.`);
    }
  }
}

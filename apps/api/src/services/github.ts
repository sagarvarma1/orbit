import { type GitCredentials, parseRepoUrl } from "../build/git.js";
import type { Deployment, Project } from "../db/repo.js";

/** What a deployment looks like from GitHub's side. Queued deployments report as building. */
export type GitHubState = "building" | "ready" | "error" | "canceled";

export interface DeploymentLinks {
  /** Immutable URL of this deployment. */
  preview: string;
  /** `<project>-git-<branch>` alias that follows the branch. */
  branch: string;
  /** Dashboard page with the build logs. */
  inspect: string;
}

export interface GitHubOptions {
  /** Personal access token (fallback when no GitHub App is installed on the repo). */
  token: string;
  /** https://api.github.com, or a fake server in tests. */
  apiUrl: string;
  /** The GitHub App, whose installation tokens are preferred. */
  app?: GitCredentials & { readonly configured: boolean };
}

type Log = (message: string) => void;

const STATUS: Record<GitHubState, { state: string; description: string }> = {
  building: { state: "pending", description: "Building…" },
  ready: { state: "success", description: "Deployment ready" },
  error: { state: "failure", description: "Build failed" },
  canceled: { state: "error", description: "Build canceled" },
};

const marker = (projectId: string) => `<!-- orbit-preview:${projectId} -->`;

/**
 * Reports deployments back to GitHub like Vercel does: a commit status on the deployed commit
 * and one comment per open pull request, edited in place as the build progresses.
 *
 * Best effort: failures are logged to the build log and never affect the deployment.
 */
export class GitHubNotifier {
  /** Per-deployment chain, so "building" always lands before "ready". */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly opts: GitHubOptions) {}

  get enabled(): boolean {
    return Boolean(this.opts.token) || Boolean(this.opts.app?.configured);
  }

  notify(project: Project, deployment: Deployment, state: GitHubState, links: DeploymentLinks, log: Log): Promise<void> {
    if (!this.enabled || !deployment.commitSha) return Promise.resolve();
    const fullName = githubRepo(project.repoUrl);
    if (!fullName) return Promise.resolve();

    const previous = this.chains.get(deployment.id) ?? Promise.resolve();
    const next = previous
      .then(() => this.send(fullName, project, deployment, state, links, log))
      .catch((err: Error) => {
        log(`GitHub: ${err.message}`);
      });
    this.chains.set(deployment.id, next);
    void next.finally(() => {
      if (this.chains.get(deployment.id) === next) this.chains.delete(deployment.id);
    });
    return next;
  }

  private async send(
    fullName: string,
    project: Project,
    deployment: Deployment,
    state: GitHubState,
    links: DeploymentLinks,
    log: Log,
  ): Promise<void> {
    const token = (await this.opts.app?.tokenFor(project.repoUrl)) ?? this.opts.token;
    if (!token) return; // The app isn't installed on this repository and there's no PAT.
    const { state: statusState, description } = STATUS[state];
    await this.request(token, "POST", `/repos/${fullName}/statuses/${deployment.commitSha}`, {
      state: statusState,
      description,
      context: `Orbit – ${project.name}`,
      target_url: state === "ready" ? links.preview : links.inspect,
    });
    if (state === "building") log(`GitHub: commit status set to pending on ${deployment.commitSha!.slice(0, 7)}`);
    else log(`GitHub: commit status set to ${statusState}`);

    const owner = fullName.split("/")[0]!;
    const pulls = (await this.request(
      token,
      "GET",
      `/repos/${fullName}/pulls?state=open&per_page=10&head=${encodeURIComponent(`${owner}:${deployment.branch}`)}`,
    )) as { number: number }[];
    for (const pull of pulls) {
      const action = await this.upsertComment(
        token,
        fullName,
        pull.number,
        project.id,
        commentBody(project, deployment, state, links),
      );
      log(`GitHub: ${action} preview comment on pull request #${pull.number}`);
    }
  }

  private async upsertComment(
    token: string,
    fullName: string,
    issue: number,
    projectId: string,
    body: string,
  ): Promise<"posted" | "updated"> {
    const comments = (await this.request(token, "GET", `/repos/${fullName}/issues/${issue}/comments?per_page=100`)) as {
      id: number;
      body?: string;
    }[];
    const existing = comments.find((c) => c.body?.includes(marker(projectId)));
    if (existing) {
      await this.request(token, "PATCH", `/repos/${fullName}/issues/comments/${existing.id}`, { body });
      return "updated";
    }
    await this.request(token, "POST", `/repos/${fullName}/issues/${issue}/comments`, { body });
    return "posted";
  }

  private async request(token: string, method: string, urlPath: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.opts.apiUrl.replace(/\/$/, "")}${urlPath}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "orbit-deploy",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as { message?: string } | null;
    if (!res.ok) {
      const hint =
        res.status === 401
          ? " (is the token valid?)"
          : res.status === 403 || res.status === 404
            ? " (check the token's repository access and permissions)"
            : "";
      throw new Error(`${method} ${urlPath.split("?")[0]} failed: ${res.status} ${data?.message ?? res.statusText}${hint}`);
    }
    return data;
  }
}

/** "owner/repo" for GitHub repositories, null for anything else (local repos in tests). */
export function githubRepo(repoUrl: string): string | null {
  try {
    return parseRepoUrl(repoUrl, true).fullName;
  } catch {
    return null;
  }
}

export function commentBody(project: Project, deployment: Deployment, state: GitHubState, links: DeploymentLinks): string {
  const inspect = `[Inspect](${links.inspect})`;
  const status = {
    building: `🔄 Building (${inspect})`,
    ready: `✅ Ready (${inspect})`,
    error: `❌ Failed (${inspect})`,
    canceled: `⚪ Canceled (${inspect})`,
  }[state];
  const preview = state === "ready" ? `[Visit Preview](${links.preview})` : "—";
  const updated = new Date().toUTCString().replace(/:\d\d GMT$/, " UTC");
  return [
    marker(project.id),
    "**Orbit** deployed this pull request.",
    "",
    "| Project | Deployment | Preview | Commit | Updated |",
    "| :--- | :--- | :--- | :--- | :--- |",
    `| **${project.name}** | ${status} | ${preview} | \`${deployment.commitSha!.slice(0, 7)}\` | ${updated} |`,
    "",
    `Branch preview, always the latest commit on \`${deployment.branch}\`: ${links.branch}`,
  ].join("\n");
}

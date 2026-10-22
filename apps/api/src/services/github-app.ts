import { createSign, randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";
import { parseRepoUrl } from "../build/git.js";
import { BadRequestError, HttpError } from "../lib/errors.js";
import { randomId } from "../lib/ids.js";

/** What GitHub hands back when an app is created from a manifest. Stored in the settings table. */
export interface GitHubAppCredentials {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
  owner: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKey: string;
}

export interface GitHubRepository {
  fullName: string;
  url: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  installationId: number;
}

export interface GitHubInstallation {
  id: number;
  account: string;
  avatarUrl: string | null;
  repositorySelection: "all" | "selected";
  settingsUrl: string;
}

const SETTINGS_KEY = "github_app";
const STATE_KEY = "github_app_manifest_state";

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** RS256 JWT that authenticates as the app itself (valid ~10 minutes, as GitHub requires). */
export function appJwt(appId: number, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdate a minute to allow for clock drift.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/**
 * Orbit's GitHub App: created from the dashboard with GitHub's manifest flow, then installed on
 * accounts and repositories. It provides short-lived tokens for cloning private repositories,
 * posting commit statuses and PR comments, plus a webhook secret so pushes deploy instantly.
 */
export class GitHubApp {
  private readonly installationTokens = new Map<number, { token: string; expiresAt: number }>();
  private readonly repoInstallations = new Map<string, { id: number | null; checkedAt: number }>();

  constructor(
    private readonly repo: Repo,
    private readonly config: Pick<Config, "githubApiUrl" | "dashboardUrl" | "githubWebUrl">,
  ) {}

  get credentials(): GitHubAppCredentials | null {
    return this.repo.getSetting<GitHubAppCredentials>(SETTINGS_KEY) ?? null;
  }

  get configured(): boolean {
    return this.credentials !== null;
  }

  installUrl(creds = this.credentials): string | null {
    return creds ? `${creds.htmlUrl}/installations/new` : null;
  }

  // ---------------------------------------------------------------- creation

  /**
   * The manifest the dashboard posts to GitHub. GitHub shows a pre-filled "Create GitHub App"
   * page and redirects back with a code we exchange for the app's credentials.
   */
  createManifest(org?: string): { action: string; manifest: Record<string, unknown>; state: string } {
    const dashboard = this.config.dashboardUrl;
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(dashboard);
    const state = randomBytes(16).toString("hex");
    this.repo.setSetting(STATE_KEY, { state, createdAt: Date.now() });
    const manifest = {
      // App names are unique across GitHub (max 34 characters); people can rename it on the next page.
      name: `Orbit ${randomId(6)}`,
      url: dashboard,
      description: "Deploys this repository with Orbit, a self-hosted deployment platform.",
      // GitHub can't reach localhost, so local instances rely on the git poller instead.
      hook_attributes: { url: `${new URL(dashboard).origin}/api/webhooks/github`, active: !local },
      redirect_url: `${dashboard}/settings/github/callback`,
      setup_url: `${dashboard}/settings?github=installed`,
      setup_on_update: true,
      public: false,
      default_permissions: { contents: "read", metadata: "read", statuses: "write", pull_requests: "write" },
      default_events: ["push", "pull_request"],
    };
    const web = this.config.githubWebUrl;
    const action = org
      ? `${web}/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
      : `${web}/settings/apps/new?state=${state}`;
    return { action, manifest, state };
  }

  async completeManifest(code: string, state: string): Promise<GitHubAppCredentials> {
    const expected = this.repo.getSetting<{ state: string; createdAt: number }>(STATE_KEY);
    if (!expected || expected.state !== state || Date.now() - expected.createdAt > 60 * 60_000) {
      throw new BadRequestError("This GitHub App setup link expired. Start again from Settings.");
    }
    const res = await this.request<{
      id: number;
      slug: string;
      name: string;
      html_url: string;
      owner: { login: string } | null;
      client_id: string;
      client_secret: string;
      webhook_secret: string;
      pem: string;
    }>("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, {});
    const creds: GitHubAppCredentials = {
      id: res.id,
      slug: res.slug,
      name: res.name,
      htmlUrl: res.html_url,
      owner: res.owner?.login ?? "",
      clientId: res.client_id,
      clientSecret: res.client_secret,
      webhookSecret: res.webhook_secret,
      privateKey: res.pem,
    };
    this.repo.setSetting(SETTINGS_KEY, creds);
    this.repo.deleteSetting(STATE_KEY);
    this.installationTokens.clear();
    this.repoInstallations.clear();
    return creds;
  }

  disconnect(): void {
    this.repo.deleteSetting(SETTINGS_KEY);
    this.installationTokens.clear();
    this.repoInstallations.clear();
  }

  // ------------------------------------------------------------------ tokens

  async installations(): Promise<GitHubInstallation[]> {
    const list = await this.request<
      {
        id: number;
        account: { login: string; avatar_url?: string } | null;
        repository_selection: "all" | "selected";
        html_url: string;
      }[]
    >("GET", "/app/installations?per_page=100", undefined, { jwt: true });
    return list.map((i) => ({
      id: i.id,
      account: i.account?.login ?? "",
      avatarUrl: i.account?.avatar_url ?? null,
      repositorySelection: i.repository_selection,
      settingsUrl: i.html_url,
    }));
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const res = await this.request<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      {},
      { jwt: true },
    );
    this.installationTokens.set(installationId, { token: res.token, expiresAt: Date.parse(res.expires_at) });
    return res.token;
  }

  /** The installation that covers "owner/repo", or null if the app isn't installed there. */
  async installationFor(fullName: string): Promise<number | null> {
    const cached = this.repoInstallations.get(fullName);
    if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return cached.id;
    let id: number | null = null;
    try {
      id = (await this.request<{ id: number }>("GET", `/repos/${fullName}/installation`, undefined, { jwt: true })).id;
    } catch (err) {
      if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
    }
    this.repoInstallations.set(fullName, { id, checkedAt: Date.now() });
    return id;
  }

  /** A short-lived token for a GitHub repository URL, or undefined (not GitHub, or not installed). */
  async tokenFor(repoUrl: string): Promise<string | undefined> {
    if (!this.configured) return undefined;
    let fullName: string | null;
    try {
      fullName = parseRepoUrl(repoUrl, false).fullName;
    } catch {
      return undefined;
    }
    if (!fullName) return undefined;
    try {
      const installation = await this.installationFor(fullName);
      return installation ? await this.installationToken(installation) : undefined;
    } catch (err) {
      console.warn(`[github-app] no token for ${fullName}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Every repository the app can see, across installations, most recently pushed first. */
  async repositories(): Promise<GitHubRepository[]> {
    const out: GitHubRepository[] = [];
    for (const installation of await this.installations()) {
      const token = await this.installationToken(installation.id);
      for (let page = 1; page <= 5; page++) {
        const res = await this.request<{
          total_count: number;
          repositories: {
            full_name: string;
            html_url: string;
            private: boolean;
            default_branch: string;
            pushed_at: string | null;
          }[];
        }>("GET", `/installation/repositories?per_page=100&page=${page}`, undefined, { token });
        for (const r of res.repositories) {
          out.push({
            fullName: r.full_name,
            url: r.html_url,
            private: r.private,
            defaultBranch: r.default_branch,
            pushedAt: r.pushed_at,
            installationId: installation.id,
          });
          this.repoInstallations.set(r.full_name.toLowerCase(), { id: installation.id, checkedAt: Date.now() });
        }
        if (res.repositories.length < 100) break;
      }
    }
    return out.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  }

  private async request<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    auth: { jwt?: boolean; token?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "orbit-deploy",
    };
    if (auth.jwt) {
      const creds = this.credentials;
      if (!creds) throw new BadRequestError("No GitHub App is connected");
      headers.authorization = `Bearer ${appJwt(creds.id, creds.privateKey)}`;
    } else if (auth.token) {
      headers.authorization = `Bearer ${auth.token}`;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.config.githubApiUrl.replace(/\/$/, "")}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!res.ok) {
      throw new HttpError(
        res.status === 404 ? 404 : 502,
        `GitHub: ${method} ${urlPath.split("?")[0]} failed: ${res.status} ${data?.message ?? res.statusText}`,
      );
    }
    return data as T;
  }
}

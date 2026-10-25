import { createSign, randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { GitHubProfile, GitHubUserToken, Repo } from "../db/repo.js";
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

export type RepoPermission = "admin" | "push" | "read";

interface RawRepository {
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
}

interface RawInstallation {
  id: number;
  account: { login: string; avatar_url?: string } | null;
  repository_selection: "all" | "selected";
  html_url: string;
}

const toInstallation = (i: RawInstallation): GitHubInstallation => ({
  id: i.id,
  account: i.account?.login ?? "",
  avatarUrl: i.account?.avatar_url ?? null,
  repositorySelection: i.repository_selection,
  settingsUrl: i.html_url,
});

const toRepository = (r: RawRepository, installationId: number): GitHubRepository => ({
  fullName: r.full_name,
  url: r.html_url,
  private: r.private,
  defaultBranch: r.default_branch,
  pushedAt: r.pushed_at,
  installationId,
});

const byLastPush = (a: GitHubRepository, b: GitHubRepository) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "");

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
  createManifest(
    org?: string,
    opts: { public?: boolean; callbackUrl?: string } = {},
  ): { action: string; manifest: Record<string, unknown>; state: string } {
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
      // "Sign in with GitHub" uses the app's OAuth client.
      ...(opts.callbackUrl ? { callback_urls: [opts.callbackUrl] } : {}),
      // Public apps can be installed by anyone, which an instance with open sign-ups needs.
      public: Boolean(opts.public),
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
    const list = await this.request<RawInstallation[]>("GET", "/app/installations?per_page=100", undefined, { jwt: true });
    return list.map(toInstallation);
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
        const res = await this.request<{ repositories: RawRepository[] }>(
          "GET",
          `/installation/repositories?per_page=100&page=${page}`,
          undefined,
          { token },
        );
        for (const r of res.repositories) {
          out.push(toRepository(r, installation.id));
          this.repoInstallations.set(r.full_name.toLowerCase(), { id: installation.id, checkedAt: Date.now() });
        }
        if (res.repositories.length < 100) break;
      }
    }
    return out.sort(byLastPush);
  }

  // ------------------------------------------------------------ user sign-in

  /** GitHub's "Authorize" page for signing in. GitHub Apps need no scopes. */
  authorizeUrl(state: string, redirectUri: string): string | null {
    const creds = this.credentials;
    if (!creds) return null;
    const params = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri, state });
    return `${this.config.githubWebUrl}/login/oauth/authorize?${params}`;
  }

  exchangeCode(code: string, redirectUri: string): Promise<GitHubUserToken> {
    return this.oauthToken({ code, redirect_uri: redirectUri });
  }

  refreshUserToken(refreshToken: string): Promise<GitHubUserToken> {
    return this.oauthToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async userProfile(token: string): Promise<GitHubProfile & { email: string | null }> {
    const u = await this.request<{ id: number; login: string; name: string | null; avatar_url: string; email: string | null }>(
      "GET",
      "/user",
      undefined,
      { token },
    );
    return { githubId: u.id, githubLogin: u.login, name: u.name, avatarUrl: u.avatar_url, email: u.email };
  }

  /** Installations of this app that the signed-in user can access. */
  async userInstallations(token: string): Promise<GitHubInstallation[]> {
    const res = await this.request<{ installations: RawInstallation[] }>("GET", "/user/installations?per_page=100", undefined, {
      token,
    });
    return res.installations.map(toInstallation);
  }

  /** Repositories the user can access through this app's installations. */
  async userRepositories(token: string): Promise<GitHubRepository[]> {
    const out: GitHubRepository[] = [];
    for (const installation of await this.userInstallations(token)) {
      for (let page = 1; page <= 5; page++) {
        const res = await this.request<{ repositories: RawRepository[] }>(
          "GET",
          `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
          undefined,
          { token },
        );
        out.push(...res.repositories.map((r) => toRepository(r, installation.id)));
        if (res.repositories.length < 100) break;
      }
    }
    return out.sort(byLastPush);
  }

  /** What the user may do with "owner/repo" on GitHub, or null if they can't see it. */
  async userRepoPermission(token: string, fullName: string): Promise<RepoPermission | null> {
    try {
      const res = await this.request<{ permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } }>(
        "GET",
        `/repos/${fullName}`,
        undefined,
        { token },
      );
      const p = res.permissions ?? {};
      return p.admin ? "admin" : p.push || p.maintain ? "push" : "read";
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return null;
      throw err;
    }
  }

  private async oauthToken(params: Record<string, string>): Promise<GitHubUserToken> {
    const creds = this.credentials;
    if (!creds) throw new BadRequestError("No GitHub App is connected");
    const res = await fetch(`${this.config.githubWebUrl.replace(/\/$/, "")}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "orbit-deploy" },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      throw new HttpError(401, `GitHub sign-in failed: ${data.error_description ?? data.error ?? res.statusText}`);
    }
    return {
      accessToken: data.access_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
      refreshToken: data.refresh_token ?? null,
    };
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

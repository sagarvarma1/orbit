import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Git never prompts and never reads system config. */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ASKPASS: "echo",
};

/**
 * Credentials for private GitHub repositories go in through environment config
 * (GIT_CONFIG_COUNT), never into the remote URL, argv or .git/config, so they can't end up in
 * logs, process listings or the build workspace.
 */
function gitEnv(token?: string): NodeJS.ProcessEnv {
  if (!token) return GIT_ENV;
  return {
    ...GIT_ENV,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

export async function git(
  args: string[],
  cwd?: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
  token?: string,
): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: gitEnv(token),
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
  return stdout.trim();
}

/** Provides access tokens for private repositories (the GitHub App). */
export interface GitCredentials {
  tokenFor(repoUrl: string): Promise<string | undefined>;
}

export interface RepoRef {
  /** Canonical clone URL. */
  url: string;
  /** "owner/repo" for GitHub URLs, used to match webhooks. */
  fullName: string | null;
}

const GITHUB_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/**
 * Accepts `https://github.com/owner/repo(.git)`, `github.com/owner/repo` or `owner/repo`.
 * Local paths/file:// URLs are allowed only when explicitly enabled (tests, offline demos).
 */
export function parseRepoUrl(input: string, allowLocal: boolean): RepoRef {
  const trimmed = input.trim();
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (shorthand)
    return {
      url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`,
      fullName: `${shorthand[1]}/${shorthand[2]}`.toLowerCase(),
    };
  const gh = GITHUB_RE.exec(trimmed.replace(/\/tree\/.*$/, ""));
  if (gh) return { url: `https://github.com/${gh[1]}/${gh[2]}.git`, fullName: `${gh[1]}/${gh[2]}`.toLowerCase() };
  if (allowLocal && (trimmed.startsWith("file://") || trimmed.startsWith("/"))) return { url: trimmed, fullName: null };
  throw new Error("Enter a GitHub repository URL, e.g. https://github.com/owner/repo");
}

export interface RemoteInfo {
  defaultBranch: string;
  branches: { name: string; sha: string }[];
}

/** Default branch and branch heads without cloning (`git ls-remote`). */
export async function lsRemote(url: string, token?: string): Promise<RemoteInfo> {
  const out = await git(["ls-remote", "--symref", url, "HEAD", "refs/heads/*"], undefined, 30_000, undefined, token);
  let defaultBranch = "main";
  const branches: { name: string; sha: string }[] = [];
  for (const line of out.split("\n")) {
    const symref = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line);
    if (symref) {
      defaultBranch = symref[1]!;
      continue;
    }
    const head = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(line);
    if (head) branches.push({ sha: head[1]!, name: head[2]! });
  }
  return { defaultBranch, branches };
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
}

/**
 * Shallow-fetch exactly one ref (branch name or full commit SHA) into `dir`.
 * `git fetch --depth 1 origin <sha>` works on GitHub, so webhook builds pin the pushed commit.
 */
export async function shallowCheckout(
  url: string,
  ref: string,
  dir: string,
  signal?: AbortSignal,
  token?: string,
): Promise<CommitInfo> {
  await git(["init", "--quiet", dir]);
  await git(["remote", "add", "origin", url], dir);
  await git(
    ["-c", "protocol.version=2", "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", ref],
    dir,
    300_000,
    signal,
    token,
  );
  await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], dir);
  const [sha = "", author = "", ...message] = (await git(["log", "-1", "--format=%H%n%an%n%s"], dir)).split("\n");
  return { sha, author, message: message.join("\n") };
}

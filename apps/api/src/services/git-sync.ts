import { createHmac, timingSafeEqual } from "node:crypto";
import type { Deployment, Project, Repo } from "../db/repo.js";
import { lsRemote, parseRepoUrl } from "../build/git.js";
import type { DeploymentService } from "./deployments.js";

export interface PushEvent {
  /** Clone URL or GitHub "owner/repo". */
  repo: string;
  branch: string;
  sha: string;
  message?: string | null;
  author?: string | null;
  trigger: "webhook" | "poll";
}

/** Verifies GitHub's `X-Hub-Signature-256: sha256=<hex>` over the raw body, in constant time. */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function repoKey(url: string): string {
  try {
    const ref = parseRepoUrl(url, true);
    return ref.fullName ?? ref.url;
  } catch {
    return url;
  }
}

/** Turns git pushes (from webhooks or the poller) into deployments. */
export class GitSync {
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly repo: Repo,
    private readonly deployments: DeploymentService,
  ) {}

  projectsForRepo(repoUrlOrFullName: string): Project[] {
    const key = repoKey(repoUrlOrFullName);
    return this.repo.listProjects().filter((p) => repoKey(p.repoUrl) === key);
  }

  /**
   * Production branch -> production deployment, anything else -> preview. Idempotent per
   * (project, branch, sha), so webhook redeliveries and poller overlap don't double-build.
   */
  handlePush(event: PushEvent): Deployment[] {
    const created: Deployment[] = [];
    for (const project of this.projectsForRepo(event.repo)) {
      this.repo.setBranchHead(project.id, event.branch, event.sha);
      const duplicate = this.repo
        .listDeployments(project.id, 50)
        .some(
          (d) =>
            d.branch === event.branch &&
            (d.commitSha === event.sha || d.ref === event.sha) &&
            d.status !== "canceled" &&
            d.status !== "error",
        );
      if (duplicate) continue;
      created.push(
        this.deployments.create(project, {
          branch: event.branch,
          ref: event.sha,
          trigger: event.trigger,
          commit: { sha: event.sha, message: event.message, author: event.author },
        }),
      );
    }
    return created;
  }

  /** Record current branch heads so the poller only reacts to commits pushed after import. */
  async snapshotHeads(project: Project): Promise<void> {
    const remote = await lsRemote(project.repoUrl);
    for (const b of remote.branches) this.repo.setBranchHead(project.id, b.name, b.sha);
  }

  /**
   * Webhook alternative for laptops: GitHub can't reach localhost, so poll `git ls-remote`
   * and feed new branch heads through the same handlePush path.
   */
  startPolling(intervalSeconds: number): void {
    if (intervalSeconds <= 0) return;
    this.timer = setInterval(() => void this.pollOnce(), intervalSeconds * 1000);
    this.timer.unref();
  }

  stopPolling(): void {
    clearInterval(this.timer);
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const project of this.repo.listProjects()) {
        try {
          const known = this.repo.getBranchHeads(project.id);
          const remote = await lsRemote(project.repoUrl);
          for (const b of remote.branches) {
            if (known.get(b.name) === b.sha) continue;
            if (known.size === 0) {
              // First look at this repo: baseline only, don't deploy every existing branch.
              this.repo.setBranchHead(project.id, b.name, b.sha);
              continue;
            }
            console.log(`[poller] ${project.name}: ${b.name} -> ${b.sha.slice(0, 7)}`);
            this.handlePush({ repo: project.repoUrl, branch: b.name, sha: b.sha, trigger: "poll" });
          }
        } catch (err) {
          console.warn(`[poller] ${project.name}: ${(err as Error).message.split("\n")[0]}`);
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

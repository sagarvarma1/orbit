import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Repo, type Project } from "../src/db/repo.js";
import type { CreateDeploymentInput, DeploymentService } from "../src/services/deployments.js";
import { GitSync } from "../src/services/git-sync.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-gitsync-"));
  const repoDir = path.join(tmp, "repo");
  fs.mkdirSync(repoDir);
  fs.writeFileSync(path.join(repoDir, "index.html"), "v1");
  git(repoDir, "init", "-q", "-b", "main");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-qm", "init");

  const repo = new Repo(openDb(path.join(tmp, "orbit.db")));
  const project: Project = {
    id: "prj_test",
    name: "site",
    repoUrl: `file://${repoDir}`,
    productionBranch: "main",
    framework: null,
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    rootDirectory: ".",
    autoPromotePaused: false,
    ownerId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  repo.insertProject(project);

  const calls: (CreateDeploymentInput & { project: string })[] = [];
  const deployments = {
    create: (p: Project, input: CreateDeploymentInput) => {
      calls.push({ ...input, project: p.name });
      return {
        id: `dpl-${calls.length}`,
        branch: input.branch,
        commitSha: input.commit?.sha ?? null,
        ref: input.ref ?? input.branch,
        status: "queued",
      };
    },
  } as unknown as DeploymentService;
  return { repoDir, repo, sync: new GitSync(repo, deployments), calls };
}

describe("GitSync", () => {
  it("poller baselines existing branches, then deploys new commits on any branch", async () => {
    const { repoDir, sync, calls } = setup();
    await sync.pollOnce();
    expect(calls).toHaveLength(0); // first look is a baseline only

    git(repoDir, "checkout", "-qb", "feature/x");
    fs.writeFileSync(path.join(repoDir, "index.html"), "v2");
    git(repoDir, "commit", "-qam", "feature work");
    const featureSha = git(repoDir, "rev-parse", "HEAD");
    await sync.pollOnce();
    expect(calls).toEqual([expect.objectContaining({ branch: "feature/x", ref: featureSha, trigger: "poll" })]);

    await sync.pollOnce();
    expect(calls).toHaveLength(1); // unchanged heads don't redeploy
  });

  it("matches pushes to projects by repository and ignores duplicates", () => {
    const { repoDir, sync, calls } = setup();
    const push = { repo: `file://${repoDir}`, branch: "main", sha: "a".repeat(40), trigger: "webhook" as const };
    expect(sync.handlePush(push)).toHaveLength(1);
    expect(sync.handlePush({ ...push, repo: "https://github.com/someone/else" })).toHaveLength(0);
    expect(calls[0]).toMatchObject({ branch: "main", ref: "a".repeat(40) });
  });
});

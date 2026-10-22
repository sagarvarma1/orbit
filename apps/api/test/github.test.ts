import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Deployment, Project } from "../src/db/repo.js";
import { GitHubNotifier } from "../src/services/github.js";

/** A tiny in-memory GitHub: records every call, stores comments, lists one open PR for "feature". */
function fakeGitHub() {
  const calls: { method: string; path: string; body: Record<string, unknown> | null; auth?: string }[] = [];
  const comments: { id: number; body: string }[] = [];
  let failStatuses = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      calls.push({ method: req.method!, path: req.url!, body, auth: req.headers.authorization });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const url = new URL(req.url!, "http://x");
      if (req.method === "POST" && url.pathname.startsWith("/repos/acme/site/statuses/")) {
        return failStatuses ? send(403, { message: "Resource not accessible by personal access token" }) : send(201, {});
      }
      if (req.method === "GET" && url.pathname === "/repos/acme/site/pulls") {
        return send(200, url.searchParams.get("head") === "acme:feature" ? [{ number: 7 }] : []);
      }
      if (req.method === "GET" && url.pathname === "/repos/acme/site/issues/7/comments") return send(200, comments);
      if (req.method === "POST" && url.pathname === "/repos/acme/site/issues/7/comments") {
        comments.push({ id: comments.length + 1, body: body!.body as string });
        return send(201, {});
      }
      const patch = /^\/repos\/acme\/site\/issues\/comments\/(\d+)$/.exec(url.pathname);
      if (req.method === "PATCH" && patch) {
        comments.find((c) => c.id === Number(patch[1]))!.body = body!.body as string;
        return send(200, {});
      }
      send(404, { message: "Not Found" });
    });
  });
  return {
    server,
    calls,
    comments,
    failStatuses: (v: boolean) => (failStatuses = v),
  };
}

const project = { id: "prj_1", name: "site", repoUrl: "https://github.com/acme/site.git" } as Project;
const deployment = (branch: string) =>
  ({ id: "dpl-abc", branch, commitSha: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0" }) as Deployment;
const links = {
  preview: "http://dpl-abc.localhost:8080",
  branch: "http://site-git-feature.localhost:8080",
  inspect: "http://localhost:3000/site/deployments/dpl-abc",
};

describe("GitHub notifier", () => {
  const gh = fakeGitHub();
  let notifier: GitHubNotifier;
  let logs: string[];

  beforeAll(async () => {
    await new Promise<void>((resolve) => gh.server.listen(0, "127.0.0.1", resolve));
    notifier = new GitHubNotifier({ token: "ghp_test", apiUrl: `http://127.0.0.1:${(gh.server.address() as AddressInfo).port}` });
  });
  afterAll(() => gh.server.close());
  beforeEach(() => {
    gh.calls.length = 0;
    gh.comments.length = 0;
    gh.failStatuses(false);
    logs = [];
  });
  const log = (m: string) => logs.push(m);

  it("sets a pending status and posts a PR comment while building, then updates both when ready", async () => {
    await notifier.notify(project, deployment("feature"), "building", links, log);
    const pending = gh.calls.find((c) => c.path.includes("/statuses/"))!;
    expect(pending.path).toBe("/repos/acme/site/statuses/a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0");
    expect(pending.body).toMatchObject({ state: "pending", context: "Orbit – site", target_url: links.inspect });
    expect(pending.auth).toBe("Bearer ghp_test");
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain("🔄 Building");

    await notifier.notify(project, deployment("feature"), "ready", links, log);
    const success = gh.calls.filter((c) => c.path.includes("/statuses/")).at(-1)!;
    expect(success.body).toMatchObject({ state: "success", target_url: links.preview });
    expect(gh.comments).toHaveLength(1); // edited in place, not a second comment
    expect(gh.comments[0]!.body).toContain("✅ Ready");
    expect(gh.comments[0]!.body).toContain(`[Visit Preview](${links.preview})`);
    expect(gh.comments[0]!.body).toContain("`a1b2c3d`");
    expect(logs).toContain("GitHub: updated preview comment on pull request #7");
  });

  it("reports failures as a failing status linking to the logs", async () => {
    await notifier.notify(project, deployment("feature"), "error", links, log);
    expect(gh.calls[0]!.body).toMatchObject({ state: "failure", target_url: links.inspect });
    expect(gh.comments[0]!.body).toContain("❌ Failed");
  });

  it("only sets a status when the branch has no open pull request", async () => {
    await notifier.notify(project, deployment("main"), "ready", links, log);
    expect(gh.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(gh.comments).toHaveLength(0);
  });

  it("logs GitHub errors instead of throwing", async () => {
    gh.failStatuses(true);
    await expect(notifier.notify(project, deployment("feature"), "ready", links, log)).resolves.toBeUndefined();
    expect(logs[0]).toMatch(/403 Resource not accessible.*check the token/);
  });

  it("does nothing without a token, for non-GitHub repos, or without a commit", async () => {
    await new GitHubNotifier({ token: "", apiUrl: "http://unused" }).notify(project, deployment("feature"), "ready", links, log);
    await notifier.notify({ ...project, repoUrl: "file:///tmp/repo" }, deployment("feature"), "ready", links, log);
    await notifier.notify(project, { ...deployment("feature"), commitSha: null }, "ready", links, log);
    expect(gh.calls).toHaveLength(0);
  });
});

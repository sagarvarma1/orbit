import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { serializeDeployment } from "../context.js";
import { verifyGithubSignature } from "../services/git-sync.js";

interface GithubPullRequestPayload {
  action?: string;
  pull_request?: { head?: { ref?: string; repo?: { full_name?: string } | null } };
  repository?: { full_name?: string };
}

interface GithubPushPayload {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string; clone_url?: string };
  head_commit?: { message?: string; author?: { name?: string } } | null;
}

const ZERO_SHA = /^0{40}$/;

export function webhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The signature covers the exact bytes GitHub sent, so this route parses JSON itself.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.post("/api/webhooks/github", async (req, reply) => {
      if (!ctx.config.githubWebhookSecret) {
        return reply.code(503).send({ error: "GITHUB_WEBHOOK_SECRET is not configured" });
      }
      const raw = req.body as Buffer;
      const signature = req.headers["x-hub-signature-256"];
      if (!verifyGithubSignature(ctx.config.githubWebhookSecret, raw, typeof signature === "string" ? signature : undefined)) {
        return reply.code(401).send({ error: "Invalid signature" });
      }

      const event = req.headers["x-github-event"];
      if (event === "ping") return { ok: true, message: "pong" };
      if (event !== "push" && event !== "pull_request") return { ok: true, ignored: `event "${String(event)}"` };

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "Body is not JSON (set the webhook content type to application/json)" });
      }

      if (event === "pull_request") {
        // The branch was usually pushed (and deployed) before the PR existed: comment with what's there.
        const pr = parsed as GithubPullRequestPayload;
        if (pr.action !== "opened" && pr.action !== "reopened") return { ok: true, ignored: `pull_request ${pr.action}` };
        const branch = pr.pull_request?.head?.ref;
        const repo = pr.repository?.full_name;
        if (!branch || !repo || pr.pull_request?.head?.repo?.full_name !== repo)
          return { ok: true, ignored: "fork or missing head" };
        const projects = ctx.git.projectsForRepo(repo);
        await Promise.all(projects.map((p) => ctx.deployments.reportPullRequest(p, branch)));
        return { ok: true, projects: projects.map((p) => p.name) };
      }

      const payload = parsed as GithubPushPayload;
      if (!payload.ref?.startsWith("refs/heads/")) return { ok: true, ignored: "not a branch push" };
      if (payload.deleted || !payload.after || ZERO_SHA.test(payload.after)) return { ok: true, ignored: "branch deleted" };
      const repo = payload.repository?.full_name ?? payload.repository?.clone_url;
      if (!repo) return reply.code(400).send({ error: "Missing repository" });

      const deployments = ctx.git.handlePush({
        repo,
        branch: payload.ref.slice("refs/heads/".length),
        sha: payload.after,
        message: payload.head_commit?.message?.split("\n")[0] ?? null,
        author: payload.head_commit?.author?.name ?? null,
        trigger: "webhook",
      });
      reply.code(deployments.length ? 202 : 200);
      return { ok: true, deployments: deployments.map((d) => serializeDeployment(ctx, d)) };
    });
  });
}

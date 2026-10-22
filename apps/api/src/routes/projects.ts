import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, requireProject, serializeDeployment, serializeProject } from "../context.js";
import { PRESETS, type FrameworkId, normalizeRelative } from "../build/detect.js";
import { lsRemote, parseRepoUrl } from "../build/git.js";
import type { Project } from "../db/repo.js";
import { BadRequestError, ConflictError } from "../lib/errors.js";
import { isValidProjectName, newId, slugify } from "../lib/ids.js";
import { publicUrl } from "../lib/urls.js";

const frameworkIds = Object.keys(PRESETS) as [FrameworkId, ...FrameworkId[]];
const envTarget = z.enum(["production", "preview"]);
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const envVarInput = z.object({
  key: z.string().regex(ENV_KEY_RE, "Env var names must be letters, digits and underscores"),
  value: z.string().max(64 * 1024),
  targets: z.array(envTarget).min(1).default(["production", "preview"]),
});

/** null = use the framework default; "" = skip the step. */
const optionalCommand = z.string().max(1000).nullable().optional();
const relativeDir = z
  .string()
  .max(200)
  .transform((v, ctx) => {
    try {
      return normalizeRelative(v || ".");
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
  });

const buildSettingsInput = {
  framework: z.enum(frameworkIds).nullable().optional(),
  installCommand: optionalCommand,
  buildCommand: optionalCommand,
  outputDirectory: relativeDir.nullable().optional(),
  rootDirectory: relativeDir.optional(),
};

const createProjectInput = z.object({
  repoUrl: z.string().min(1),
  name: z.string().optional(),
  branch: z.string().optional(),
  ...buildSettingsInput,
  env: z.array(envVarInput).default([]),
});

const updateProjectInput = z.object({ productionBranch: z.string().min(1).optional(), ...buildSettingsInput });

export function projectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/projects", async () => ({ projects: ctx.repo.listProjects().map((p) => serializeProject(ctx, p)) }));

  app.post("/api/projects", async (req, reply) => {
    const input = createProjectInput.parse(req.body);
    const repoRef = parseRepoUrl(input.repoUrl, ctx.config.allowLocalRepos);
    const remote = await lsRemote(repoRef.url, await ctx.githubApp.tokenFor(repoRef.url)).catch(() => {
      throw new BadRequestError(
        "Could not reach that repository. If it's private, install the Orbit GitHub App on it (Settings → GitHub).",
      );
    });
    const branch = input.branch || remote.defaultBranch;
    if (!remote.branches.some((b) => b.name === branch)) throw new BadRequestError(`Branch "${branch}" does not exist`);

    const name = input.name ? input.name.toLowerCase() : slugify(path.basename(repoRef.url).replace(/\.git$/, ""));
    if (!isValidProjectName(name)) {
      throw new BadRequestError(
        "Project names must be lowercase letters, digits and dashes (max 50), and can't start with dpl- or contain -git-",
      );
    }
    if (ctx.repo.getProject(name)) throw new ConflictError(`A project named "${name}" already exists`);

    const now = Date.now();
    const project: Project = {
      id: newId("prj"),
      name,
      repoUrl: repoRef.url,
      productionBranch: branch,
      framework: input.framework ?? null,
      installCommand: input.installCommand ?? null,
      buildCommand: input.buildCommand ?? null,
      outputDirectory: input.outputDirectory ?? null,
      rootDirectory: input.rootDirectory ?? ".",
      autoPromotePaused: false,
      createdAt: now,
      updatedAt: now,
    };
    ctx.repo.insertProject(project);
    for (const v of input.env) ctx.repo.upsertEnv(project.id, v.key, v.value, v.targets);
    for (const b of remote.branches) ctx.repo.setBranchHead(project.id, b.name, b.sha);

    const head = remote.branches.find((b) => b.name === branch)!;
    const deployment = ctx.deployments.create(ctx.repo.getProject(project.id)!, {
      branch,
      ref: branch,
      trigger: "import",
      commit: { sha: head.sha },
    });
    reply.code(201);
    return { project: serializeProject(ctx, ctx.repo.getProject(project.id)!), deployment: serializeDeployment(ctx, deployment) };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const project = requireProject(ctx, req.params.id);
    const aliases = ctx.repo.listAliases(project.id).map((a) => ({ ...a, url: publicUrl(ctx.config, a.hostname) }));
    return { project: serializeProject(ctx, project), aliases, productionHistory: ctx.repo.productionHistory(project.id) };
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const project = requireProject(ctx, req.params.id);
    const input = updateProjectInput.parse(req.body);
    ctx.repo.updateProject(project.id, input);
    return { project: serializeProject(ctx, requireProject(ctx, project.id)) };
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const project = requireProject(ctx, req.params.id);
    const deployments = ctx.repo.listDeployments(project.id, 10_000);
    for (const d of deployments) if (d.status === "queued" || d.status === "building") ctx.deployments.queue.cancel(d.id);
    ctx.repo.deleteProject(project.id);
    fs.rmSync(path.join(ctx.config.cacheDir, project.id), { recursive: true, force: true });
    for (const d of deployments) {
      fs.rmSync(path.join(ctx.config.artifactsDir, d.id), { recursive: true, force: true });
      ctx.logs.remove(d.id);
    }
    return { ok: true };
  });

  // ------------------------------------------------------------- deployments

  app.get<{ Params: { id: string } }>("/api/projects/:id/deployments", async (req) => {
    const project = requireProject(ctx, req.params.id);
    const productionId = ctx.repo.productionDeploymentId(project.id);
    return { deployments: ctx.repo.listDeployments(project.id).map((d) => serializeDeployment(ctx, d, productionId)) };
  });

  /** Deploy the latest commit of a branch (defaults to the production branch). */
  app.post<{ Params: { id: string } }>("/api/projects/:id/deployments", async (req, reply) => {
    const project = requireProject(ctx, req.params.id);
    const { branch = project.productionBranch } = z.object({ branch: z.string().min(1).optional() }).parse(req.body ?? {});
    const deployment = ctx.deployments.create(project, { branch, trigger: "manual" });
    reply.code(201);
    return { deployment: serializeDeployment(ctx, deployment) };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/rollback", async (req) => {
    const project = requireProject(ctx, req.params.id);
    const { deploymentId } = z.object({ deploymentId: z.string().optional() }).parse(req.body ?? {});
    const target = ctx.deployments.rollback(project, deploymentId);
    return { deployment: serializeDeployment(ctx, ctx.repo.getDeployment(target.id)!) };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/branches", async (req) => {
    const project = requireProject(ctx, req.params.id);
    const remote = await lsRemote(project.repoUrl, await ctx.githubApp.tokenFor(project.repoUrl));
    return remote;
  });

  // ---------------------------------------------------------------- env vars

  app.get<{ Params: { id: string } }>("/api/projects/:id/env", async (req) => {
    const project = requireProject(ctx, req.params.id);
    return { env: ctx.repo.listEnv(project.id) };
  });

  app.put<{ Params: { id: string; key: string } }>("/api/projects/:id/env/:key", async (req) => {
    const project = requireProject(ctx, req.params.id);
    const input = envVarInput.parse({ ...(req.body as object), key: req.params.key });
    ctx.repo.upsertEnv(project.id, input.key, input.value, input.targets);
    return { env: ctx.repo.listEnv(project.id) };
  });

  app.delete<{ Params: { id: string; key: string } }>("/api/projects/:id/env/:key", async (req) => {
    const project = requireProject(ctx, req.params.id);
    ctx.repo.deleteEnv(project.id, req.params.key);
    return { env: ctx.repo.listEnv(project.id) };
  });
}

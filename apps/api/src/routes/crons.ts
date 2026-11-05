import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, requireProject } from "../context.js";

export function cronRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** The production deployment's cron jobs and the project's recent runs. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/crons", async (req) => {
    const project = requireProject(ctx, req.params.id, req.user);
    const { deploymentId, jobs } = ctx.crons.jobs(project);
    return { enabled: project.cronsEnabled, deploymentId, jobs, runs: ctx.repo.listCronRuns(project.id, 50) };
  });

  /** Runs a job now, like "Run" in Vercel's dashboard. Waits for the response. */
  app.post<{ Params: { id: string } }>("/api/projects/:id/crons/run", async (req) => {
    const project = requireProject(ctx, req.params.id, req.user);
    const job = z.object({ path: z.string().min(1), schedule: z.string().min(1) }).parse(req.body);
    return { run: await ctx.crons.runNow(project, job) };
  });
}

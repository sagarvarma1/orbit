import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, requireDeployment, serializeDeployment } from "../context.js";
import type { LogEvent } from "../build/logs.js";

export function deploymentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { id: string } }>("/api/deployments/:id", async (req) => {
    const deployment = requireDeployment(ctx, req.params.id);
    const project = ctx.repo.getProject(deployment.projectId);
    return { deployment: serializeDeployment(ctx, deployment), project: project ? { id: project.id, name: project.name } : null };
  });

  app.get<{ Params: { id: string } }>("/api/deployments/:id/logs", async (req) => {
    requireDeployment(ctx, req.params.id);
    return { lines: ctx.logs.read(req.params.id) };
  });

  /**
   * Server-Sent Events: replays persisted lines, then tails the live build. Honors
   * Last-Event-ID so EventSource reconnects resume without duplicates.
   */
  app.get<{ Params: { id: string } }>("/api/deployments/:id/logs/stream", async (req, reply) => {
    const deployment = requireDeployment(ctx, req.params.id);
    const lastEventId = Number.parseInt(String(req.headers["last-event-id"] ?? ""), 10);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      // reply.hijack() skips the CORS plugin, so mirror its policy: only the dashboard's origin.
      ...(req.headers.origin === new URL(ctx.config.dashboardUrl).origin
        ? { "access-control-allow-origin": req.headers.origin, "access-control-allow-credentials": "true" }
        : {}),
    });
    res.write("retry: 2000\n\n");

    let closed = false;
    const send = (event: LogEvent) => {
      if (closed) return;
      if (event.type === "line") {
        res.write(`id: ${event.line.seq}\nevent: line\ndata: ${JSON.stringify(event.line)}\n\n`);
      } else {
        res.write(`event: end\ndata: ${JSON.stringify({ status: event.status })}\n\n`);
        finish();
      }
    };
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    let unsubscribe = () => {};
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    req.raw.on("close", finish);

    // Everything below is synchronous, so the status can't change between check and subscribe.
    const current = requireDeployment(ctx, deployment.id);
    const pending = current.status === "queued" || current.status === "building";
    unsubscribe = ctx.logs.follow(deployment.id, send, Number.isNaN(lastEventId) ? -1 : lastEventId, pending);
    if (!pending) send({ type: "end", status: current.status });
  });

  app.post<{ Params: { id: string } }>("/api/deployments/:id/cancel", async (req) => ({
    deployment: serializeDeployment(ctx, ctx.deployments.cancel(req.params.id)),
  }));

  app.post<{ Params: { id: string } }>("/api/deployments/:id/promote", async (req) => ({
    deployment: serializeDeployment(ctx, ctx.deployments.promote(req.params.id)),
  }));

  app.post<{ Params: { id: string } }>("/api/deployments/:id/redeploy", async (req, reply) => {
    const { useCache } = z.object({ useCache: z.boolean().optional() }).parse(req.body ?? {});
    const deployment = ctx.deployments.redeploy(requireDeployment(ctx, req.params.id), { useCache });
    reply.code(201);
    return { deployment: serializeDeployment(ctx, deployment) };
  });
}

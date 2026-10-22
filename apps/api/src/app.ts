import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { ZodError } from "zod";
import type { AppContext } from "./context.js";
import { PRESETS } from "./build/detect.js";
import { HttpError } from "./lib/errors.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { inspectRoutes } from "./routes/inspect.js";
import { projectRoutes } from "./routes/projects.js";
import { webhookRoutes } from "./routes/webhooks.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const pretty = process.env.NODE_ENV !== "production";
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Human-readable logs in dev; JSON lines in production.
      ...(pretty
        ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } } }
        : {}),
    },
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return reply.code(400).send({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request" });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.get("/api/health", async () => ({ ok: true }));

  /** Everything the dashboard needs to render URLs and status. */
  app.get("/api/config", async () => ({
    rootDomain: ctx.config.rootDomain,
    protocol: ctx.config.publicProtocol,
    edgePort: ctx.config.publicEdgePort,
    builder: ctx.deployments.builderDescription,
    queue: ctx.deployments.queue.stats(),
    webhookConfigured: Boolean(ctx.config.githubWebhookSecret),
    githubConfigured: Boolean(ctx.config.githubToken),
    buildCache: ctx.config.buildCache,
    gitPollIntervalSeconds: ctx.config.gitPollIntervalSeconds,
    presets: Object.values(PRESETS),
  }));

  projectRoutes(app, ctx);
  deploymentRoutes(app, ctx);
  inspectRoutes(app, ctx);
  webhookRoutes(app, ctx);
  return app;
}
